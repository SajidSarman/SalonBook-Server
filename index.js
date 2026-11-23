import express from "express";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import { createRemoteJWKSet, jwtVerify } from "jose";
import Stripe from "stripe";

const app = express();
const port = process.env.PORT || 5000;
const mongoUri = process.env.MONGODB_URI;
const authBaseUrl = (
  process.env.BETTER_AUTH_URL ?? "http://localhost:3000"
).replace(/\/+$/, "");
const jwtIssuer = process.env.JWT_ISSUER ?? authBaseUrl;
const jwtAudience = process.env.JWT_AUDIENCE ?? "salonbook-api";

if (!mongoUri) {
  throw new Error("MONGODB_URI is not set");
}

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY is not set");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.use(express.json());

const client = new MongoClient(mongoUri);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (error) {
    console.error("Could not connect to MongoDB:", error);
    throw error;
  }
}

const connectedClient = await connectToMongoDB();
const database = connectedClient.db("SalonBook_DB");
const users = database.collection("user");
// const services = database.collection("services");
const serviceCollection = database.collection("services");
const appointments = database.collection("appointments");
const transactions = database.collection("transactions");
const appointmentTimeSlots = [
  "09:00",
  "10:00",
  "11:00",
  "12:00",
  "13:00",
  "14:00",
  "15:00",
  "16:00",
  "17:00",
];

await appointments.createIndex(
  { appointmentDate: 1, timeSlot: 1 },
  {
    unique: true,
    partialFilterExpression: { slotActive: true },
    name: "unique-active-appointment-slot",
  }
);

await transactions.createIndex(
  { stripeSessionId: 1 },
  { unique: true }
);

// Public keys published by Better Auth. The Next.js server mints every token;
// this API only verifies signatures and never sees the session cookie or the
// signing secret.
const jwks = createRemoteJWKSet(new URL(`${authBaseUrl}/api/auth/jwks`));

function userIdFilter(id) {
  return ObjectId.isValid(id) ? { $in: [id, new ObjectId(id)] } : id;
}

/**
 * Verifies `Authorization: Bearer <jwt>` and resolves the caller into
 * `req.auth = { id, name, email, role }`.
 *
 * The token proves the identity, but the database stays the source of truth
 * for role and blocked status, so a demotion or block applies immediately
 * instead of waiting for the token to expire.
 */
async function verifyJWT(req, res, next) {
  const [scheme, token] = (req.headers.authorization ?? "").split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ message: "Authentication required." });
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks, {
      issuer: jwtIssuer,
      audience: jwtAudience,
      algorithms: ["EdDSA"],
    }));
  } catch {
    return res.status(401).json({ message: "Invalid or expired token." });
  }

  const subject = typeof payload.sub === "string" ? payload.sub : "";
  const tokenRole =
    payload.role === "admin"
      ? "admin"
      : payload.role === "service"
        ? "service"
        : "customer";

  // Trusted server-to-server caller (for example the Stripe webhook). It has
  // no user row to reconcile and is restricted to the transaction endpoint.
  if (tokenRole === "service") {
    req.auth = { id: subject, name: "", email: "", role: "service" };
    return next();
  }

  if (!subject) {
    return res.status(401).json({ message: "Invalid or expired token." });
  }

  try {
    const user = await users.findOne(
      { _id: userIdFilter(subject) },
      { projection: { name: 1, email: 1, role: 1, isBlocked: 1 } }
    );

    if (!user || user.isBlocked === true) {
      return res.status(403).json({ message: "Account is blocked." });
    }

    req.auth = {
      id: subject,
      name: typeof user.name === "string" ? user.name : "",
      email: typeof user.email === "string" ? user.email : "",
      role: user.role === "admin" ? "admin" : "customer",
    };

    return next();
  } catch (error) {
    console.error("Failed to load the signed-in user:", error);
    return res
      .status(500)
      .json({ message: "Could not verify the signed-in user." });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return res
        .status(403)
        .json({ message: "You do not have access to this resource." });
    }

    next();
  };
}

const adminOnly = [verifyJWT, requireRole("admin")];
const customerOnly = [verifyJWT, requireRole("customer")];
const customerOrAdmin = [verifyJWT, requireRole("customer", "admin")];
const serviceOnly = [verifyJWT, requireRole("service")];

