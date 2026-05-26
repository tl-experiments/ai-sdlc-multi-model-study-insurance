import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaService } from './prisma.service';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { CorrelationIdMiddleware } from './common/correlation-id.middleware';
import { GlobalExceptionFilter } from './common/error.filter';
import { AuditInterceptor } from './common/audit.interceptor';
import { AuthModule } from './auth/auth.module';
import { ClaimsModule } from './claims/claims.module';
import { ReservesModule } from './reserves/reserves.module';
import { AuditModule } from './audit/audit.module';
import { AppiModule } from './appi/appi.module';

/**
 * Root application module for the Yotsuba Insurance Claims Processing Platform.
 *
 * Context:
 *   AppModule is the entry point for the NestJS application. It imports all feature modules,
 *   registers global middleware, pipes, filters, and interceptors, and configures cross-cutting
 *   concerns like environment variables, rate limiting, and structured logging.
 *
 * Module structure:
 *   - ConfigModule: loads environment variables from .env
 *   - ThrottlerModule: rate limiting (5 req/min on /auth/login)
 *   - PrismaService: database connection management
 *   - AuthModule: JWT authentication and login
 *   - ClaimsModule: FNOL intake, adjuster workbench, claim lifecycle
 *   - ReservesModule: reserve management, approval workflows, IFRS17 export
 *   - AuditModule: audit log queries (auditor-only)
 *   - AppiModule: APPI data subject rights (data-subject-export, anonymise)
 *
 * Middleware (registered in order):
 *   1. RequestIdMiddleware: generates unique request_id per HTTP request
 *   2. CorrelationIdMiddleware: generates/propagates correlation_id across service boundaries
 *
 * Global filters:
 *   - GlobalExceptionFilter: standardised error responses, no stack traces in API
 *
 * Global interceptors:
 *   - AuditInterceptor: writes AuditEvent records for annotated routes
 *
 * Security:
 *   - Helmet is enabled in main.ts for HTTP security headers
 *   - ValidationPipe is enabled in main.ts for DTO validation
 *   - JwtAuthGuard is applied to protected routes via @UseGuards(JwtAuthGuard)
 *   - RolesGuard is applied to role-protected routes via @Roles(...)
 *   - ThrottlerGuard is applied to /auth/login via @UseGuards(ThrottlerGuard)
 *
 * Environment variables:
 *   - NODE_ENV: 'development' | 'production' (default: 'development')
 *   - PORT: HTTP server port (default: 3000)
 *   - DATABASE_URL: PostgreSQL connection string (required)
 *   - JWT_SECRET: Secret key for JWT signing (required)
 *   - JWT_EXPIRATION: JWT expiration time in seconds (default: 3600)
 *   - ENCRYPTION_KEK: Base64-encoded key encryption key for AES-256-GCM (required)
 *
 * Database:
 *   - PostgreSQL 16+ is required
 *   - Prisma ORM is used for database access
 *   - Schema is defined in prisma/schema.prisma
 *   - Migrations are managed via `npx prisma migrate`
 *
 * Logging:
 *   - Pino is configured for structured logging (configured in individual services)
 *   - request_id and correlation_id are propagated through all logs
 *   - Audit events are logged to the database via AuditInterceptor
 *
 * Rate limiting:
 *   - /auth/login: 5 requests per minute per IP address
 *   - Other endpoints: no rate limiting (can be added per-route via @Throttle)
 *
 * CORS:
 *   - Enabled for all origins in development
 *   - Should be restricted in production via environment variable
 *
 * Swagger/OpenAPI:
 *   - Documentation is available at /docs
 *   - Configured in main.ts
 *   - Includes all endpoints, DTOs, and security schemes
 */
@Module({
  imports: [
    // Load environment variables from .env file.
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // Rate limiting: 5 requests per minute per IP address (default).
    // Applied globally; individual routes can override via @Throttle(limit, ttl).
    ThrottlerModule.forRoot([
      {
        name: 'short',
        ttl: 60000, // 1 minute in milliseconds
        limit: 5, // 5 requests per minute
      },
    ]),

    // Feature modules.
    AuthModule,
    ClaimsModule,
    ReservesModule,
    AuditModule,
    AppiModule,
  ],
  providers: [
    // Database service.
    PrismaService,

    // Global exception filter: standardised error responses.
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },

    // Global audit interceptor: writes AuditEvent records for annotated routes.
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  /**
   * Configure middleware for the application.
   *
   * Middleware is registered in order and applied to all routes.
   * Order matters: RequestIdMiddleware should run first (generates request_id),
   * then CorrelationIdMiddleware (generates/propagates correlation_id).
   *
   * @param consumer - NestJS middleware consumer
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RequestIdMiddleware, CorrelationIdMiddleware)
      .forRoutes('*');
  }
}