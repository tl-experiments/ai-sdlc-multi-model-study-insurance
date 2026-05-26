// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/claims/dto/assign-claim.dto.ts
//
// DTO for the POST /claims/:id/assign endpoint.
//
// Allows a manager to assign or re-assign a claim to an adjuster in their
// reports pool (brief.md §2 role matrix). The adjuster_id is validated as
// a non-empty string; existence and pool-membership checks are performed
// in the service layer against the User table.
//
// Role constraints (brief.md §2 role matrix):
//   - manager only — enforced by RolesGuard in the controller.
//   - The target adjuster must be in the manager's reports pool — enforced
//     in claims.service.ts, not here.
//
// Audit:
//   - Every successful assignment emits an AuditEvent with action
//     'claim.assigned' (or 'claim.reassigned' when the claim already has
//     an assigned adjuster). The reason_for_reassignment is included in
//     the audit event payload.
// =============================================================================

import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

export class AssignClaimDto {
  /**
   * CUID of the adjuster to assign the claim to.
   *
   * The target user must:
   *   1. Exist in the User table.
   *   2. Have role = 'adjuster'.
   *   3. Be in the assigning manager's reports pool
   *      (user.reports_to_id === manager.id).
   *
   * These checks are performed in claims.service.ts, not here.
   */
  @ApiProperty({
    description:
      'CUID of the adjuster to assign this claim to. ' +
      'The adjuster must exist, have role adjuster, and belong to the ' +
      'assigning manager\'s reports pool. Pool-membership and existence ' +
      'checks are enforced in the service layer.',
    example: 'clx1a2b3c4d5e6f7g8h9i0j1k',
  })
  @IsString()
  @IsNotEmpty({ message: 'adjuster_id must not be empty.' })
  adjuster_id!: string;

  /**
   * Optional reason for the re-assignment.
   *
   * When the claim already has an assigned_adjuster_id that differs from
   * adjuster_id, this field explains why the claim is being moved. It is
   * persisted in the audit event payload as 'reason_for_reassignment'.
   *
   * Not required for first-time assignments (where assigned_adjuster_id
   * is currently null), but strongly recommended for re-assignments to
   * maintain the full audit trail.
   *
   * Minimum 5 characters when provided to prevent empty / whitespace-only
   * entries.
   */
  @ApiPropertyOptional({
    description:
      'Reason for re-assigning the claim. Persisted in the immutable audit ' +
      'event (ADR-002) so that the full assignment history is reconstructible. ' +
      'Recommended for all re-assignments; not required for initial assignments ' +
      'where the claim has no current assignee. Minimum 5 characters when supplied.',
    example: '担当者が長期休暇のため、代理担当者へ引き継ぎます。',
    minLength: 5,
    maxLength: 1024,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'reason_for_reassignment must not be blank when provided.' })
  @MinLength(5, {
    message: 'reason_for_reassignment must be at least 5 characters when provided.',
  })
  @MaxLength(1024)
  reason_for_reassignment?: string;
}