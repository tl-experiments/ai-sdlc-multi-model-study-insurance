# Architecture Documentation

This document provides a detailed overview of the architectural design, patterns, and decisions implemented in the **Cross-Functional Claims & Customer Management System**.

---

## 1. Architectural Overview

The application is built as a **Modular Monolith** using the **NestJS** framework. This design ensures a clean separation of concerns, high maintainability, and clear boundaries between different business domains while keeping deployment and development simple.

### Key Architectural Principles
- **Domain-Driven Modularization**: Each business domain (Customers, Claims, Audit) is encapsulated in its own self-contained module.
- **Layered Architecture**: Within each module, responsibilities are divided into distinct layers:
  - **Controller Layer**: Handles incoming HTTP requests, validates payloads, and returns standardized responses.
  - **Service Layer**: Contains core business logic, orchestrates domain rules, and interacts with the data access layer.
  - **Data Access Layer (Prisma)**: Manages database interactions using Prisma ORM.
- **Dependency Injection**: NestJS's built-in DI container is used to manage component lifecycles and decouple dependencies.
- **Observability First**: Request tracking and correlation are treated as first-class citizens, integrated at the entry point of the application.

---

## 2. System Component & Module Breakdown

```text
                  ┌─────────────────────────────────────────┐
                  │               HTTP Client               │
                  └────────────────────┬────────────────────┘
                                       │
                        [Request & Correlation ID]
                                       ▼
                  ┌─────────────────────────────────────────┐
                  │          Global Middleware              │
                  └────────────────────┬────────────────────┘
                                       │
                                [Validation]
                                       ▼
                  ┌─────────────────────────────────────────┐
                  │               AppModule                 │
                  └──────┬─────────────┬─────────────┬──────┘
                         │             │             │
                         ▼             ▼             ▼
                  ┌───────────┐ ┌───────────┐ ┌───────────┐
                  │ Customers │ │  Claims   │ │   Audit   │
                  │  Module   │ │  Module   │ │  Module   │
                  └─────┬─────┘ └─────┬─────┘ └─────┬─────┘
                        │             │             │
                        └─────────────┼─────────────┘
                                      ▼
                        ┌───────────────────────────┐
                        │       PrismaModule        │
                        └─────────────┬─────────────┘
                                      ▼
                        ┌───────────────────────────┐
                        │     Database (Prisma)     │
                        └───────────────────────────┘
```

### 2.1. Core Modules

#### `AppModule`
The root module of the application. It imports all domain modules (`CustomersModule`, `ClaimsModule`, `AuditModule`) and the utility `PrismaModule`. It is also responsible for registering global middlewares.

#### `CustomersModule`
Manages customer-related data and operations.
- **Responsibilities**: Customer registration, profile management, status updates, and retrieval.
- **Dependencies**: Interacts with `PrismaModule` for persistence and may trigger events or direct calls to the `AuditModule` for tracking changes.

#### `ClaimsModule`
Manages the lifecycle of insurance or reimbursement claims.
- **Responsibilities**: Claim creation, status transitions (e.g., Draft, Submitted, Approved, Rejected), and linking claims to specific customers.
- **Dependencies**: Depends on `CustomersModule` to validate customer existence and `PrismaModule` for data persistence.

#### `AuditModule`
A centralized service for recording system activities and state changes.
- **Responsibilities**: Provides a standardized way to log audit trails for sensitive operations (e.g., customer profile updates, claim status changes).
- **Design**: Designed to be highly decoupled, allowing other modules to inject the `AuditService` to record events without blocking primary business flows.

#### `PrismaModule`
Wraps the Prisma ORM client.
- **Responsibilities**: Provides a singleton instance of `PrismaService` to the entire application.
- **Lifecycle Management**: Hooks into NestJS's `OnModuleInit` and `OnModuleDestroy` to manage database connections cleanly.

---

## 3. Cross-Cutting Concerns

### 3.1. Observability & Distributed Tracing
To facilitate debugging and log aggregation in production environments, the application implements a robust request-tracking mechanism using two custom middlewares:

1. **`RequestIdMiddleware`**:
   - Generates a unique UUID (`X-Request-Id`) for every incoming HTTP request if not already present.
   - Attaches this ID to the request context and injects it into the outgoing response headers.
2. **`CorrelationIdMiddleware`**:
   - Captures or generates a tracking identifier (`X-Correlation-Id`) that persists across downstream services.
   - Ensures that related asynchronous operations or multi-service calls can be grouped together during log analysis.

Both headers are exposed via CORS configuration in `main.ts` to allow client-side applications to read and log them.

### 3.2. Request Validation & Serialization
Data integrity is enforced at the application boundary using NestJS's global `ValidationPipe` combined with `class-validator` and `class-transformer`:

- **Whitelist Filtering (`whitelist: true`)**: Automatically strips any properties from the incoming request payload that do not have validation decorators in the corresponding Data Transfer Object (DTO).
- **Strict Rejection (`forbidNonWhitelisted: true`)**: Throws an immediate `400 Bad Request` error if any unrecognized properties are present in the payload, preventing malicious or malformed payloads.
- **Auto-Transformation (`transform: true`)**: Automatically converts plain JavaScript payload objects into instances of their typed DTO classes, enabling type safety and helper method execution within the application.

### 3.3. Database Connection & Lifecycle Management
The application ensures database connection reliability and prevents resource leaks through proactive lifecycle management:

- **Active Connection**: `PrismaService` establishes a database connection during the module initialization phase (`onModuleInit`).
- **Graceful Shutdown**: The application enables NestJS shutdown hooks (`app.enableShutdownHooks()`) in `main.ts`. When the application receives a termination signal (e.g., `SIGTERM`), it cleanly closes all database connections via `onModuleDestroy` before exiting.

---

## 4. Request Lifecycle & Data Flow

Below is the sequential flow of an HTTP request through the system:

1. **Entry**: The client sends an HTTP request to the server.
2. **Middleware Chain**:
   - `RequestIdMiddleware` executes, assigning and attaching `X-Request-Id`.
   - `CorrelationIdMiddleware` executes, assigning and attaching `X-Correlation-Id`.
3. **Routing & Validation**:
   - The request matches a route handler in a Controller.
   - The global `ValidationPipe` intercepts the request, validating and transforming the payload against the defined DTO.
4. **Business Logic (Service)**:
   - The Controller invokes the corresponding Service method.
   - The Service executes business rules, performs validations, and orchestrates data operations.
5. **Data Access (Prisma)**:
   - The Service calls `PrismaService` to query or mutate the database.
   - If a state change occurs, the Service may call the `AuditService` to write an audit log entry.
6. **Response**:
   - The Controller returns the result.
   - The response headers (`X-Request-Id`, `X-Correlation-Id`) are sent back to the client.