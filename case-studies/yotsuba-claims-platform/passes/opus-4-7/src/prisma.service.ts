// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// `PrismaService` — the single Nest-managed entry point to the Postgres
// database via the generated Prisma client.
//
// Why a dedicated service (rather than `new PrismaClient()` inline):
//
//   1. Lifecycle. Nest owns module construction and teardown. Hooking
//      `OnModuleInit` / `OnModuleDestroy` guarantees the database pool
//      is opened before the first request is served and closed cleanly
//      on shutdown — important for graceful container restarts and for
//      Jest e2e suites that spin the app up and tear it down per file.
//
//   2. Injectability. Every service in `claims/`, `reserves/`, `audit/`,
//      `appi/`, and `auth/` takes `PrismaService` through the DI graph.
//      A single instance per Nest application means a single connection
//      pool and a single place to layer cross-cutting concerns (logging,
//      metrics, soft-delete filters, future row-level-security context).
//
//   3. Test ergonomics. Exposing `enableShutdownHooks()` lets e2e tests
//      bind Prisma's `beforeExit` event to Nest's `app.close()` so the
//      whole graph tears down deterministically when the database pool
//      reports it has drained — no leaked handles, no Jest open-handle
//      warnings.
//
//   4. Audit-immutability guard rail (ADR-002). The `AuditEvent` table
//      is append-only by code convention. This service exposes a single
//      `$transaction`-aware client surface; any future enforcement (e.g.
//      a `$use` middleware that throws on `update`/`delete` against
//      `AuditEvent`) belongs here and nowhere else.
//
// The class extends `PrismaClient` directly so callers continue to use
// the familiar `prisma.claim.findUnique(...)` / `prisma.$transaction(...)`
// API without an additional indirection layer.
// ─────────────────────────────────────────────────────────────────────────

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Prisma log levels we surface through Pino. `query` is intentionally
 * left off in production — it is too chatty and risks leaking PII into
 * log aggregators. It can be re-enabled per-environment via the
 * `PRISMA_LOG_QUERIES` env flag for targeted debugging.
 */
function resolveLogLevels(): Prisma.LogLevel[] {
  const base: Prisma.LogLevel[] = ['warn', 'error'];
  if (process.env.PRISMA_LOG_QUERIES === 'true') {
    base.unshift('query', 'info');
  } else if (process.env.NODE_ENV !== 'production') {
    base.unshift('info');
  }
  return base;
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: resolveLogLevels().map((level) => ({
        emit: 'event',
        level,
      })) as Prisma.LogDefinition[],
      errorFormat: process.env.NODE_ENV === 'production' ? 'minimal' : 'pretty',
    });

    // Bridge Prisma's event emitter into Nest's Logger so a single Pino
    // stream captures both application and database diagnostics. The
    // casts below are required because Prisma's typed event surface is
    // declared per-log-level on the generated client and does not cleanly
    // narrow through the dynamic `resolveLogLevels()` output.
    type PrismaEventEmitter = {
      $on: (
        event: 'query' | 'info' | 'warn' | 'error',
        cb: (e: Prisma.QueryEvent | Prisma.LogEvent) => void,
      ) => void;
    };
    const emitter = this as unknown as PrismaEventEmitter;

    emitter.$on('warn', (event) => {
      this.logger.warn(
        { prisma_event: 'warn', message: (event as Prisma.LogEvent).message },
        'prisma_warn',
      );
    });
    emitter.$on('error', (event) => {
      this.logger.error(
        { prisma_event: 'error', message: (event as Prisma.LogEvent).message },
        'prisma_error',
      );
    });
  }

  /**
   * Open the connection pool eagerly so the first inbound request does
   * not pay the connection-establishment latency. Failures here are
   * fatal — without a database the application cannot serve any route
   * meaningfully — and Nest will abort bootstrap.
   */
  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('prisma_connected');
  }

  /**
   * Drain the connection pool on Nest shutdown. Idempotent: Prisma
   * tolerates `$disconnect()` being called against an already-closed
   * client, so this is safe to invoke from both `OnModuleDestroy` and
   * the `enableShutdownHooks` bridge.
   */
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('prisma_disconnected');
  }

  /**
   * Wire Prisma's `beforeExit` event to the Nest application's `close()`
   * so SIGTERM / SIGINT propagate cleanly through the DI graph before
   * the process terminates. Called from `main.ts` after `app.create()`.
   *
   * Jest e2e suites also rely on this: when the test runner closes the
   * Nest app between files, the Prisma pool is released along with it,
   * eliminating the "Jest did not exit one second after the test run"
   * warning that otherwise plagues long-lived database connections.
   */
  enableShutdownHooks(app: INestApplication): void {
    // Prisma 5's `beforeExit` is exposed only on the process-level event
    // emitter, not on the typed client surface. The cast localises that
    // quirk to this one line.
    (this as unknown as {
      $on: (event: 'beforeExit', cb: () => Promise<void> | void) => void;
    }).$on('beforeExit', async () => {
      this.logger.log('prisma_before_exit');
      await app.close();
    });
  }
}