// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// `main.ts` — application bootstrap.
//
// Responsibilities (in order):
//
//   1. Construct the Nest application from `AppModule`.
//   2. Wire process-wide cross-cutting concerns:
//        * Helmet (security headers)
//        * Global `ValidationPipe` (class-validator on every DTO)
//        * Global `GlobalExceptionFilter` (uniform error envelope,
//          stack-trace suppression, `request_id` / `correlation_id`
//          surfacing)
//        * Pino-friendly Nest `Logger` (already configured via
//          per-service `Logger` instances; we simply enable it here)
//        * CORS (open in dev, restricted by `CORS_ORIGIN` env in prod)
//   3. Mount the OpenAPI/Swagger document at `/docs` per the brief's
//      non-functional requirement.
//   4. Bind Prisma's `beforeExit` event to Nest's `app.close()` so
//      SIGTERM / SIGINT propagate cleanly through the DI graph (see
//      `PrismaService.enableShutdownHooks`).
//   5. Listen on `PORT` (default 3000).
//
// The two ID middlewares (`RequestIdMiddleware`,
// `CorrelationIdMiddleware`) and the audit interceptor are wired inside
// `AppModule` / `common/` — they are not bootstrap concerns. Keeping
// this file narrow means production deploys, e2e tests, and ad-hoc
// scripts all share the same composition root without divergence.
// ─────────────────────────────────────────────────────────────────────────

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/error.filter';
import { PrismaService } from './prisma.service';

/**
 * Resolve the listen port. Defaults to 3000 to match the README curl
 * examples and the Vite dev-server proxy in `web/`. Invalid values fall
 * back to the default rather than crashing — a typo in an environment
 * file shouldn't take the service down.
 */
function resolvePort(): number {
  const raw = process.env.PORT;
  if (!raw) return 3000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) return 3000;
  return parsed;
}

/**
 * Resolve allowed CORS origins. In production we expect an explicit
 * comma-separated whitelist via `CORS_ORIGIN`; in any other environment
 * we allow all origins so the Vite dev server and Jest supertest probes
 * work without configuration ceremony.
 */
function resolveCorsOrigin(): string | string[] | boolean {
  const raw = process.env.CORS_ORIGIN;
  if (process.env.NODE_ENV === 'production') {
    if (!raw || raw.trim().length === 0) return false;
    return raw
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
  }
  return true;
}

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create(AppModule, {
    // Buffer logs until the Pino-backed logger is in place; this avoids
    // a brief window of unstructured stdout during startup.
    bufferLogs: true,
  });

  // ─── security headers ────────────────────────────────────────────────
  // Helmet defaults are sensible for a JSON API. We disable the
  // contentSecurityPolicy directive here because the Swagger UI mounted
  // at /docs needs inline scripts/styles; the Vite-served workbench
  // applies its own CSP at the edge.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  // ─── CORS ────────────────────────────────────────────────────────────
  app.enableCors({
    origin: resolveCorsOrigin(),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-Id',
      'X-Correlation-Id',
    ],
    exposedHeaders: ['X-Request-Id', 'X-Correlation-Id'],
  });

  // ─── global validation ───────────────────────────────────────────────
  // `whitelist: true` strips unknown properties so attackers cannot
  // smuggle extra fields past DTO validation. `forbidNonWhitelisted`
  // turns that into a 400 with a clear message — preferred over silent
  // stripping for an API consumed by trusted upstream channels.
  // `transform: true` enables the class-transformer pipeline so DTOs
  // receive typed primitives (Date, number) rather than raw strings.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      stopAtFirstError: false,
    }),
  );

  // ─── global exception filter ─────────────────────────────────────────
  // Standardised error envelope; no stack traces leaked over the wire
  // (NFR in brief.md). `request_id` and `correlation_id` are surfaced
  // for support-ticket triage.
  app.useGlobalFilters(new GlobalExceptionFilter());

  // ─── Prisma shutdown hooks ───────────────────────────────────────────
  // Bind Prisma's `beforeExit` to Nest's `app.close()` so SIGTERM /
  // SIGINT propagate cleanly through the DI graph and the connection
  // pool drains before the process exits.
  const prisma = app.get(PrismaService);
  prisma.enableShutdownHooks(app);
  app.enableShutdownHooks();

  // ─── OpenAPI / Swagger ───────────────────────────────────────────────
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Yotsuba Claims Platform')
    .setDescription(
      'P&C insurance claims processing platform — FNOL intake, Adjuster ' +
        'Workbench, and Reserves Management. Track A surface area.',
    )
    .setVersion('1.0.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT issued by POST /auth/login',
      },
      'bearer',
    )
    .addTag('auth', 'Authentication and current-user endpoints')
    .addTag('claims', 'FNOL intake and Adjuster Workbench endpoints')
    .addTag('reserves', 'Reserves proposal, approval, and IFRS17 export')
    .addTag('audit', 'Audit log access (auditor only)')
    .addTag('appi', 'APPI data-subject-export and anonymisation')
    .addTag(
      'notifications',
      'JFSA threshold notifications (pending daily flush)',
    )
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
    },
  });

  // ─── listen ──────────────────────────────────────────────────────────
  const port = resolvePort();
  await app.listen(port);
  logger.log(`yotsuba_claims_listening port=${port} docs=/docs`);
}

bootstrap().catch((err: unknown) => {
  // Last-resort bootstrap failure handler. We deliberately log via the
  // raw console here because the Nest logger may not have been
  // initialised yet when an early failure (e.g. AppModule construction)
  // surfaces.
  // eslint-disable-next-line no-console
  console.error('bootstrap_failed', err);
  process.exit(1);
});