app.get("/", (_req, res) => {
  res.send({ message: "Server is running fine!" });
});

// Admin user management.
app.get("/admin/users", ...adminOnly, async (_req, res) => {
  try {
    const result = await users
      .find({})
      .project({
        name: 1,
        email: 1,
        image: 1,
        role: 1,
        isBlocked: 1,
      })
      .sort({ name: 1 })
      .toArray();

    res.json(
      result.map((user) => ({
        id: user._id.toString(),
        name: typeof user.name === "string" ? user.name : "",
        email: typeof user.email === "string" ? user.email : "",
        image: typeof user.image === "string" ? user.image : null,
        role: user.role === "admin" ? "admin" : "customer",
        isBlocked: user.isBlocked === true,
      }))
    );
  } catch (error) {
    console.error("Failed to fetch users:", error);
    res.status(500).json({ message: "Failed to fetch users." });
  }
});

app.patch(
  "/admin/users/:id",
  ...adminOnly,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { isBlocked } = req.body ?? {};

      if (!id || typeof isBlocked !== "boolean") {
        return res.status(400).json({ message: "Invalid user update." });
      }

      const userIdFilter = ObjectId.isValid(id)
        ? { $or: [{ _id: id }, { _id: new ObjectId(id) }] }
        : { _id: id };
      const result = await users.updateOne(
        { $and: [userIdFilter, { role: { $ne: "admin" } }] },
        { $set: { isBlocked } }
      );

      if (result.matchedCount !== 1) {
        return res.status(404).json({ message: "Customer user not found." });
      }

      res.json({ id, isBlocked });
    } catch (error) {
      console.error("Failed to update user:", error);
      res.status(500).json({ message: "Failed to update user." });
    }
  }
);

app.get("/admin/overview", ...adminOnly, async (_req, res) => {
  try {
    const [
      totalCustomers,
      activeServices,
      totalAppointments,
      pendingAppointments,
      confirmedAppointments,
      successfulPayments,
    ] = await Promise.all([
      users.countDocuments({ role: { $ne: "admin" } }),
      serviceCollection.countDocuments({ status: "active" }),
      appointments.countDocuments(),
      appointments.countDocuments({ status: "Pending" }),
      appointments.countDocuments({ status: "Confirmed" }),
      transactions.countDocuments({ status: "paid" }),
    ]);

    res.json({
      totalCustomers,
      activeServices,
      totalAppointments,
      pendingAppointments,
      confirmedAppointments,
      successfulPayments,
    });
  } catch (error) {
    console.error("Failed to fetch admin overview:", error);
    res.status(500).json({ message: "Failed to fetch admin overview." });
  }
});

app.get("/admin/services", ...adminOnly, async (_req, res) => {
  try {
    const result = await serviceCollection
      .find({})
      .sort({ _id: -1 })
      .toArray();
    res.json(result);
  } catch (error) {
    console.error("Failed to fetch admin services:", error);
    res.status(500).json({ message: "Failed to fetch services." });
  }
});

app.post("/admin/services", ...adminOnly, async (req, res) => {
  try {
    const { serviceName, category, description, price, duration, status } =
      req.body ?? {};

    if (
      typeof serviceName !== "string" ||
      !serviceName.trim() ||
      typeof category !== "string" ||
      !category.trim() ||
      typeof description !== "string" ||
      !description.trim() ||
      typeof price !== "number" ||
      !Number.isFinite(price) ||
      price <= 0 ||
      typeof duration !== "number" ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      (status !== undefined && status !== "active" && status !== "inactive")
    ) {
      return res.status(400).json({ message: "Invalid service details." });
    }

    const service = {
      serviceName: serviceName.trim(),
      category: category.trim(),
      description: description.trim(),
      price,
      duration,
      image: null,
      status: status ?? "active",
      createdAt: new Date(),
    };
    const result = await serviceCollection.insertOne(service);
    res.status(201).json({ ...service, _id: result.insertedId.toString() });
  } catch (error) {
    console.error("Failed to create service:", error);
    res.status(500).json({ message: "Failed to create service." });
  }
});

