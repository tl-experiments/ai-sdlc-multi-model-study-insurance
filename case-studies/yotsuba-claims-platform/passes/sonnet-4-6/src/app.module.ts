// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/app.module.ts
//
// Root application module — wires together all feature modules, global
// middleware, configuration, and the Pino logging pipeline.
//
// Per design.md §3 module structure:
//   common/* + prisma.service  (foundation)
//   auth/*
//   audit/*  (interceptor needs this)
//   claims/*  — the spine
//   reserves/*  (depends on claims)
//   appi/*  (data-subject-export needs everything else)
//
// Per brief.md non-functional requirements:
//   - Pino structured logging with request_id + correlation_id
//   - Helmet enabled (in main.ts)
//   - Rate-limit on /auth/login (5 req/min/IP) — ThrottlerModule configured here
//   - Config from .env via @nestjs/config
//   - Global exception filter — registered in main.ts
//   - OpenAPI / Swagger at /docs — set up in main.ts
// =============================================================================

import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { v4 as uuidv4 } from 'uuid';

// ── Common / infrastructure ───────────────────────────────────────────────
import { PrismaService } from './prisma.service';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { CorrelationIdMiddleware } from './common/correlation-id.middleware';

// ── Feature modules ───────────────────────────────────────────────────────
import { AuthModule } from './auth/auth.module';
import { ClaimsModule } from './claims/claims.module';
import { ReservesModule } from './reserves/reserves.module';
import { AuditModule } from './audit/audit.module';
import { AppiModule } from './appi/appi.module';

// ---------------------------------------------------------------------------
// AppModule
// ---------------------------------------------------------------------------

/**
 * AppModule — the root NestJS module.
 *
 * Responsibilities:
 *   1. Configure @nestjs/config (reads .env / process.env; validates required
 *      variables so the application fails fast if misconfigured).
 *   2. Configure nestjs-pino as the global structured logger.  All log lines
 *      carry `request_id` and `correlation_id` which are injected by the
 *      middleware pipeline below.
 *   3. Configure @nestjs/throttler for rate-limiting.  The rate-limit on
 *      /auth/login (5 req/min/IP) is enforced in AuthModule via the
 *      ThrottlerGuard applied to that specific route.
 *   4. Register PrismaService as a global provider so every feature module
 *      can inject it without importing a PrismaModule.
 *   5. Register all feature modules in dependency order.
 *   6. Apply RequestIdMiddleware → CorrelationIdMiddleware to every route so
 *      every request has both `request_id` and `correlation_id` set before
 *      any controller or interceptor runs.
 */
