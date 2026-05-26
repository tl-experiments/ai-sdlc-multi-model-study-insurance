import {
  IsString,
  IsUUID,
  IsOptional,
  MinLength,
  MaxLength,
} from 'class-validator';

/**
 * DTO for assigning or re-assigning a claim to an adjuster.
 *
 * This DTO is used by managers to assign a claim to an adjuster or to
 * re-assign an already-assigned claim to a different adjuster.
 *
 * Validation rules:
 *   - adjuster_id: required, must be a valid CUID (user ID)
 *   - reason_for_reassignment: optional, non-empty string if provided (>= 10 chars)
 *
 * Authorization:
 *   Only users with the 'manager' role can assign or re-assign claims.
 *   The adjuster_id must reference a valid User with role 'adjuster'.
 *
 * Audit trail:
 *   Every assignment emits an AuditEvent with action='claim.assigned',
 *   capturing the actor (manager), the adjuster_id, and the reason_for_reassignment.
 *
 * Usage:
 *   const dto = new AssignClaimDto();
 *   dto.adjuster_id = 'clm_abc123def456';
 *   dto.reason_for_reassignment = 'Reassigned due to workload balancing';
 *   await claimsService.assignClaim(claimId, dto, manager);
 */
export class AssignClaimDto {
  /**
   * ID of the adjuster to assign the claim to.
   * Must be a valid CUID referencing a User with role 'adjuster'.
   * The assignment is recorded with assigned_at timestamp and assigned_by user ID.
   */
  @IsString()
  @IsUUID()
  adjuster_id: string;

  /**
   * Reason for the assignment or re-assignment (optional).
   * If provided, must be a non-empty string of at least 10 characters.
   * Provides audit trail context for why the assignment was made.
   * Examples:
   *   - 'Reassigned due to workload balancing'
   *   - 'Reassigned to specialist for complex marine cargo claim'
   *   - 'Original adjuster on leave; reassigned to backup'
   *   - 'Escalated to senior adjuster for high-value claim'
   */
  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason_for_reassignment?: string;
}