app.patch("/admin/services/:id", ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { serviceName, category, description, price, duration, status } =
      req.body ?? {};

    if (
      !ObjectId.isValid(id) ||
      typeof serviceName !== "string" ||
      !serviceName.trim() ||
      typeof category !== "string" ||
      !category.trim() ||
      typeof description !== "string" ||
      !description.trim() ||
      typeof price !== "number" ||
      !Number.isFinite(price) ||
      price <= 0 ||
      typeof duration !== "number" ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      (status !== "active" && status !== "inactive")
    ) {
      return res.status(400).json({ message: "Invalid service details." });
    }

    const result = await serviceCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          serviceName: serviceName.trim(),
          category: category.trim(),
          description: description.trim(),
          price,
          duration,
          status,
        },
      }
    );

    if (result.matchedCount !== 1) {
      return res.status(404).json({ message: "Service not found." });
    }

    res.json({
      id,
      serviceName,
      category,
      description,
      price,
      duration,
      status,
    });
  } catch (error) {
    console.error("Failed to update service:", error);
    res.status(500).json({ message: "Failed to update service." });
  }
});

app.delete("/admin/services/:id", ...adminOnly, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid service ID." });
    }

    const result = await serviceCollection.deleteOne({
      _id: new ObjectId(req.params.id),
    });
    if (result.deletedCount !== 1) {
      return res.status(404).json({ message: "Service not found." });
    }

    res.json({ id: req.params.id, deleted: true });
  } catch (error) {
    console.error("Failed to delete service:", error);
    res.status(500).json({ message: "Failed to delete service." });
  }
});

// Public: homepage featured services -> GET /top6services
app.get("/top6services", async (req, res) => {
  try {
    const services = await serviceCollection
      .find({ status: "active" })
      .sort({ _id: -1 })
      .limit(6)
      .toArray();

    res.json(services);
  } catch (error) {
    console.error("Failed to fetch featured services:", error);
    res.status(500).json({ message: "Failed to fetch featured services." });
  }
});

// Public: Browse Services page -> GET /services
app.get("/services", async (req, res) => {
  try {
    const services = await serviceCollection
      .find({ status: "active" })
      .sort({ _id: -1 })
      .toArray();

    res.json(services);
  } catch (error) {
    console.error("Failed to fetch services:", error);
    res.status(500).json({ message: "Failed to fetch services." });
  }
});

// Public: Service Details page -> GET /services/:id
app.get("/services/:id", async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: "Service not found." });
    }

    const service = await serviceCollection.findOne({
      _id: new ObjectId(req.params.id),
      status: "active",
    });

    if (!service) {
      return res.status(404).json({ message: "Service not found." });
    }

    res.json(service);
  } catch (error) {
    console.error("Failed to fetch service:", error);
    res.status(500).json({ message: "Failed to fetch service." });
  }
});


app.get("/appointments", ...customerOrAdmin, async (req, res) => {
  try {
    // Admins see every appointment; customers only ever see their own. The
    // filter comes from the verified token, never from the query string.
    const filter =
      req.auth.role === "admin" ? {} : { customerId: req.auth.id };

    const result = await appointments
      .find(filter)
      .sort({ appointmentDate: -1, timeSlot: -1, _id: -1 })
      .toArray();

    const serviceIds = result
      .map(({ serviceId }) =>
        typeof serviceId === "string" && ObjectId.isValid(serviceId)
          ? new ObjectId(serviceId)
          : null
      )
      .filter((id) => id !== null);
    const serviceDocuments =
      serviceIds.length > 0
        ? await serviceCollection
            .find({ _id: { $in: serviceIds } })
            .project({ category: 1, image: 1 })
            .toArray()
        : [];
    const servicesById = new Map(
      serviceDocuments.map((service) => [service._id.toString(), service])
    );

    res.json(
      result.map((appointment) => {
        const service =
          typeof appointment.serviceId === "string"
            ? servicesById.get(appointment.serviceId)
            : undefined;

        return {
          ...appointment,
          serviceCategory:
            typeof appointment.serviceCategory === "string"
              ? appointment.serviceCategory
              : service?.category ?? "",
          serviceImage:
            typeof appointment.serviceImage === "string"
              ? appointment.serviceImage
              : service?.image ?? null,
        };
      })
    );
  } catch (error) {
    console.error("Failed to fetch appointments:", error);
    res.status(500).json({ message: "Failed to fetch appointments." });
  }
});

