// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// Audit service.
//
// Responsibilities:
//   * Write `AuditEvent` rows on behalf of the `AuditInterceptor` and
//     any service that needs to record a non-HTTP-triggered event
//     (e.g. the JFSA threshold emitter inside reserves).
//   * Read the audit log on behalf of `GET /audit`, with the filter
//     surface declared in design.md §2 (`from`, `to`, `actor`,
//     `claim_id`, `action`).
//
// What this service deliberately does NOT do:
//   * UPDATE or DELETE on `AuditEvent`. The append-only contract is
//     part of the brief (NFR "Audit immutability") and ADR-002. No
//     method on this service exposes a mutation pathway, and a grep
//     of the codebase for `auditEvent.update` / `auditEvent.delete`
//     should return nothing. Production hardening (Postgres trigger
//     that raises on UPDATE/DELETE) is tracked in Track B.
//   * Cross-claim aggregation — that lives in `appi.service.ts` for
//     data-subject exports and in `reserves-export.service.ts` for
//     IFRS17.
//
// Payload hashing:
//   * Every audit row carries a `payload_hash` — a SHA-256 over a
//     canonical (key-sorted) JSON serialisation of the event payload.
//   * `null` / `undefined` payloads hash the empty object `{}` so the
//     field is never empty; this makes downstream tamper-detection
//     uniform.
//   * BigInt / Decimal values are coerced to string before hashing so
//     the canonical form is portable across runtimes.
//
// Correlation:
//   * `request_id` and `correlation_id` are propagated from the request
//     middleware (see `common/request-id.middleware.ts` and
//     `common/correlation-id.middleware.ts`). When this service is
//     invoked outside an HTTP request (e.g. a daily batch), the caller
//     supplies these explicitly; if absent we fall back to a generated
//     UUID so the row is still queryable.
// ─────────────────────────────────────────────────────────────────────────

