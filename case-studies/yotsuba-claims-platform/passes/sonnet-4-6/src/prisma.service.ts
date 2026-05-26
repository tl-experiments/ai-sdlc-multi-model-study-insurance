// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/prisma.service.ts
//
// PrismaService — wraps the Prisma Client for NestJS dependency injection.
//
// Responsibilities:
//   - Extends PrismaClient to gain access to all generated model accessors
//   - Implements OnModuleInit to connect eagerly on application startup
//     (fail-fast: connection errors surface at boot, not at first query)
//   - Implements OnModuleDestroy to disconnect cleanly on shutdown
//     (prevents connection leaks during graceful shutdown / test teardown)
//   - Exposes a `cleanDatabase` utility used exclusively in test environments
//     to truncate tables in dependency order (no prod data risk)
//
// Per design.md §3: every module imports PrismaService from here; no module
// instantiates PrismaClient directly.
//
// Per brief.md: PostgreSQL 16 via Prisma 5; DATABASE_URL from .env.
// =============================================================================

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * PrismaService — the single application-wide Prisma client instance.
 *
 * Registered as a global provider in AppModule so that every feature module
 * can inject it without importing PrismaModule explicitly.
 *
 * Lifecycle:
 *   1. NestJS instantiates this service during module initialisation.
 *   2. `onModuleInit` calls `$connect()` — the Prisma connection pool is
 *      established before any request handler runs.
 *   3. `onModuleDestroy` calls `$disconnect()` — the pool is drained cleanly
 *      when the application shuts down (SIGTERM, test teardown, etc.).
 *
 * Query logging:
 *   In development (`NODE_ENV !== 'production'`), Prisma query events are
 *   forwarded to the NestJS Logger so they appear in the Pino-formatted log
 *   stream with the same `request_id` / `correlation_id` context. In
 *   production only error-level Prisma events are forwarded to avoid
 *   verbose SQL in production logs.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log:
        process.env['NODE_ENV'] !== 'production'
          ? [
              { emit: 'event', level: 'query' },
              { emit: 'event', level: 'info' },
              { emit: 'event', level: 'warn' },
              { emit: 'event', level: 'error' },
            ]
          : [
              { emit: 'event', level: 'warn' },
              { emit: 'event', level: 'error' },
            ],
    });

    // Forward Prisma log events to the NestJS / Pino logger so they appear
    // in the structured log stream with proper severity.
    //
    // NOTE: Prisma's `$on` type signatures are conditional on the log config
    // passed above; TypeScript narrows them correctly when using the typed
    // overloads. We cast via `any` only for the event payload access below
    // because Prisma's generated event types vary per version and we want
    // this to compile cleanly across minor Prisma upgrades.

    if (process.env['NODE_ENV'] !== 'production') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).$on('query', (e: any) => {
        this.logger.debug(
          {
            query: e.query,
            params: e.params,
            duration_ms: e.duration,
          },
          'Prisma query',
        );
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).$on('info', (e: any) => {
        this.logger.log({ message: e.message }, 'Prisma info');
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).$on('warn', (e: any) => {
      this.logger.warn({ message: e.message }, 'Prisma warning');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).$on('error', (e: any) => {
      this.logger.error({ message: e.message }, 'Prisma error');
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle hooks
  // -------------------------------------------------------------------------

  /**
   * Called by NestJS after the module has been fully initialised.
   *
   * Eagerly establishes the Prisma connection pool so that the application
   * fails fast at startup if the database is unreachable — rather than
   * failing on the first incoming request, which would produce a less
   * debuggable error.
   *
   * Logs the connection attempt so the startup sequence is visible in
   * structured logs (useful in containerised environments where the DB
   * container may start slightly after the app container).
   */
  async onModuleInit(): Promise<void> {
    this.logger.log('Connecting to PostgreSQL via Prisma...');
    try {
      await this.$connect();
      this.logger.log('Prisma connected to PostgreSQL successfully.');
    } catch (err) {
      this.logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'Failed to connect to PostgreSQL. Ensure DATABASE_URL is set correctly.',
      );
      // Re-throw so NestJS application startup fails loudly
      throw err;
    }
  }

  /**
   * Called by NestJS when the application is shutting down.
   *
   * Drains the Prisma connection pool cleanly to avoid connection leaks.
   * This is particularly important during:
   *   - Graceful SIGTERM shutdown in production
   *   - Jest test teardown (each e2e spec calls `app.close()` which triggers
   *     this hook, ensuring the Postgres connection count does not grow
   *     unboundedly across test suites)
   */
  async onModuleDestroy(): Promise<void> {
    this.logger.log('Disconnecting Prisma from PostgreSQL...');
    await this.$disconnect();
    this.logger.log('Prisma disconnected.');
  }

  // -------------------------------------------------------------------------
  // Test utilities
  // -------------------------------------------------------------------------

  /**
   * Truncates all application tables in dependency order (children before
   * parents, respecting FK constraints).
   *
   * **ONLY call this in test environments.** Guards are in place:
   *   - Throws if `NODE_ENV !== 'test'`
   *   - Uses `TRUNCATE … CASCADE` so FK constraints do not cause errors even
   *     if the order below is incomplete
   *
   * Order rationale:
   *   - `audit_events` first — references claims but has no dependants
   *   - `notifications_to_regulator` — references claims + reserves
   *   - `reserves` — references claims
   *   - `witness_statements` — references claims
   *   - `evidence` — references claims
   *   - `claim_notes` — references claims
   *   - `claims` — references users
   *   - `users` last — no FK dependants remain
   *
   * Uses a raw `$executeRawUnsafe` call because Prisma does not expose a
   * TRUNCATE abstraction. The table names are hard-coded (not user-supplied)
   * so there is no SQL-injection risk.
   */
  async cleanDatabase(): Promise<void> {
    if (process.env['NODE_ENV'] !== 'test') {
      throw new Error(
        'cleanDatabase() must only be called in NODE_ENV=test environments.',
      );
    }

    // Truncate in dependency order with CASCADE to handle any FK references
    // that might be missed by ordering alone.
    await this.$executeRawUnsafe(
      `TRUNCATE TABLE
         "AuditEvent",
         "NotificationToRegulator",
         "Reserve",
         "WitnessStatement",
         "Evidence",
         "ClaimNote",
         "Claim",
         "User"
       CASCADE`,
    );

    this.logger.debug('cleanDatabase: all tables truncated for test isolation.');
  }
}