app.get("/appointments/:id", ...customerOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(404).json({ message: "Appointment not found." });
    }

    // Customers can only read their own appointment; admins can read any.
    const appointment = await appointments.findOne({
      _id: new ObjectId(id),
      ...(req.auth.role === "admin" ? {} : { customerId: req.auth.id }),
    });
    if (!appointment) {
      return res.status(404).json({ message: "Appointment not found." });
    }

    const service =
      typeof appointment.serviceId === "string" &&
      ObjectId.isValid(appointment.serviceId)
        ? await serviceCollection.findOne(
            { _id: new ObjectId(appointment.serviceId) },
            { projection: { category: 1, image: 1 } }
          )
        : null;

    res.json({
      ...appointment,
      serviceCategory:
        typeof appointment.serviceCategory === "string"
          ? appointment.serviceCategory
          : service?.category ?? "",
      serviceImage:
        typeof appointment.serviceImage === "string"
          ? appointment.serviceImage
          : service?.image ?? null,
    });
  } catch (error) {
    console.error("Failed to fetch appointment:", error);
    res.status(500).json({ message: "Failed to fetch appointment." });
  }
});

app.get("/appointment-slots", async (req, res) => {
  try {
    const { date } = req.query;
    const parsedDate =
      typeof date === "string" ? new Date(`${date}T00:00:00.000Z`) : null;

    if (
      typeof date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !parsedDate ||
      !Number.isFinite(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== date ||
      date < new Date().toISOString().slice(0, 10)
    ) {
      return res.status(400).json({ message: "Invalid appointment date." });
    }

    const bookedSlots = await appointments
      .find({ appointmentDate: date, slotActive: true })
      .project({ timeSlot: 1, _id: 0 })
      .toArray();
    const unavailable = new Set(bookedSlots.map(({ timeSlot }) => timeSlot));

    res.json(appointmentTimeSlots.filter((slot) => !unavailable.has(slot)));
  } catch (error) {
    console.error("Failed to fetch available time slots:", error);
    res.status(500).json({ message: "Failed to fetch available time slots." });
  }
});

app.post("/appointments", ...customerOnly, async (req, res) => {
  try {
    const { serviceId, appointmentDate, timeSlot, additionalMessage } =
      req.body ?? {};
    const parsedAppointmentDate =
      typeof appointmentDate === "string"
        ? new Date(`${appointmentDate}T00:00:00.000Z`)
        : null;

    if (
      typeof serviceId !== "string" ||
      !ObjectId.isValid(serviceId) ||
      typeof appointmentDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(appointmentDate) ||
      !parsedAppointmentDate ||
      !Number.isFinite(parsedAppointmentDate.getTime()) ||
      parsedAppointmentDate.toISOString().slice(0, 10) !== appointmentDate ||
      appointmentDate < new Date().toISOString().slice(0, 10) ||
      typeof timeSlot !== "string" ||
      !appointmentTimeSlots.includes(timeSlot) ||
      (additionalMessage !== undefined &&
        (typeof additionalMessage !== "string" ||
          additionalMessage.length > 1000))
    ) {
      return res.status(400).json({ message: "Invalid appointment request." });
    }

    const service = await serviceCollection.findOne({
      _id: new ObjectId(serviceId),
      status: "active",
    });

    if (!service) {
      return res.status(404).json({ message: "Service is unavailable." });
    }

    try {
      const result = await appointments.insertOne({
        serviceId: service._id.toString(),
        serviceName: service.serviceName,
        serviceCategory: service.category ?? "",
        serviceImage: service.image ?? null,
        customerId: req.auth.id,
        customerName: req.auth.name,
        customerEmail: req.auth.email,
        appointmentDate,
        timeSlot,
        additionalMessage: additionalMessage ?? "",
        status: "Pending",
        servicePrice: service.price,
        paymentStatus: "Unpaid",
        slotActive: true,
        createdAt: new Date(),
      });

      return res.status(201).json({
        id: result.insertedId.toString(),
        status: "Pending",
        paymentStatus: "Unpaid",
        servicePrice: service.price,
      });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === 11000) {
        return res.status(409).json({
          message: "That date and time slot is already booked.",
        });
      }

      throw error;
    }
  } catch (error) {
    console.error("Failed to create appointment:", error);
    res.status(500).json({ message: "Failed to create appointment." });
  }
});

