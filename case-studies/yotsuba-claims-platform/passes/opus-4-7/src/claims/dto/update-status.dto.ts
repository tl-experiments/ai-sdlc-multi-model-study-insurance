// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// Update-status DTO.
//
// Wire contract for `PATCH /claims/:id/status`. The endpoint drives the
// claim workflow state machine declared in ADR-004 and implemented as a
// pure function in `claims-status.fsm.ts`:
//
//   intake
//     → under_investigation
//     → awaiting_reserve_approval
//     → settlement_offered
//     → closed_paid | closed_denied
//     → reopened
//
// Validation philosophy:
//   * The DTO enforces only the *shape* of the request: `to` is a known
//     `ClaimStatus` enum value and `reason` is a bounded non-empty
//     string. Whether a given transition is legal from the current
//     state — and whether the caller's role permits it — is decided by
//     the FSM and the role guard in the controller/service layer.
//   * `reason` is mandatory because every status transition is an
//     auditable business event. The audit interceptor will hash this
//     payload into `AuditEvent.payload_hash`, so the reason becomes
//     part of the tamper-evident record (ADR-002). A minimum length
//     of 4 characters discourages reflexive one-letter entries while
//     remaining permissive enough for canonical short reasons such as
//     `paid` or `denied`.
// ─────────────────────────────────────────────────────────────────────────

import { IsEnum, IsString, MaxLength, MinLength } from 'class-validator';

import { ClaimStatus } from '@prisma/client';

/**
 * Request body for transitioning a claim to a new workflow state.
 *
 * The accompanying state-machine module (`claims-status.fsm.ts`)
 * decides whether `(currentStatus → to)` is legal for the caller's
 * role; this DTO only guarantees that `to` is a syntactically valid
 * `ClaimStatus` and that `reason` is present and bounded.
 */
export class UpdateStatusDto {
  /**
   * Target status. Must be a member of the `ClaimStatus` enum defined
   * in the Prisma schema. Illegal transitions from the current state
   * are rejected with HTTP 422 by the controller, carrying the FSM's
   * explanation in the error envelope.
   */
  @IsEnum(ClaimStatus, {
    message:
      'to must be one of: intake, under_investigation, '
      + 'awaiting_reserve_approval, settlement_offered, closed_paid, '
      + 'closed_denied, reopened.',
  })
  to!: ClaimStatus;

  /**
   * Human-readable justification for the transition. Recorded verbatim
   * on the resulting `AuditEvent` payload and visible to auditors via
   * `GET /audit`. Bounded to keep the audit `payload_hash` cheap to
   * compute and to avoid unbounded log growth.
   */
  @IsString()
  @MinLength(4, {
    message: 'reason must be at least 4 characters.',
  })
  @MaxLength(1000, {
    message: 'reason must be at most 1000 characters.',
  })
  reason!: string;
}