// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/audit/audit.service.ts
//
// Audit service. Handles:
//   - Writing immutable AuditEvent records to the database.
//   - Querying the audit log with filters (actor, claim, action, date range).
//
// DESIGN INVARIANT (ADR-002): There is NO update or delete pathway for
// AuditEvent rows in this service. The append-only constraint is enforced
// here in code; Postgres RLS tightening is tracked for Track B.
//
// Every write emits a sha-256 payload_hash over the normalised event body
// so that individual records can be content-verified out-of-band.
// =============================================================================

import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import type { UserRole, AuditEvent } from '@prisma/client';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Payload required to record one audit event.
 *
 * `request_id` and `correlation_id` must be propagated from the incoming
 * HTTP context (set by RequestIdMiddleware / CorrelationIdMiddleware).
 */
export interface CreateAuditEventInput {
  actor_id: string;
  actor_role: UserRole;
  /** Dot-notation action name, e.g. "claim.created", "reserve.approved". */
  action: string;
  claim_id?: string | null;
  /** The primary entity being mutated (note id, reserve id, evidence id …). */
  target_id?: string | null;
  /**
   * The normalised event payload whose sha-256 becomes `payload_hash`.
   * Pass the full DTO / entity snapshot so reviewers can verify integrity.
   */
  payload: Record<string, unknown>;
  request_id: string;
  correlation_id: string;
}

/**
 * Filters accepted by `queryAuditLog`.
 * All fields are optional; omitting a field means "no filter on that column".
 */
export interface AuditQueryFilters {
  from?: string;        // ISO-8601 date string
  to?: string;          // ISO-8601 date string
  actor_id?: string;
  claim_id?: string;
  action?: string;
  limit?: number;
  offset?: number;
}

/**
 * A single page of audit log results returned by `queryAuditLog`.
 */
export interface AuditLogPage {
  data: AuditEvent[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class AuditService {
  /**
   * Default page size for audit log queries.
   * Large enough for a working session; small enough to avoid OOM on huge tables.
   */
  private static readonly DEFAULT_LIMIT = 100;
  private static readonly MAX_LIMIT = 500;

  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // record — the ONLY write pathway for AuditEvent rows
  // ---------------------------------------------------------------------------

  /**
   * Appends a single, immutable audit event to the `audit_log` table.
   *
   * Computes `payload_hash` here so callers never need to think about it.
   * The hash is sha-256 over `JSON.stringify(payload)` with keys sorted for
   * canonical representation — this prevents trivially different stringifications
   * from producing different hashes for semantically identical payloads.
   *
   * @returns The newly-created `AuditEvent` row.
   */
  async record(input: CreateAuditEventInput): Promise<AuditEvent> {
    const payload_hash = AuditService.hashPayload(input.payload);

    // NOTE: prisma.auditEvent.create — intentionally no update/upsert path.
    const event = await this.prisma.auditEvent.create({
      data: {
        actor_id: input.actor_id,
        actor_role: input.actor_role,
        action: input.action,
        claim_id: input.claim_id ?? null,
        target_id: input.target_id ?? null,
        payload_hash,
        request_id: input.request_id,
        correlation_id: input.correlation_id,
        // `ts` defaults to now() in the schema; no override here.
      },
    });

    return event;
  }

  // ---------------------------------------------------------------------------
  // queryAuditLog — read-only; auditor role only (guarded at controller level)
  // ---------------------------------------------------------------------------

  /**
   * Returns a paginated, filtered view of the audit log.
   *
   * Filters are applied as AND conditions.
   * Results are ordered by `ts` descending (most-recent first).
   *
   * @param filters  Optional filter / pagination parameters.
   * @returns A page of `AuditEvent` rows plus total-count metadata.
   */
  async queryAuditLog(filters: AuditQueryFilters = {}): Promise<AuditLogPage> {
    const limit = Math.min(
      filters.limit ?? AuditService.DEFAULT_LIMIT,
      AuditService.MAX_LIMIT,
    );
    const offset = filters.offset ?? 0;

    // Build up the Prisma `where` clause dynamically.
    const where: Parameters<typeof this.prisma.auditEvent.findMany>[0]['where'] = {};

    if (filters.actor_id) {
      where.actor_id = filters.actor_id;
    }

    if (filters.claim_id) {
      where.claim_id = filters.claim_id;
    }

    if (filters.action) {
      // Prefix-match is handy for queries like action="claim." to get all
      // claim-related events; exact match is also fully supported.
      where.action = { startsWith: filters.action };
    }

    if (filters.from || filters.to) {
      where.ts = {};
      if (filters.from) {
        where.ts.gte = new Date(filters.from);
      }
      if (filters.to) {
        where.ts.lte = new Date(filters.to);
      }
    }

    const [data, total] = await this.prisma.$transaction([
      this.prisma.auditEvent.findMany({
        where,
        orderBy: { ts: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.auditEvent.count({ where }),
    ]);

    return { data, total, limit, offset };
  }

  // ---------------------------------------------------------------------------
  // getByClaimId — convenience method for claim-scoped audit views
  // ---------------------------------------------------------------------------

  /**
   * Returns all audit events for a specific claim, ordered by timestamp ascending
   * (chronological — suitable for the claim timeline view in the workbench UI).
   *
   * Validates that the claim exists first so callers get a clean 404 rather
   * than an empty list when the claim id is wrong.
   *
   * @param claimId  The claim whose events are requested.
   */
  async getByClaimId(claimId: string): Promise<AuditEvent[]> {
    // Verify the claim exists — guards against silent empty results.
    const claim = await this.prisma.claim.findUnique({
      where: { id: claimId },
      select: { id: true },
    });

    if (!claim) {
      throw new NotFoundException(`Claim ${claimId} not found.`);
    }

    return this.prisma.auditEvent.findMany({
      where: { claim_id: claimId },
      orderBy: { ts: 'asc' },
    });
  }

  // ---------------------------------------------------------------------------
  // Static helpers
  // ---------------------------------------------------------------------------

  /**
   * Computes the canonical sha-256 payload hash.
   *
   * Keys are sorted recursively so that `{a:1,b:2}` and `{b:2,a:1}` produce
   * the same hash. This is the single source of truth for payload hashing;
   * the audit interceptor can call this when it needs to pre-compute the hash
   * before calling `record()`.
   */
  static hashPayload(payload: Record<string, unknown>): string {
    const canonical = JSON.stringify(payload, sortedReplacer);
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/**
 * JSON.stringify replacer that sorts object keys alphabetically.
 * Ensures canonical serialisation regardless of insertion order.
 */
function sortedReplacer(
  _key: string,
  value: unknown,
): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((sorted, k) => {
        sorted[k] = (value as Record<string, unknown>)[k];
        return sorted;
      }, {});
  }
  return value;
}