app.patch("/appointments/:id/cancel", ...customerOnly, async (req, res) => {
  try {
    const { id } = req.params;
    // Ownership always comes from the verified token, never the request body.
    const customerId = req.auth.id;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid cancellation request." });
    }

    const appointment = await appointments.findOne({ _id: new ObjectId(id) });
    if (!appointment) {
      return res.status(404).json({ message: "Appointment not found." });
    }
    if (appointment.customerId !== customerId) {
      return res.status(403).json({ message: "You cannot cancel this appointment." });
    }
    if (appointment.status !== "Pending") {
      return res.status(409).json({
        message: "Only pending appointments can be cancelled by customers.",
      });
    }

    const result = await appointments.updateOne(
      { _id: appointment._id, customerId, status: "Pending" },
      {
        $set: {
          status: "Cancelled",
          slotActive: false,
          cancelledAt: new Date(),
        },
      }
    );

    if (result.modifiedCount !== 1) {
      return res.status(409).json({ message: "Appointment is no longer pending." });
    }

    res.json({ id, status: "Cancelled" });
  } catch (error) {
    console.error("Failed to cancel appointment:", error);
    res.status(500).json({ message: "Failed to cancel appointment." });
  }
});

app.patch("/appointments/:id/status", ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (
      !ObjectId.isValid(id) ||
      (status !== "Confirmed" && status !== "Cancelled")
    ) {
      return res.status(400).json({ message: "Invalid appointment status." });
    }

    const allowedCurrentStatuses =
      status === "Confirmed" ? ["Pending"] : ["Pending", "Confirmed"];
    const result = await appointments.updateOne(
      {
        _id: new ObjectId(id),
        status: { $in: allowedCurrentStatuses },
      },
      {
        $set: {
          status,
          slotActive: status === "Confirmed",
          ...(status === "Cancelled" ? { cancelledAt: new Date() } : {}),
        },
      }
    );

    if (result.matchedCount !== 1) {
      return res.status(404).json({
        message: "Appointment not found or cannot be updated.",
      });
    }

    res.json({ id, status });
  } catch (error) {
    console.error("Failed to update appointment:", error);
    res.status(500).json({ message: "Failed to update appointment." });
  }
});

