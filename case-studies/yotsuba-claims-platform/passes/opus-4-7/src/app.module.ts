// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// `AppModule` — the composition root of the Nest application.
//
// Responsibilities:
//
//   1. Import every feature module that contributes routes or providers
//      to the application: `AuthModule`, `ClaimsModule`, `ReservesModule`,
//      `AuditModule`, and `AppiModule`. Each feature module is
//      self-contained — it declares its controllers, services, and DTOs
//      and re-exports only what its siblings need (typically the audit
//      service so cross-module writes share one writer).
//
//   2. Provide the database singleton (`PrismaService`) at the app level
//      so every feature module receives the same client instance and
//      thus shares one connection pool. Re-exporting it keeps feature
//      modules from having to re-declare a provider that is genuinely
//      application-global.
//
//   3. Bind the two ID middlewares — `RequestIdMiddleware` followed by
//      `CorrelationIdMiddleware` — to every inbound route. Order matters:
//      the correlation middleware falls back to `request.request_id`
//      when no inbound `X-Correlation-Id` header is present, so the
//      request id must be stamped first. See `correlation-id.middleware.ts`
//      for the rationale.
//
//   4. Install the global throttler. The brief specifies a 5-req/min/IP
//      ceiling on `/auth/login`; the `AuthController` applies a tighter
//      `@Throttle` on that route, but a sane default protects the rest
//      of the API from runaway clients. `ThrottlerGuard` is registered
//      as an `APP_GUARD` so it runs on every request without per-route
//      ceremony.
//
//   5. Install the global audit interceptor. `AuditInterceptor` writes
//      an `AuditEvent` row for every controller method annotated with
//      `@Audit({ action })`. Registering it via `APP_INTERCEPTOR` keeps
//      audit emission centralised and impossible to forget on a per-
//      controller basis (ADR-002).
//
// Everything bootstrap-level (Helmet, CORS, ValidationPipe, exception
// filter, Swagger, Prisma shutdown hooks) lives in `main.ts`; this file
// is exclusively about wiring the DI graph.
// ─────────────────────────────────────────────────────────────────────────

import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AppiModule } from './appi/appi.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { ClaimsModule } from './claims/claims.module';
import { AuditInterceptor } from './common/audit.interceptor';
import { CorrelationIdMiddleware } from './common/correlation-id.middleware';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { PrismaService } from './prisma.service';
import { ReservesModule } from './reserves/reserves.module';

/**
 * Default throttler ceiling for routes that do not opt into a tighter
 * per-route limit. 120 requests per minute per IP is generous enough
 * for the Adjuster Workbench's polling patterns while still blocking
 * trivial abuse. The `/auth/login` route applies its own stricter
 * `@Throttle(5, 60)` per the brief's NFR.
 */
const DEFAULT_THROTTLE_TTL_SECONDS = 60;
const DEFAULT_THROTTLE_LIMIT = 120;

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        ttl: DEFAULT_THROTTLE_TTL_SECONDS * 1000,
        limit: DEFAULT_THROTTLE_LIMIT,
      },
    ]),
    AuthModule,
    AuditModule,
    ClaimsModule,
    ReservesModule,
    AppiModule,
  ],
  providers: [
    PrismaService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditInterceptor,
    },
  ],
  exports: [PrismaService],
})
export class AppModule implements NestModule {
  /**
   * Bind request-scoped middleware. The order of `.apply()` arguments
   * is the order in which middleware executes per request: request id
   * is stamped first so the correlation-id middleware can fall back to
   * it when no inbound `X-Correlation-Id` header is present.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RequestIdMiddleware, CorrelationIdMiddleware)
      .forRoutes('*');
  }
}