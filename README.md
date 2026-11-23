# SalonBook Server

REST API for SalonBook, built with Express and MongoDB. It verifies JWTs issued by the Next.js app, enforces role-based access.

## Live API
https://salonbook-b14-a09-server.vercel.app/

## Repositories
- Client:
- Server: 

## Important Features
- JWT verification middleware (jose + Better Auth JWKS) with server-side role and block checks
- Services, appointments, users, and transactions REST APIs
- Admin-only routes for managing services, appointments, and users
- Stripe Checkout session creation and verified webhook that marks appointments paid
- Duplicate booking and inactive-service protection

## Technology Stack
Node.js, Express, MongoDB, jwt(jose), Stripe

## Installation
```bash
git clone 
cd
npm install
```

## Run Locally
1. Copy `.env.example` to `.env` and fill in the values.
2. Make sure the client app is running, since the server reads its JWKS endpoint.
3. Run:
```bash
npm run dev

```
