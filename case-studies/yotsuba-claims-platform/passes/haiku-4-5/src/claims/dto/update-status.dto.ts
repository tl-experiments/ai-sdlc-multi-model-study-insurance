import {
  IsString,
  IsEnum,
  ValidateIf,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ClaimStatus } from '@prisma/client';

/**
 * DTO for updating a claim's status via the state machine.
 *
 * This DTO is used when an adjuster or manager transitions a claim through
 * the workflow: intake → under_investigation → awaiting_reserve_approval →
 * settlement_offered → closed_paid | closed_denied | reopened.
 *
 * Validation rules:
 *   - to: required, must be a valid ClaimStatus enum value
 *   - reason: required, non-empty string (>= 10 chars) explaining the transition
 *
 * State machine enforcement:
 *   The claims.service.ts applies the finite-state machine defined in
 *   claims-status.fsm.ts to validate that the requested transition is legal.
 *   If the transition is illegal, the service returns a 422 Unprocessable Entity
 *   with a reason explaining why the transition was rejected.
 *
 * Audit trail:
 *   Every status transition emits an AuditEvent with action='claim.status.changed',
 *   capturing the actor, the from/to states, and the reason.
 *
 * Usage:
 *   const dto = new UpdateStatusDto();
 *   dto.to = ClaimStatus.under_investigation;
 *   dto.reason = 'Initial investigation commenced by adjuster';
 *   await claimsService.updateStatus(claimId, dto, user);
 */
export class UpdateStatusDto {
  /**
   * Target status for the claim.
   * Must be a valid ClaimStatus enum value.
   * The state machine will validate whether the transition from the current
   * status to this target status is legal.
   */
  @IsEnum(ClaimStatus)
  to: ClaimStatus;

  /**
   * Reason for the status transition.
   * Required; must be a non-empty string of at least 10 characters.
   * Provides audit trail context for why the transition was made.
   * Examples:
   *   - 'Initial investigation commenced by adjuster'
   *   - 'Awaiting reserve approval from manager'
   *   - 'Settlement offer prepared and sent to claimant'
   *   - 'Claim denied due to policy exclusion'
   *   - 'Claim reopened per claimant appeal'
   */
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason: string;
}