import { IsString, IsEnum, MinLength, MaxLength } from 'class-validator';
import { ReserveCategory } from '@prisma/client';

/**
 * DTO for rejecting a reserve proposal.
 *
 * Reserves are money set aside against expected payout. This DTO captures
 * the rejection of a reserve proposal, including the reason for rejection.
 * Only managers (and claims directors for their own rejections) can reject
 * reserve proposals.
 *
 * Validation:
 *   - reason_for_rejection: required, must be >= 20 characters (substantive reasoning)
 *
 * Audit:
 *   - Rejection is recorded with rejected_by_id, rejected_at, approval_status='rejected'
 *   - Emits AuditEvent with action='reserve.rejected'
 *
 * Workflow:
 *   - Reserve proposal starts in approval_status='pending'
 *   - Manager can approve (if ≤¥10M) or reject
 *   - Claims director can approve (if >¥10M) or reject
 *   - Once rejected, the proposal cannot be re-approved; a new proposal must be created
 */
export class RejectReserveDto {
  /**
   * Reason for rejecting the reserve proposal.
   *
   * Must be at least 20 characters to ensure substantive reasoning.
   * Examples:
   *   - "Insufficient medical evidence; awaiting specialist report"
   *   - "Third-party liability assessment incomplete; legal review pending"
   *   - "Loss amount appears overstated; recommend re-evaluation after investigation"
   *
   * @example "Insufficient medical evidence; awaiting specialist report"
   */
  @IsString({ message: 'reason_for_rejection must be a string' })
  @MinLength(20, {
    message: 'reason_for_rejection must be at least 20 characters',
  })
  @MaxLength(2000, {
    message: 'reason_for_rejection must not exceed 2000 characters',
  })
  reason_for_rejection: string;
}