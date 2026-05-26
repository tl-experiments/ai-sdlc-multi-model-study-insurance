import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Decimal } from '@prisma/client/runtime/library';

/**
 * ReservesExportService
 *
 * Handles IFRS17-ready reserve aggregation and export for downstream actuarial
 * and financial reporting pipelines.
 *
 * Context:
 *   - IFRS17 requires reserve data aggregated by category (loss_paid, loss_unpaid, alae, ulae)
 *   - This service exports reserve aggregates for a given period in a tabular JSON format
 *   - The POC captures the data export shape; actual IFRS17 calculation is Track B
 *   - Aggregates include only approved reserves (approval_status='approved')
 *
 * Categories (IFRS17-aligned):
 *   - loss_paid: paid losses (claims already paid out)
 *   - loss_unpaid: unpaid losses (claims not yet paid)
 *   - alae: allocated loss adjustment expense (adjuster time, investigation costs)
 *   - ulae: unallocated loss adjustment expense (overhead allocation)
 *
 * Export format:
 *   - Tabular JSON with columns: category, count, total_yen, average_yen, min_yen, max_yen
 *   - Suitable for downstream IFRS17 walk-forwards and disclosure preparation
 *   - Period specified as YYYY-MM query parameter
 *
 * Audit:
 *   - Export requests are logged via AuditEvent with action='reserves.export'
 *   - Full audit trail of who requested what data and when
 */
@Injectable()
export class ReservesExportService {
  private readonly logger = new Logger(ReservesExportService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Export reserve aggregates for a given period in IFRS17-ready format.
   *
   * Aggregates approved reserves by category for the specified month.
   * Returns tabular data with count, sum, average, min, max per category.
   *
   * Logic:
   *   - Filter reserves by approval_status='approved'
   *   - Filter by approved_at falling within the period (YYYY-MM)
   *   - Group by category
   *   - Calculate aggregates: count, sum, average, min, max
   *   - Return as array of objects, one per category
   *
   * @param period - YYYY-MM format (e.g. '2024-01')
   * @returns array of reserve aggregates by category
   * @throws Error if period format is invalid
   */
  async exportByPeriod(
    period: string,
  ): Promise<
    Array<{
      category: string;
      count: number;
      total_yen: string;
      average_yen: string;
      min_yen: string;
      max_yen: string;
    }>
  > {
    // Validate period format (YYYY-MM)
    const periodRegex = /^\d{4}-\d{2}$/;
    if (!periodRegex.test(period)) {
      throw new Error(
        `Invalid period format. Expected YYYY-MM, got: ${period}`,
      );
    }

    const [year, month] = period.split('-').map(Number);

    // Validate month range
    if (month < 1 || month > 12) {
      throw new Error(`Invalid month: ${month}. Must be 01-12.`);
    }

    // Calculate start and end of the period
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59, 999);

    this.logger.debug(
      `Exporting reserves for period ${period} (${startDate.toISOString()} to ${endDate.toISOString()})`,
    );

    // Fetch all approved reserves for the period
    const reserves = await this.prisma.reserve.findMany({
      where: {
        approval_status: 'approved',
        approved_at: {
          gte: startDate,
          lte: endDate,
        },
      },
      select: {
        category: true,
        proposed_yen: true,
      },
    });

    // Group by category and calculate aggregates
    const aggregates = new Map<
      string,
      {
        category: string;
        count: number;
        total: Decimal;
        values: Decimal[];
      }
    >();

    for (const reserve of reserves) {
      const category = reserve.category;
      const amount = new Decimal(reserve.proposed_yen);

      if (!aggregates.has(category)) {
        aggregates.set(category, {
          category,
          count: 0,
          total: new Decimal(0),
          values: [],
        });
      }

      const agg = aggregates.get(category)!;
      agg.count += 1;
      agg.total = agg.total.plus(amount);
      agg.values.push(amount);
    }

    // Calculate final aggregates and format for export
    const result = Array.from(aggregates.values()).map((agg) => {
      const average =
        agg.count > 0 ? agg.total.dividedBy(agg.count) : new Decimal(0);
      const sorted = agg.values.sort((a, b) => a.cmp(b));
      const min = sorted.length > 0 ? sorted[0] : new Decimal(0);
      const max = sorted.length > 0 ? sorted[sorted.length - 1] : new Decimal(0);

      return {
        category: agg.category,
        count: agg.count,
        total_yen: agg.total.toString(),
        average_yen: average.toFixed(0),
        min_yen: min.toString(),
        max_yen: max.toString(),
      };
    });

    this.logger.debug(
      `Exported ${result.length} reserve categories for period ${period}`,
    );

    return result;
  }