// Called by the verified Stripe webhook in the Next.js app. The Next server
// authenticates with a short-lived service JWT. The caller only supplies a
// Checkout Session id; every value written to the database is read back from
// Stripe, so a forged request cannot fake a payment.
app.post("/transactions", ...serviceOnly, async (req, res) => {
  try {
    const { stripeSessionId, status } = req.body ?? {};

    if (
      typeof stripeSessionId !== "string" ||
      stripeSessionId.length === 0 ||
      (status !== "paid" && status !== "failed")
    ) {
      return res.status(400).json({ message: "Invalid transaction." });
    }

    // Fast path: a paid transaction for this session has already been recorded.
    // Stripe sessions can only be paid once, so reloading the success page (or
    // Stripe retrying the webhook) has nothing new to write and does not need
    // another call to Stripe.
    if (status === "paid") {
      const existing = await transactions.findOne({ stripeSessionId });

      if (existing?.status === "paid") {
        // The transaction insert and the appointment update are not atomic. If
        // the process died in between, heal the appointment on the retry.
        if (
          typeof existing.appointmentId === "string" &&
          ObjectId.isValid(existing.appointmentId) &&
          typeof existing.customerId === "string"
        ) {
          await appointments.updateOne(
            {
              _id: new ObjectId(existing.appointmentId),
              customerId: existing.customerId,
              paymentStatus: { $ne: "Paid" },
            },
            { $set: { paymentStatus: "Paid" } }
          );
        }

        return res.send({
          success: false,
          message: "Payment already verified",
        });
      }
    }

    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(stripeSessionId);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "resource_missing"
      ) {
        return res.status(404).json({ message: "Checkout session not found." });
      }
      throw error;
    }

    const appointmentId =
      session.metadata?.appointmentId ?? session.client_reference_id ?? null;
    const customerId = session.metadata?.customerId ?? null;
    // Checkout finished AND the money was actually captured. `status` alone is
    // not enough: delayed payment methods complete checkout while unpaid.
    const paid =
      session.status === "complete" && session.payment_status === "paid";

    if (
      typeof appointmentId !== "string" ||
      !ObjectId.isValid(appointmentId) ||
      typeof customerId !== "string" ||
      customerId.length === 0
    ) {
      return res.status(409).json({
        message: "Checkout session is missing appointment metadata.",
      });
    }

    // A paid session can never be recorded as failed, and an unpaid session can
    // never be recorded as paid.
    if ((status === "paid") !== paid) {
      return res.status(409).json({
        message: "Checkout session status does not match the transaction.",
      });
    }

    if (
      typeof session.amount_total !== "number" ||
      !Number.isFinite(session.amount_total) ||
      typeof session.currency !== "string" ||
      session.currency.length === 0
    ) {
      return res.status(409).json({
        message: "Checkout session is missing its amount or currency.",
      });
    }

    const appointment = await appointments.findOne({
      _id: new ObjectId(appointmentId),
      customerId,
    });

    if (!appointment) {
      return res.status(404).json({ message: "Appointment not found." });
    }

    if (appointment.status !== "Confirmed") {
      return res.status(409).json({
        message: "Appointment is no longer confirmed.",
      });
    }

    const amount = Number((session.amount_total / 100).toFixed(2));
    const currency = session.currency.toUpperCase();
    // Snapshot of the email the customer paid with, as recorded by Stripe.
    const customerEmail =
      typeof session.customer_details?.email === "string"
        ? session.customer_details.email
        : null;

    try {
      await transactions.updateOne(
        { stripeSessionId: session.id },
        status === "paid"
          ? {
              $set: {
                appointmentId,
                customerId,
                customerEmail,
                amount,
                currency,
                status,
              },
              $setOnInsert: { createdAt: new Date() },
            }
          : {
              $setOnInsert: {
                appointmentId,
                customerId,
                customerEmail,
                amount,
                currency,
                status,
                createdAt: new Date(),
              },
            },
        { upsert: true }
      );
    } catch (error) {
      // Concurrent deliveries of the same event can race on the unique index.
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === 11000
        )
      ) {
        throw error;
      }
    }

    if (status === "paid" && appointment.paymentStatus !== "Paid") {
      await appointments.updateOne(
        {
          _id: appointment._id,
          customerId,
          paymentStatus: { $ne: "Paid" },
        },
        { $set: { paymentStatus: "Paid" } }
      );
    }

    res.status(201).json({
      stripeSessionId: session.id,
      appointmentId,
      customerId,
      customerEmail,
      amount,
      currency,
      status,
    });
  } catch (error) {
    console.error("Failed to save transaction:", error);
    res.status(500).json({ message: "Failed to save transaction." });
  }
});

app.get("/transactions", ...adminOnly, async (_req, res) => {
  try {
    const result = await transactions
      .find({})
      .sort({ createdAt: -1, _id: -1 })
      .toArray();

    const customerIds = [
      ...new Set(
        result
          .map((transaction) => transaction.customerId)
          .filter((id) => typeof id === "string" && id.length > 0)
      ),
    ];

    // `customerId` is stored as a string, but a user's `_id` is an ObjectId.
    const customerKeys = customerIds.flatMap((id) =>
      ObjectId.isValid(id) ? [id, new ObjectId(id)] : [id]
    );

    const customers =
      customerKeys.length > 0
        ? await users
            .find(
              { _id: { $in: customerKeys } },
              { projection: { name: 1, email: 1 } }
            )
            .toArray()
        : [];

    const customersById = new Map(
      customers.map((customer) => [
        customer._id.toString(),
        {
          name: typeof customer.name === "string" ? customer.name : "",
          email: typeof customer.email === "string" ? customer.email : "",
        },
      ])
    );

    res.json(
      result.map((transaction) => {
        const customer =
          typeof transaction.customerId === "string"
            ? customersById.get(transaction.customerId)
            : null;

        return {
          ...transaction,
          customerName: customer?.name ?? null,
          // Prefer the email captured at payment time; fall back to the live
          // account for transactions recorded before this field existed.
          customerEmail:
            typeof transaction.customerEmail === "string"
              ? transaction.customerEmail
              : (customer?.email ?? null),
        };
      })
    );
  } catch (error) {
    console.error("Failed to fetch transactions:", error);
    res.status(500).json({ message: "Failed to fetch transactions." });
  }
});

app.use((error, _req, res, _next) => {
  console.error("API request failed:", error);
  res.status(500).json({ message: "Internal server error." });
});

app.listen(port, () => {
  console.log(`SalonBook is running on port ${port}`);
});

export default app;