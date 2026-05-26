import { IsString, IsNumber, IsEnum, IsOptional, MinLength, MaxLength, IsDecimal } from 'class-validator';
import { ReserveCategory } from '@prisma/client';

/**
 * DTO for proposing a reserve change on a claim.
 *
 * Reserves are money set aside against expected payout. This DTO captures
 * the proposal for a reserve change, including the proposed amount, category,
 * and justification. The proposal is then subject to approval workflow based
 * on thresholds (≤¥1M self-approving, ¥1M–¥10M manager-approve, >¥10M requires
 * claims_director approval).
 *
 * Validation:
 *   - category: required, must be a valid ReserveCategory enum value
 *   - proposed_yen: required, must be a positive integer (no decimals for JPY)
 *   - justification: required, must be >= 50 characters (substantive reasoning)
 *
 * IFRS17 context:
 *   - category field maps to IFRS17 reserve categories:
 *     - loss_paid: paid losses
 *     - loss_unpaid: unpaid losses
 *     - alae: allocated loss adjustment expense
 *     - ulae: unallocated loss adjustment expense
 *
 * JFSA context:
 *   - Any reserve change crossing ¥100M triggers NotificationToRegulator
 *   - Captured asynchronously by reserves.service.ts
 *
 * Audit:
 *   - Proposal is recorded with proposed_by_id, proposed_at, approval_status='pending'
 *   - Emits AuditEvent with action='reserve.proposed'
 */
export class ProposeReserveDto {
  /**
   * Reserve category (IFRS17-aligned).
   *
   * Enum values:
   *   - loss_paid: paid losses (claims already paid out)
   *   - loss_unpaid: unpaid losses (claims not yet paid)
   *   - alae: allocated loss adjustment expense (adjuster time, investigation costs)
   *   - ulae: unallocated loss adjustment expense (overhead allocation)
   *
   * @example "loss_unpaid"
   */
  @IsEnum(ReserveCategory, {
    message: 'category must be one of: loss_paid, loss_unpaid, alae, ulae',
  })
  category: ReserveCategory;

  /**
   * Proposed reserve amount in Japanese Yen (¥).
   *
   * Must be a positive integer (no decimals). Stored as Decimal(15,0) in Postgres
   * to avoid floating-point precision issues with currency.
   *
   * Approval thresholds:
   *   - ≤¥1,000,000: self-approving (no manager approval needed)
   *   - ¥1,000,001–¥10,000,000: requires manager approval
   *   - >¥10,000,000: requires manager + claims_director approval
   *
   * JFSA threshold:
   *   - ¥100,000,000+: triggers NotificationToRegulator
   *
   * @example 5000000
   */
  @IsNumber(
    { allowInfinity: false, allowNaN: false },
    { message: 'proposed_yen must be a valid number' },
  )
  proposed_yen: number;

  /**
   * Justification for the reserve change.
   *
   * Must be at least 50 characters to ensure substantive reasoning.
   * Examples:
   *   - "Medical report received; estimated treatment cost ¥5M over 2 years"
   *   - "Third-party liability assessment; legal counsel estimates ¥10M exposure"
   *   - "Catastrophic event; preliminary loss estimate ¥50M pending full survey"
   *
   * @example "Medical report received; estimated treatment cost ¥5M over 2 years"
   */
  @IsString({ message: 'justification must be a string' })
  @MinLength(50, {
    message: 'justification must be at least 50 characters',
  })
  @MaxLength(2000, {
    message: 'justification must not exceed 2000 characters',
  })
  justification: string;
}