  /**
   * Export all approved reserves for a claim in IFRS17-ready format.
   *
   * Returns the full reserve history for a claim, aggregated by category.
   * Useful for claim-level IFRS17 disclosure and walk-forward analysis.
   *
   * @param claimId - the claim ID
   * @returns array of reserve aggregates by category for the claim
   */
  async exportByClaim(
    claimId: string,
  ): Promise<
    Array<{
      category: string;
      count: number;
      total_yen: string;
      average_yen: string;
      min_yen: string;
      max_yen: string;
    }>
  > {
    this.logger.debug(`Exporting reserves for claim ${claimId}`);

    // Fetch all approved reserves for the claim
    const reserves = await this.prisma.reserve.findMany({
      where: {
        claim_id: claimId,
        approval_status: 'approved',
      },
      select: {
        category: true,
        proposed_yen: true,
      },
    });

    // Group by category and calculate aggregates
    const aggregates = new Map<
      string,
      {
        category: string;
        count: number;
        total: Decimal;
        values: Decimal[];
      }
    >();

    for (const reserve of reserves) {
      const category = reserve.category;
      const amount = new Decimal(reserve.proposed_yen);

      if (!aggregates.has(category)) {
        aggregates.set(category, {
          category,
          count: 0,
          total: new Decimal(0),
          values: [],
        });
      }

      const agg = aggregates.get(category)!;
      agg.count += 1;
      agg.total = agg.total.plus(amount);
      agg.values.push(amount);
    }

    // Calculate final aggregates and format for export
    const result = Array.from(aggregates.values()).map((agg) => {
      const average =
        agg.count > 0 ? agg.total.dividedBy(agg.count) : new Decimal(0);
      const sorted = agg.values.sort((a, b) => a.cmp(b));
      const min = sorted.length > 0 ? sorted[0] : new Decimal(0);
      const max = sorted.length > 0 ? sorted[sorted.length - 1] : new Decimal(0);

      return {
        category: agg.category,
        count: agg.count,
        total_yen: agg.total.toString(),
        average_yen: average.toFixed(0),
        min_yen: min.toString(),
        max_yen: max.toString(),
      };
    });

    this.logger.debug(
      `Exported ${result.length} reserve categories for claim ${claimId}`,
    );

    return result;
  }

  /**
   * Get the latest approved reserve for a claim.
   *
   * Returns the most recent approved reserve proposal for the claim,
   * useful for current reserve balance queries.
   *
   * @param claimId - the claim ID
   * @returns the latest approved reserve, or null if none exist
   */
  async getLatestApprovedReserve(claimId: string) {
    return this.prisma.reserve.findFirst({
      where: {
        claim_id: claimId,
        approval_status: 'approved',
      },
      orderBy: {
        approved_at: 'desc',
      },
    });
  }

  /**
   * Get total approved reserves across all claims for a given period.
   *
   * Returns the sum of all approved reserves in the period, useful for
   * balance sheet and regulatory reporting.
   *
   * @param period - YYYY-MM format
   * @returns total approved reserves in yen
   */
  async getTotalApprovedReservesByPeriod(period: string): Promise<string> {
    const periodRegex = /^\d{4}-\d{2}$/;
    if (!periodRegex.test(period)) {
      throw new Error(
        `Invalid period format. Expected YYYY-MM, got: ${period}`,
      );
    }

    const [year, month] = period.split('-').map(Number);

    if (month < 1 || month > 12) {
      throw new Error(`Invalid month: ${month}. Must be 01-12.`);
    }

    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59, 999);

    const result = await this.prisma.reserve.aggregate({
      _sum: {
        proposed_yen: true,
      },
      where: {
        approval_status: 'approved',
        approved_at: {
          gte: startDate,
          lte: endDate,
        },
      },
    });

    const total = result._sum.proposed_yen
      ? new Decimal(result._sum.proposed_yen).toString()
      : '0';

    this.logger.debug(
      `Total approved reserves for period ${period}: ¥${total}`,
    );

    return total;
  }
}