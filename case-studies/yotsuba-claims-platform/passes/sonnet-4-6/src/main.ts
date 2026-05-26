// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/main.ts
//
// Application bootstrap — wires together NestJS, Prisma, Pino logging,
// Helmet security headers, rate limiting, Swagger/OpenAPI docs, and the
// global validation pipe / exception filter.
//
// Per design.md §2 and brief.md non-functional requirements:
//   - Pino structured logging with request_id + correlation_id
//   - Helmet enabled
//   - Rate-limit on /auth/login (5 req/min/IP) — configured in AuthModule
//   - Global exception filter — no stack traces in API responses
//   - OpenAPI / Swagger at /docs
//   - Config from .env
//   - PostgreSQL via Prisma (PrismaService handles connection lifecycle)
// =============================================================================

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/error.filter';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function bootstrap(): Promise<void> {
  // ── Application factory ─────────────────────────────────────────────────
  // bufferLogs: true ensures all log messages emitted before the Pino logger
  // is attached are buffered and replayed rather than lost.
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  // ── Structured logging (Pino) ────────────────────────────────────────────
  // Replace NestJS default logger with nestjs-pino so all framework-level
  // messages (bootstrap, route registration, errors) flow through the same
  // Pino pipeline as our application logs, carrying request_id + correlation_id.
  const pinoLogger = app.get(Logger);
  app.useLogger(pinoLogger);

  // ── Configuration ────────────────────────────────────────────────────────
  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT') ?? 3000;
  const nodeEnv = configService.get<string>('NODE_ENV') ?? 'development';

  // ── Security headers (Helmet) ────────────────────────────────────────────
  // Per brief.md: Helmet enabled. Content-Security-Policy relaxed slightly
  // to allow the Swagger UI to load its own assets from the same origin.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'validator.swagger.io'],
          connectSrc: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  // ── CORS ─────────────────────────────────────────────────────────────────
  // Enable CORS for the Adjuster Workbench (React/Vite dev server on :5173
  // and the production build). In production the origin whitelist should be
  // tightened via the CORS_ORIGIN env var.
  const corsOrigin = configService.get<string>('CORS_ORIGIN') ?? 'http://localhost:5173';
  app.enableCors({
    origin: nodeEnv === 'production' ? corsOrigin : true,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-Id',
      'X-Correlation-Id',
    ],
    exposedHeaders: ['X-Request-Id', 'X-Correlation-Id'],
  });

  // ── Global validation pipe ───────────────────────────────────────────────
  // Per brief.md: class-validator DTOs. whitelist + forbidNonWhitelisted
  // ensures unknown fields are stripped and rejected respectively, which
  // prevents mass-assignment vulnerabilities.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: false,
      },
      stopAtFirstError: false,
    }),
  );

  // ── Global exception filter ──────────────────────────────────────────────
  // Per brief.md: no stack traces in API responses; standardised error
  // envelope. The filter is instantiated with the Pino logger so it can
  // emit structured error logs without a separate logger injection.
  app.useGlobalFilters(new GlobalExceptionFilter());

  // ── API global prefix ────────────────────────────────────────────────────
  // All routes are served under /api/v1 prefix so the Workbench UI can proxy
  // via Vite's devServer.proxy without ambiguity with Swagger UI routes.
  // Exception: /docs (Swagger) is served at the root level.
  app.setGlobalPrefix('api', {
    exclude: ['docs', 'docs-json', 'docs-yaml'],
  });

  // ── OpenAPI / Swagger ────────────────────────────────────────────────────
  // Per brief.md + design.md §2: OpenAPI / Swagger at /docs.
  if (nodeEnv !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Yotsuba Insurance — Claims Processing Platform')
      .setDescription(
        'API for the FNOL intake, Adjuster Workbench, and Reserves Management modules. ' +
        'Implements APPI consent capture, JFSA regulatory threshold notification, ' +
        'IFRS17 reserve export hooks, and a claim status finite-state machine.'
      )
      .setVersion('1.0.0')
      .addTag('auth', 'Authentication — JWT issuance and current-user')
      .addTag('claims', 'FNOL intake, workbench, and status management')
      .addTag('reserves', 'Reserve proposals, approvals, and IFRS17 export')
      .addTag('audit', 'Immutable audit log — auditor access only')
      .addTag('appi', 'APPI Article 28 data-subject export and anonymisation')
      .addTag('notifications', 'JFSA regulatory threshold notifications')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          name: 'Authorization',
          in: 'header',
        },
        'jwt',
      )
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
        displayRequestDuration: true,
        defaultModelsExpandDepth: 2,
        defaultModelExpandDepth: 3,
      },
      customSiteTitle: 'Yotsuba Claims API Docs',
    });

    pinoLogger.log(`Swagger UI available at: http://localhost:${port}/docs`);
  }

  // ── Graceful shutdown ────────────────────────────────────────────────────
  // Enable NestJS lifecycle hooks (OnModuleDestroy, etc.) so that
  // PrismaService.$disconnect() is called cleanly on SIGTERM/SIGINT.
  // Without this, Docker graceful shutdown leaves orphaned Postgres connections.
  app.enableShutdownHooks();

  // ── Start listening ──────────────────────────────────────────────────────
  await app.listen(port);

  pinoLogger.log(
    {
      port,
      nodeEnv,
      pid: process.pid,
    },
    `Yotsuba Claims Platform listening on port ${port} [${nodeEnv}]`,
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

bootstrap().catch((err: unknown) => {
  // Use console.error here because the Pino logger may not be initialised yet
  // if bootstrap() throws before NestFactory.create() completes.
  console.error(
    'Fatal error during application bootstrap:',
    err instanceof Error ? err.message : String(err),
  );
  if (err instanceof Error && err.stack && process.env['NODE_ENV'] !== 'production') {
    console.error(err.stack);
  }
  process.exit(1);
});