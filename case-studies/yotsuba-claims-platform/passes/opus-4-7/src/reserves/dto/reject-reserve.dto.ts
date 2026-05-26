// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// Reject-reserve DTO — payload for `POST /reserves/:id/reject`.
//
// The brief specifies (Module 3 — Reserves Management) that a
// rejection captures a `reason_for_rejection`. The schema models
// it as a non-null string on the `Reserve` row, populated only on
// the rejection path. This DTO is the only legitimate carrier of
// that field across the API surface — `propose-reserve.dto.ts`
// deliberately omits it for the reasons captured in that file's
// header.
//
// The rejection reason is the only piece of free text on the
// rejection path; it enters the audit `payload_hash` via the
// `@Audit({ action: 'reserve.rejected' })` decorator on the
// controller, and it appears in the reserve history that
// `GET /claims/:id/reserves` returns. Both consumers (auditors and
// the proposing adjuster) rely on it being substantive, so we
// mandate a non-trivial minimum length analogous to the
// `justification` floor on the propose path — the symmetry is
// deliberate: a rejection that cannot be explained in 20+
// characters is a process smell.
// ─────────────────────────────────────────────────────────────────────────

import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * DTO for `POST /reserves/:id/reject`. See file header for the
 * full rationale on the field.
 */
export class RejectReserveDto {
  /**
   * Free-text reason the manager is rejecting the proposed
   * reserve. Persisted verbatim on `Reserve.reason_for_rejection`
   * and folded into the audit envelope. The 20-character floor is
   * a deliberate process guardrail (see file header); the
   * 2000-character ceiling matches the practical upper bound on a
   * single rejection note and keeps the audit payload bounded.
   */
  @IsString({ message: 'reason_for_rejection must be a string.' })
  @MinLength(20, {
    message: 'reason_for_rejection must be at least 20 characters.',
  })
  @MaxLength(2000, {
    message: 'reason_for_rejection must be at most 2000 characters.',
  })
  reason_for_rejection!: string;
}