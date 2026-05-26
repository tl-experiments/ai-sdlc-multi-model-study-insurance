// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/reserves/dto/reject-reserve.dto.ts
//
// DTO for rejecting a proposed reserve change.
//
// Design reference: design.md §1 Data model (Reserve), §2 API contract
// Brief reference:  brief.md §3 Reserves Management
//
// Validation rules:
//   - reason_for_rejection: non-empty string; minimum 10 characters to ensure
//     a meaningful rejection rationale is captured for audit and actuarial review.
//
// ADR-002: Every rejection emits an AuditEvent (enforced in ReservesService).
// ADR-005: Approval tier rules are enforced in ReservesService, not here.
// =============================================================================

import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';

/**
 * DTO for POST /reserves/:id/reject
 *
 * Captures the mandatory reason for rejecting a proposed reserve change.
 * The reason is stored on the Reserve record as `reason_for_rejection` and
 * included in the emitted AuditEvent payload for regulatory traceability.
 *
 * Per brief.md §3 and ADR-005, only a manager (or claims director for reserves
 * > ¥10M) may reject a reserve proposal. That authorisation check is enforced
 * in ReservesService; this DTO only validates the request body shape.
 */
export class RejectReserveDto {
  /**
   * Reason for rejecting the reserve proposal.
   *
   * Must be at least 10 characters to ensure a meaningful rationale is
   * recorded. The reason is immutably stored on the Reserve record and
   * emitted in the AuditEvent payload — it forms part of the audit trail
   * that regulators and actuaries may inspect during JFSA reviews and
   * IFRS17 walk-forwards.
   *
   * Examples of valid rejection reasons:
   *   - "Insufficient supporting documentation provided."
   *   - "Proposed amount exceeds damage assessment by 40%; requires re-survey."
   *   - "Category mismatch — this should be classified as alae, not loss_unpaid."
   */
  @ApiProperty({
    type: String,
    minLength: 10,
    description:
      'Reason for rejecting the reserve proposal. ' +
      'Minimum 10 characters required. ' +
      'Stored immutably on the reserve record and included in the audit event ' +
      'for regulatory and actuarial inspection.',
    example:
      'Proposed amount exceeds the damage assessment report by more than 40%. ' +
      'A revised assessment from a licensed surveyor is required before approval.',
  })
  @IsString()
  @IsNotEmpty({ message: 'reason_for_rejection must not be empty.' })
  @MinLength(10, {
    message:
      'reason_for_rejection must be at least 10 characters. ' +
      'Provide a meaningful rationale for actuarial and regulatory audit purposes.',
  })
  reason_for_rejection!: string;
}