# Cross-Functional Claims & Customer Management System

A production-ready NestJS backend application designed for managing customers, claims, and audit logs. Built with TypeScript, Prisma ORM, and robust enterprise-grade middleware for request tracking and correlation.

## Features

- **Robust Request Tracking**: Automatically injects and propagates `X-Request-Id` and `X-Correlation-Id` headers across all incoming and outgoing requests for seamless observability and log aggregation.
- **Prisma ORM Integration**: High-performance database access with automated connection lifecycle management and NestJS shutdown hooks.
- **Strict Input Validation**: Global validation pipes configured to whitelist, transform, and reject non-whitelisted properties automatically.
- **Audit Logging**: Built-in audit module to track critical state changes and user actions across the system.
- **Modular Architecture**: Clean separation of concerns with dedicated modules for `Customers`, `Claims`, `Audit`, and `Prisma`.
- **CORS Configured**: Pre-configured Cross-Origin Resource Sharing (CORS) supporting custom headers (`X-Request-Id`, `X-Correlation-Id`).

---

## Tech Stack

- **Framework**: [NestJS](https://nestjs.com/) (v10+)
- **Language**: [TypeScript](https://www.typescriptlang.org/)
- **Database ORM**: [Prisma](https://www.prisma.io/)
- **Validation**: `class-validator` & `class-transformer`

---

## Getting Started

### Prerequisites

Ensure you have the following installed on your local machine:
- **Node.js** (v18 or higher recommended)
- **npm** or **yarn** / **pnpm**
- A running database instance supported by Prisma (e.g., PostgreSQL, MySQL, SQLite)

### Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd <repository-directory>
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

### Configuration

Create a `.env` file in the root directory of the project and configure your environment variables:

```env
# Server Configuration
PORT=3000

# Database Connection URL (Example for PostgreSQL)
DATABASE_URL="postgresql://user:password@localhost:5432/dbname?schema=public"
```

### Database Setup

1. Generate the Prisma client:
   ```bash
   npx prisma generate
   ```

2. Run database migrations to set up your schema:
   ```bash
   npx prisma migrate dev --name init
   ```

---

## Running the Application

```bash
# Development mode
npm run start:dev

# Production mode
npm run build
npm run start:prod
```

Once started, the application will be running at `http://localhost:3000` (or the port specified in your `.env` file).

---

## Architecture & Project Structure

The project follows a modular NestJS architecture:

```text
src/
├── audit/                  # Audit logging module
├── claims/                 # Claims management module
├── common/                 # Shared middlewares, guards, and interceptors
│   ├── correlation-id.middleware.ts
│   └── request-id.middleware.ts
├── customers/              # Customer management module
├── prisma/                 # Prisma module and service configuration
├── app.module.ts           # Main application module
├── main.ts                 # Application bootstrap entrypoint
└── prisma.service.ts       # Prisma client lifecycle management
```

### Key Components

- **`PrismaService`**: Extends `PrismaClient` and hooks into NestJS's `OnModuleInit` and `OnModuleDestroy` lifecycles to ensure clean database connections and disconnections.
- **`RequestIdMiddleware` & `CorrelationIdMiddleware`**: Applied globally to all routes. They ensure every request is tagged with unique tracking identifiers, which are returned in the response headers and can be used for distributed tracing.
- **Global Validation Pipe**: Configured in `main.ts` to enforce strict DTO validation:
  - `whitelist: true` strips non-decorated properties.
  - `forbidNonWhitelisted: true` throws an error if unrecognized properties are sent.
  - `transform: true` automatically converts payloads to their typed DTO instances.

---

## API Observability Headers

Every API response includes the following headers for tracing and debugging:

| Header | Description |
|--------|-------------|
| `X-Request-Id` | A unique UUID generated for each individual HTTP request. |
| `X-Correlation-Id` | A tracking ID that persists across downstream services to correlate related actions. |

---

## License

This project is licensed under the MIT License.