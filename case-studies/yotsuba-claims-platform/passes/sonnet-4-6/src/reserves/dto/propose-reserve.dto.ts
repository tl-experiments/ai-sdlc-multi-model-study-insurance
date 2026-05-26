// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/reserves/dto/propose-reserve.dto.ts
//
// DTO for proposing a reserve change on a claim.
//
// Design reference: design.md §1 Data model (Reserve), §2 API contract
// Brief reference:  brief.md §3 Reserves Management
//
// Validation rules:
//   - category: must be a valid ReserveCategory enum value
//   - proposed_yen: positive integer string (Decimal-safe); represents yen amount
//   - justification: minimum 50 characters (brief.md §3 requirement)
//
// ADR-005: Reserve approval tiers are enforced in ReservesService, not here.
// The DTO only validates shape and basic constraints.
// =============================================================================

import { ApiProperty } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
  Matches,
} from 'class-validator';
import { ReserveCategory } from '@prisma/client';

/**
 * DTO for POST /claims/:id/reserves
 *
 * Proposes a reserve change for a claim. The proposed_yen field is transmitted
 * as a string to avoid JavaScript float precision issues with large yen amounts.
 * ReservesService converts it to a Prisma Decimal before persisting.
 *
 * Justification must be >= 50 characters per brief.md §3 to ensure adequate
 * documentation of reserve changes for actuarial and regulatory review.
 */
export class ProposeReserveDto {
  /**
   * Reserve category — determines how the reserve is classified under IFRS17
   * reporting categories.
   *
   * - loss_paid:    Payments already made on the claim.
   * - loss_unpaid:  Outstanding loss reserve (case reserve); expected future pay.
   * - alae:         Allocated Loss Adjustment Expense — costs tied to this claim.
   * - ulae:         Unallocated Loss Adjustment Expense — overhead allocation.
   */
  @ApiProperty({
    enum: ReserveCategory,
    description:
      'Reserve category per IFRS17 / JFSA classification. ' +
      'One of: loss_paid, loss_unpaid, alae, ulae.',
    example: 'loss_unpaid',
  })
  @IsEnum(ReserveCategory, {
    message:
      'category must be one of: loss_paid, loss_unpaid, alae, ulae.',
  })
  @IsNotEmpty()
  category!: ReserveCategory;

  /**
   * Proposed reserve amount in Japanese Yen (整数; integer yen, no decimals).
   *
   * Transmitted as a string to preserve precision for large amounts
   * (e.g. ¥100,000,000+). Must be a non-negative integer string.
   *
   * Approval tiers (ADR-005, enforced in ReservesService):
   *   ≤ ¥1,000,000   — no approval required
   *   ≤ ¥10,000,000  — manager approval required
   *   > ¥10,000,000  — claims-director approval required
   *
   * JFSA threshold (brief.md §3): any change > ¥100,000,000 triggers a
   * NotificationToRegulator event for daily JFSA reporting.
   */
  @ApiProperty({
    type: String,
    description:
      'Proposed reserve amount in Japanese Yen. ' +
      'Passed as a string to avoid float precision loss. ' +
      'Must be a non-negative integer (whole yen; no sen). ' +
      'Example: "5000000" for ¥5,000,000.',
    example: '5000000',
  })
  @IsString()
  @IsNotEmpty({ message: 'proposed_yen must not be empty.' })
  @Matches(/^\d+$/, {
    message:
      'proposed_yen must be a non-negative integer string representing whole yen ' +
      '(e.g. "1000000" for ¥1,000,000). Decimal points and negative values are not allowed.',
  })
  proposed_yen!: string;

  /**
   * Justification for the reserve change.
   *
   * Minimum 50 characters required (brief.md §3) to ensure adequate
   * documentation for actuarial review and JFSA regulatory inspection.
   * Free text; stored as-is. Consider including: damage assessment basis,
   * supporting evidence references, and estimated settlement timeline.
   */
  @ApiProperty({
    type: String,
    minLength: 50,
    description:
      'Justification for the reserve change. ' +
      'Minimum 50 characters required for actuarial and regulatory documentation. ' +
      'Should include the basis for the estimate, supporting evidence, ' +
      'and expected settlement timeline.',
    example:
      'Initial structural assessment report received from licensed surveyor. ' +
      'Estimated repair cost based on three contractor quotes. ' +
      'Reserve set to cover highest quote plus 10% contingency.',
  })
  @IsString()
  @IsNotEmpty({ message: 'justification must not be empty.' })
  @MinLength(50, {
    message:
      'justification must be at least 50 characters. ' +
      'Provide adequate documentation for actuarial and regulatory review.',
  })
  justification!: string;

  /**
   * Optional prior reserve amount in yen (for change-tracking display).
   *
   * If provided, ReservesService stores this as `prior_yen` on the Reserve
   * record for walk-forward analysis and IFRS17 reconciliation.
   * If omitted, ReservesService will look up the most recent approved reserve
   * for this claim + category to populate prior_yen automatically.
   */
  @ApiProperty({
    type: String,
    required: false,
    description:
      'Prior reserve amount in yen, for explicit walk-forward documentation. ' +
      'If omitted, the service derives this from the last approved reserve record. ' +
      'Must be a non-negative integer string if provided.',
    example: '3000000',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, {
    message:
      'prior_yen must be a non-negative integer string if provided.',
  })
  prior_yen?: string;
}