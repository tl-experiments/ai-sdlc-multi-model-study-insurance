// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/claims/dto/update-status.dto.ts
//
// DTO for the PATCH /claims/:id/status endpoint.
//
// Guards the claim workflow state machine (ADR-004). The controller accepts
// a target status and an optional reason, then delegates the transition
// validity check to claims-status.fsm.ts before persisting.
//
// Valid status values are defined by the ClaimStatus enum in the Prisma
// schema. Illegal transitions are rejected with 422 + the FSM's reason.
//
// Role constraints (brief.md §2 role matrix):
//   - adjuster  — may transition assigned claims only
//   - manager   — may transition claims in their reports pool
// These are enforced in the service layer, not here.
// =============================================================================

import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ClaimStatus } from '@prisma/client';

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

export class UpdateStatusDto {
  /**
   * The target status to transition to.
   *
   * Valid workflow transitions (ADR-004 / claims-status.fsm.ts):
   *   intake                  → under_investigation
   *   under_investigation     → awaiting_reserve_approval
   *   under_investigation     → settlement_offered
   *   awaiting_reserve_approval → settlement_offered
   *   settlement_offered      → closed_paid
   *   settlement_offered      → closed_denied
   *   closed_paid             → reopened
   *   closed_denied           → reopened
   *   reopened                → under_investigation
   *
   * Any transition not listed above is illegal and will return 422.
   */
  @ApiProperty({
    description:
      'Target workflow status. The transition must be legal per the claim ' +
      'status FSM (ADR-004). Illegal transitions return 422 with an ' +
      'explanation from the state machine.\n\n' +
      'Valid transitions:\n' +
      '  intake → under_investigation\n' +
      '  under_investigation → awaiting_reserve_approval\n' +
      '  under_investigation → settlement_offered\n' +
      '  awaiting_reserve_approval → settlement_offered\n' +
      '  settlement_offered → closed_paid\n' +
      '  settlement_offered → closed_denied\n' +
      '  closed_paid → reopened\n' +
      '  closed_denied → reopened\n' +
      '  reopened → under_investigation',
    enum: ClaimStatus,
    example: ClaimStatus.under_investigation,
  })
  @IsEnum(ClaimStatus, {
    message: `to must be one of: ${Object.values(ClaimStatus).join(', ')}.`,
  })
  to!: ClaimStatus;

  /**
   * Human-readable reason for the status transition.
   *
   * Required for transitions into awaiting_reserve_approval, settlement_offered,
   * closed_paid, closed_denied, and reopened — i.e. any terminal or gating state.
   * Optional for the intake → under_investigation transition where the
   * action is self-explanatory.
   *
   * When provided, the reason is persisted in the audit event payload so that
   * the full transition history is reconstructible from the audit log alone.
   *
   * Minimum 5 characters when present to prevent empty/whitespace-only entries.
   */
  @ApiPropertyOptional({
    description:
      'Human-readable reason for the state transition. ' +
      'Persisted in the immutable audit event for this transition (ADR-002). ' +
      'Recommended for all transitions; required by business rules for ' +
      'gating states (awaiting_reserve_approval, settlement_offered, ' +
      'closed_paid, closed_denied, reopened). ' +
      'Minimum 5 characters when supplied.',
    example: '現地調査が完了し、損害額の確認ができたため査定に進みます。',
    minLength: 5,
    maxLength: 1024,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'reason must not be blank when provided.' })
  @MinLength(5, { message: 'reason must be at least 5 characters when provided.' })
  @MaxLength(1024)
  reason?: string;
}