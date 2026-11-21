import express from "express";
import "dotenv/config";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";

const app = express();
const port = process.env.PORT || 5000;
const mongoUri = process.env.MONGODB_URI;

if (!mongoUri) {
  throw new Error("MONGODB_URI is not set");
}

app.use(express.json());
app.use(cors());

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

app.get("/", (_req, res) => {
  res.send("TESTING...");
});

// Admin user management. Requests are role-checked by the Next.js API proxy.
app.get("/admin/users", async (_req, res) => {
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

app.patch("/admin/users/:id", async (req, res) => {
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
});

app.get("/admin/overview", async (_req, res) => {
  try {
    const [
      totalCustomers,
      activeServices,
      totalAppointments,
      pendingAppointments,
      confirmedAppointments,
    ] = await Promise.all([
      users.countDocuments({ role: { $ne: "admin" } }),
      serviceCollection.countDocuments({ status: "active" }),
      appointments.countDocuments(),
      appointments.countDocuments({ status: "Pending" }),
      appointments.countDocuments({ status: "Confirmed" }),
    ]);

    res.json({
      totalCustomers,
      activeServices,
      totalAppointments,
      pendingAppointments,
      confirmedAppointments,
      successfulPayments: null,
    });
  } catch (error) {
    console.error("Failed to fetch admin overview:", error);
    res.status(500).json({ message: "Failed to fetch admin overview." });
  }
});

app.get("/admin/services", async (_req, res) => {
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

app.post("/admin/services", async (req, res) => {
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

app.patch("/admin/services/:id", async (req, res) => {
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

app.delete("/admin/services/:id", async (req, res) => {
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


app.get("/appointments", async (req, res) => {
  try {
    const filter =
      typeof req.query.customerId === "string"
        ? { customerId: req.query.customerId }
        : {};

    const result = await appointments
      .find(filter)
      .sort({ appointmentDate: -1, timeSlot: -1, _id: -1 })
      .toArray();

    res.json(result);
  } catch (error) {
    console.error("Failed to fetch appointments:", error);
    res.status(500).json({ message: "Failed to fetch appointments." });
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

app.post("/appointments", async (req, res) => {
  try {
    const { serviceId, appointmentDate, timeSlot, additionalMessage, customer } =
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
          additionalMessage.length > 1000)) ||
      !customer ||
      typeof customer.id !== "string" ||
      typeof customer.name !== "string" ||
      typeof customer.email !== "string"
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
        customerId: customer.id,
        customerName: customer.name,
        customerEmail: customer.email,
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

app.patch("/appointments/:id/cancel", async (req, res) => {
  try {
    const { id } = req.params;
    const { customerId } = req.body;

    if (!ObjectId.isValid(id) || typeof customerId !== "string") {
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

app.patch("/appointments/:id/status", async (req, res) => {
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


app.use((error, _req, res, _next) => {
  console.error("API request failed:", error);
  res.status(500).json({ message: "Internal server error." });
});

app.listen(port, () => {
  console.log(`SalonBook is running on port ${port}`);
});