@Module({
  imports: [
    // ── Configuration ───────────────────────────────────────────────────
    // isGlobal: true means ConfigService can be injected anywhere without
    // importing ConfigModule in every feature module.
    // expandVariables: true supports ${VAR} interpolation in .env files.
    ConfigModule.forRoot({
      isGlobal: true,
      expandVariables: true,
      // .env file is optional; in CI/CD, variables come from the environment
      envFilePath: ['.env'],
    }),

    // ── Structured logging (Pino) ────────────────────────────────────────
    // pinoHttp is configured to:
    //   - Attach request_id and correlation_id to every HTTP log line
    //   - Use ISO timestamps for JFSA-compatible audit trails
    //   - Redact standard PII headers from logs (Authorization bearer tokens)
    //   - Suppress excessively verbose health-check logs in production
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const nodeEnv = config.get<string>('NODE_ENV') ?? 'development';
        const isProduction = nodeEnv === 'production';

        return {
          pinoHttp: {
            // Use 'info' in production, 'debug' elsewhere for richer dev logs
            level: isProduction ? 'info' : 'debug',

            // Generate a UUID for each request if not already set by middleware.
            // In practice RequestIdMiddleware sets req.requestId first; this
            // is a safety net for any request that bypasses the middleware.
            genReqId: (req: { headers: Record<string, string | string[] | undefined>; requestId?: string }) =>
              req.requestId ??
              (req.headers['x-request-id'] as string | undefined) ??
              uuidv4(),

            // Enrich each pino-http log with our correlation identifiers so
            // log aggregators (Datadog, CloudWatch, etc.) can reconstruct
            // the full request chain across services.
            customProps: (req: {
              requestId?: string;
              correlationId?: string;
            }) => ({
              request_id: req.requestId,
              correlation_id: req.correlationId,
            }),

            // Redact sensitive header values from access logs.
            // Per APPI, tokens that may carry identity must not be logged
            // in cleartext.  The path syntax is pino-std-serializers format.
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.headers["x-api-key"]',
              ],
              censor: '[REDACTED]',
            },

            // Pretty-print in development; use JSON (default) in production
            // so log aggregators can parse structured lines.
            transport: isProduction
              ? undefined
              : {
                  target: 'pino-pretty',
                  options: {
                    colorize: true,
                    singleLine: false,
                    translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
                    ignore: 'pid,hostname',
                  },
                },

            // Serialise request / response objects — include method, url,
            // status, and response time.  Exclude body to avoid logging PII.
            serializers: {
              req: (req: {
                method: string;
                url: string;
                id?: string;
                remoteAddress?: string;
              }) => ({
                method: req.method,
                url: req.url,
                request_id: req.id,
                remote_address: req.remoteAddress,
              }),
              res: (res: { statusCode: number }) => ({
                status_code: res.statusCode,
              }),
            },

            // Suppress noisy health-check routes in production
            autoLogging: isProduction
              ? {
                  ignore: (req: { url?: string }) =>
                    req.url === '/health' || req.url === '/readyz',
                }
              : true,
          },
        };
      },
    }),

    // ── Rate limiting (ThrottlerModule) ──────────────────────────────────
    // Global throttle defaults — conservative.  Route-specific overrides
    // (e.g. /auth/login at 5 req/min) are applied via @Throttle() decorators
    // or route-level guards in AuthModule.
    //
    // Per brief.md: "rate-limit on /auth/login (5 req/min/IP)".
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            // Global default: 100 requests per minute per IP
            ttl: config.get<number>('THROTTLE_TTL_SECONDS') ?? 60,
            limit: config.get<number>('THROTTLE_LIMIT') ?? 100,
          },
        ],
      }),
    }),

    // ── Feature modules (dependency order per design.md §5) ─────────────
    // 1. AuthModule — JWT issuance; depends only on ConfigModule + Prisma
    AuthModule,

    // 2. AuditModule — audit interceptor and audit log queries;
    //    registered before Claims/Reserves so those modules can inject
    //    AuditService via their own imports.
    AuditModule,

    // 3. ClaimsModule — FNOL intake, adjuster workbench, status FSM
    ClaimsModule,

    // 4. ReservesModule — reserve proposals, approvals, JFSA notifications,
    //    IFRS17 export hook; depends on Claims for claim validation.
    ReservesModule,

    // 5. AppiModule — data-subject export and PII anonymisation;
    //    depends on Claims, Reserves, and Audit.
    AppiModule,
  ],

  // PrismaService is provided at the root level and marked as global in its
  // own module (or here as a plain provider) so that every feature module can
  // inject it without an explicit import.
  providers: [PrismaService],

  // Export PrismaService so modules that import AppModule in tests can access it.
  exports: [PrismaService],
})
export class AppModule implements NestModule {
  /**
   * Register middleware in the order they must execute:
   *   1. RequestIdMiddleware  — assigns `req.requestId` from X-Request-Id header
   *      or generates a fresh UUID v4.
   *   2. CorrelationIdMiddleware — assigns `req.correlationId` from
   *      X-Correlation-Id header, inherits from requestId, or generates UUID.
   *
   * Both middleware apply to ALL routes ('*') so every request — including
   * requests to /docs and /health — carries tracing identifiers.
   *
   * Per design.md §3 (correlation-id.middleware.ts comment):
   *   "MUST be registered AFTER RequestIdMiddleware so that req.requestId is
   *    already set when this middleware runs (used as fallback)."
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RequestIdMiddleware, CorrelationIdMiddleware)
      .forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}