import { createHash, randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import type { AuditEvent, Prisma, UserRole } from '@prisma/client';

import { PrismaService } from '../prisma.service';

/**
 * Input to `AuditService.record`. The shape mirrors the columns of
 * `AuditEvent` but accepts a raw `payload` object which we hash here
 * rather than expecting callers to compute the hash themselves.
 */
export interface RecordAuditInput {
  actor_id: string;
  actor_role: UserRole;
  action: string;
  claim_id?: string | null;
  target_id?: string | null;
  payload?: unknown;
  request_id?: string | null;
  correlation_id?: string | null;
}

/**
 * Filter surface for `GET /audit`. All fields are optional; an empty
 * filter returns the most recent events up to `limit`.
 */
export interface AuditQuery {
  from?: Date;
  to?: Date;
  actor?: string;
  claim_id?: string;
  action?: string;
  limit?: number;
  cursor?: string;
}

/** Hard cap to keep the auditor view from accidentally pulling the world. */
const MAX_AUDIT_PAGE_SIZE = 500;
const DEFAULT_AUDIT_PAGE_SIZE = 100;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Append a single audit event. Returns the persisted row so callers
   * (notably the interceptor) can include the `id` in structured logs
   * for cross-system correlation.
   *
   * This method must never throw to the caller's caller — auditing is
   * a side-effect, and a failure to write an audit row must not abort
   * the originating business operation. Failures are logged at error
   * level and swallowed; the originating request still succeeds. (A
   * production deployment would back this with a durable outbox; the
   * POC accepts the trade-off and surfaces it via the logs.)
   */
  async record(input: RecordAuditInput): Promise<AuditEvent | null> {
    const payloadHash = this.hashPayload(input.payload);
    const requestId = input.request_id ?? randomUUID();
    const correlationId = input.correlation_id ?? requestId;

    const data: Prisma.AuditEventUncheckedCreateInput = {
      actor_id: input.actor_id,
      actor_role: input.actor_role,
      action: input.action,
      claim_id: input.claim_id ?? null,
      target_id: input.target_id ?? null,
      payload_hash: payloadHash,
      request_id: requestId,
      correlation_id: correlationId,
    };

    try {
      const event = await this.prisma.auditEvent.create({ data });
      this.logger.debug(
        `audit.recorded id=${event.id} action=${event.action} ` +
          `actor=${event.actor_id} claim=${event.claim_id ?? '-'} ` +
          `request_id=${event.request_id} correlation_id=${event.correlation_id}`,
      );
      return event;
    } catch (err) {
      this.logger.error(
        `Failed to write audit event action=${input.action} actor=${input.actor_id}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return null;
    }
  }

  /**
   * Read the audit log with optional filters. Ordering is newest-first
   * on `ts`; ties broken by `id` for stable pagination. Cursor-based
   * pagination uses the last seen `id`.
   */
  async query(filter: AuditQuery): Promise<AuditEvent[]> {
    const take = this.clampLimit(filter.limit);
    const where: Prisma.AuditEventWhereInput = {};

    if (filter.from || filter.to) {
      where.ts = {};
      if (filter.from) where.ts.gte = filter.from;
      if (filter.to) where.ts.lte = filter.to;
    }
    if (filter.actor) where.actor_id = filter.actor;
    if (filter.claim_id) where.claim_id = filter.claim_id;
    if (filter.action) where.action = filter.action;

    const args: Prisma.AuditEventFindManyArgs = {
      where,
      orderBy: [{ ts: 'desc' }, { id: 'desc' }],
      take,
    };

    if (filter.cursor) {
      args.cursor = { id: filter.cursor };
      args.skip = 1;
    }

    return this.prisma.auditEvent.findMany(args);
  }

  /**
   * Return every audit event touching a given claim, oldest-first.
   * Used by `appi.service.ts` when building a data-subject export so
   * the timeline of writes is included in the disclosure.
   */
  async forClaim(claimId: string): Promise<AuditEvent[]> {
    return this.prisma.auditEvent.findMany({
      where: { claim_id: claimId },
      orderBy: [{ ts: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Return every audit event for a given actor, oldest-first. Used by
   * the data-subject-export path when the subject is also a user of
   * the system (rare in claims context but supported for completeness).
   */
  async forActor(actorId: string): Promise<AuditEvent[]> {
    return this.prisma.auditEvent.findMany({
      where: { actor_id: actorId },
      orderBy: [{ ts: 'asc' }, { id: 'asc' }],
    });
  }

  // ─── helpers ─────────────────────────────────────────────────────────

  /**
   * Canonicalise + SHA-256 the event payload. Keys are sorted at every
   * level so semantically equivalent payloads produce identical hashes
   * regardless of property insertion order. `bigint` and Prisma
   * `Decimal` values are coerced to string.
   */
  private hashPayload(payload: unknown): string {
    const canonical = this.canonicalStringify(payload ?? {});
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  }

  private canonicalStringify(value: unknown): string {
    const replacer = (_key: string, v: unknown): unknown => {
      if (typeof v === 'bigint') return v.toString();
      if (v && typeof v === 'object') {
        // Prisma Decimal / Date / Buffer all have sensible toString /
        // toJSON behaviour; we only need to special-case plain objects
        // to enforce key ordering. Arrays preserve their order.
        const obj = v as Record<string, unknown>;
        if (
          obj.constructor === Object ||
          Object.getPrototypeOf(obj) === null
        ) {
          const sorted: Record<string, unknown> = {};
          for (const k of Object.keys(obj).sort()) {
            sorted[k] = obj[k];
          }
          return sorted;
        }
        if (Buffer.isBuffer(v)) {
          return `buf:${(v as Buffer).toString('base64')}`;
        }
        if (v instanceof Date) {
          return v.toISOString();
        }
      }
      return v;
    };
    return JSON.stringify(value, replacer);
  }

  private clampLimit(raw: number | undefined): number {
    if (raw === undefined || !Number.isFinite(raw)) {
      return DEFAULT_AUDIT_PAGE_SIZE;
    }
    const n = Math.floor(raw);
    if (n <= 0) return DEFAULT_AUDIT_PAGE_SIZE;
    if (n > MAX_AUDIT_PAGE_SIZE) return MAX_AUDIT_PAGE_SIZE;
    return n;
  }
}