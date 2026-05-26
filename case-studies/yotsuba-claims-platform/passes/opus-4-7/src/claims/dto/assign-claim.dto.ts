// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// Assign-claim DTO.
//
// Wire contract for `POST /claims/:id/assign`. The endpoint is
// manager-only (enforced by the roles guard in the controller); this
// DTO carries the identity of the adjuster to assign and an optional
// human-readable reason when the call is a *re*-assignment.
//
// Per the brief:
//   * Only `manager` may assign or reassign claims, and only within
//     their reports' pool. The reports-pool check is a service-level
//     concern (it requires loading the target adjuster and walking the
//     `reports_to` relation); the DTO only guarantees the shape of the
//     request body.
//   * Every assignment writes an `AuditEvent` (`action=claim.assigned`)
//     with the standard envelope. The `reason_for_reassignment` field,
//     when present, is included in the payload that gets hashed into
//     `AuditEvent.payload_hash` (ADR-002) — so the reason becomes part
//     of the tamper-evident record.
//
// Validation philosophy:
//   * `adjuster_id` is required and bounded to the Prisma cuid shape
//     (a lowercase alphanumeric string starting with `c`, 24–32 chars).
//     We do not verify *existence* here — the service does that, along
//     with the role check (target user must have role `adjuster`).
//   * `reason_for_reassignment` is optional on first assignment but
//     strongly recommended on any subsequent assignment; whether to
//     require it conditionally on the claim's existing assignee is
//     decided in the service, not the DTO.
// ─────────────────────────────────────────────────────────────────────────

import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Prisma cuid shape. Prisma's default `cuid()` generator emits a
 * lowercase alphanumeric string beginning with `c`. We accept a
 * permissive length window (24–32) to remain forward-compatible with
 * `cuid2` should Prisma migrate the default generator.
 */
const CUID_RE = /^c[a-z0-9]{23,31}$/;

/**
 * Request body for `POST /claims/:id/assign`.
 *
 * The controller resolves the manager from the JWT and the claim from
 * the path parameter; this body supplies only the assignee and an
 * optional reason. The service is responsible for:
 *   * verifying the manager's authority over the target adjuster
 *     (reports-pool check);
 *   * verifying that the target user exists and has role `adjuster`;
 *   * persisting `assigned_at` and `assigned_by` alongside the
 *     `assigned_adjuster_id` update;
 *   * emitting the `claim.assigned` audit event.
 */
export class AssignClaimDto {
  /**
   * Identifier of the adjuster to assign the claim to. Must be a
   * Prisma cuid; existence and role are verified by the service.
   */
  @IsString()
  @Matches(CUID_RE, {
    message: 'adjuster_id must be a valid identifier.',
  })
  adjuster_id!: string;

  /**
   * Optional explanation for a reassignment. Recorded verbatim on the
   * resulting `AuditEvent` payload and visible to auditors via
   * `GET /audit`. Bounded to keep the audit `payload_hash` cheap to
   * compute and to avoid unbounded log growth. Typical values include
   * `initial assignment`, `adjuster on leave`, `workload rebalance`,
   * or `escalation to senior adjuster`.
   */
  @IsOptional()
  @IsString()
  @MinLength(4, {
    message: 'reason_for_reassignment must be at least 4 characters.',
  })
  @MaxLength(1000, {
    message: 'reason_for_reassignment must be at most 1000 characters.',
  })
  reason_for_reassignment?: string;
}