# SalonBook - Server

REST API for SalonBook, built with Express and MongoDB. It verifies JWTs issued by the Next.js app, enforces role-based access.

## Live API
https://salonbook-b14-a09-server.vercel.app/

## Repositories
- Client: https://github.com/SajidSarman/SalonBook

## Important Features
- JWT verification middleware (jose + Better Auth JWKS) with server-side role and block checks
- Services, appointments, users, and transactions REST APIs
- Admin-only routes for managing services, appointments, and users
- Stripe Checkout session creation and verified webhook that marks appointments paid
- Duplicate booking and inactive-service protection

## Technology Stack
Node.js, Express, MongoDB, JWT(jose), Stripe

## Installation
```bash
git clone https://github.com/SajidSarman/SalonBook-Server.git
cd SalonBook-Server
npm install
```

## Run Locally
1. Add `.env` and fill in the values.
2. Make sure the client app is running, since the server reads its JWKS endpoint.
3. Run:
```bash
nodemon index.js
```
The API runs on http://localhost:5000.

## Environment Variables
```
PORT=
MONGODB_URI=
BETTER_AUTH_URL=
JWT_ISSUER=
JWT_AUDIENCE=
STRIPE_SECRET_KEY=
```

