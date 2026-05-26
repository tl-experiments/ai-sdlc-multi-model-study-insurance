// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/reserves/reserves-export.service.ts
//
// IFRS17-ready reserve aggregation export service.
//
// Design reference: design.md §1 Data model (Reserve), §2 API contract
//                   GET /reserves/export?period=YYYY-MM
// Brief reference:  brief.md §3 Reserves Management — IFRS17 export hook
//
// This service aggregates approved reserve records by category for a given
// reporting period (calendar month) and returns tabular JSON suitable for
// downstream IFRS17 calculation pipelines.
//
// No actual IFRS17 calculation is performed here — per brief.md §3:
// "No actual IFRS17 calculation; just the data export shape."
//
// ADR-005: Only `approved` reserves are included in export aggregates.
// ADR-006: JFSA notification records are separate from this export.
// =============================================================================

import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { ApprovalStatus, ReserveCategory } from '@prisma/client';
import { PrismaService } from '../prisma.service';

// ---------------------------------------------------------------------------
// Output shape types
// ---------------------------------------------------------------------------

/**
 * Aggregate totals for a single reserve category in the export period.
 */
export interface ReserveCategoryAggregate {
  /** IFRS17 / JFSA reserve classification category. */
  category: ReserveCategory;
  /** Total proposed yen across all approved reserves in the period, as a string. */
  total_proposed_yen: string;
  /** Count of approved reserve records contributing to this aggregate. */
  record_count: number;
  /** Sum of prior_yen for walk-forward reconciliation. */
  total_prior_yen: string;
  /** Net movement (total_proposed_yen - total_prior_yen) for IFRS17 walk-forward. */
  net_movement_yen: string;
}

/**
 * Per-claim reserve breakdown within the export period.
 * Provides claim-level detail alongside the category-level aggregates.
 */
export interface ClaimReserveDetail {
  claim_id: string;
  category: ReserveCategory;
  proposed_yen: string;
  prior_yen: string | null;
  approved_at: Date | null;
  approved_by_id: string | null;
  director_approved_by_id: string | null;
}

/**
 * Top-level IFRS17 export response shape.
 *
 * Designed to be ingested directly by the actuarial IFRS17 calculation
 * pipeline. Contains:
 *   - period: the reporting month
 *   - exported_at: timestamp this payload was generated
 *   - summary: category-level aggregates (the primary IFRS17 input)
 *   - claims_detail: per-claim breakdown for walk-forward reconciliation
 *   - total_reserve_yen: grand total across all categories
 *   - record_count: total approved reserve records in period
 */
export interface Ifrs17ExportPayload {
  /** Reporting period in YYYY-MM format. */
  period: string;
  /** ISO timestamp when this export was generated. */
  exported_at: string;
  /**
   * Category-level aggregates — the primary data input for IFRS17
   * Liability for Remaining Coverage (LRC) and Liability for Incurred
   * Claims (LIC) calculation.
   */
  summary: ReserveCategoryAggregate[];
  /** Per-claim detail for walk-forward reconciliation. */
  claims_detail: ClaimReserveDetail[];
  /** Grand total proposed yen across all categories in the period. */
  total_reserve_yen: string;
  /** Total count of approved reserve records included in this export. */
  record_count: number;
}

// ---------------------------------------------------------------------------
// Period parsing
// ---------------------------------------------------------------------------

/**
 * Parsed representation of a YYYY-MM period query parameter.
 */
interface ParsedPeriod {
  year: number;
  month: number;
  /** Inclusive start — first millisecond of the month (UTC). */
  start: Date;
  /** Exclusive end — first millisecond of the following month (UTC). */
  end: Date;
  /** Normalised string, e.g. "2024-03". */
  label: string;
}

/**
 * Validate and parse a YYYY-MM period string.
 *
 * @param period - Raw query parameter value.
 * @throws BadRequestException if the format is invalid or the date is nonsensical.
 * @returns ParsedPeriod with UTC date boundaries.
 */
function parsePeriod(period: string): ParsedPeriod {
  const PERIOD_REGEX = /^(\d{4})-(0[1-9]|1[0-2])$/;
  const match = PERIOD_REGEX.exec(period.trim());

  if (!match) {
    throw new BadRequestException(
      `Invalid period format "${period}". ` +
        'Expected YYYY-MM (e.g. "2024-03"). ' +
        'Month must be 01–12.',
    );
  }

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);

  // Sanity check: refuse obviously invalid years.
  if (year < 2000 || year > 2100) {
    throw new BadRequestException(
      `Period year ${year} is out of the supported range (2000–2100).`,
    );
  }

  // UTC boundaries: [first day of month 00:00:00Z, first day of next month 00:00:00Z)
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  // Date.UTC handles month overflow (e.g. month=12 → January of year+1) correctly.
  const end = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));

  const label = `${year}-${String(month).padStart(2, '0')}`;

  return { year, month, start, end, label };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * ReservesExportService
 *
 * Aggregates approved reserve records for a given calendar month and returns
 * a structured payload suitable for IFRS17 actuarial pipeline ingestion.
 *
 * Only `approved` reserve records are included. Pending and rejected reserves
 * are excluded — they represent proposed changes that have not been committed
 * to the balance sheet.
 *
 * The `approved_at` timestamp determines which period a reserve record falls
 * into. This matches standard IFRS17 recognition timing (when the liability
 * is acknowledged by an authorised approver, not when it was proposed).
 *
 * Exposed via: GET /reserves/export?period=YYYY-MM (auditor-only).
 */
@Injectable()
export class ReservesExportService {
  private readonly logger = new Logger(ReservesExportService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generate an IFRS17-ready reserve export for the specified period.
   *
   * @param period - Reporting period in YYYY-MM format (e.g. "2024-03").
   *                 Validated and parsed internally.
   * @param correlationId - Correlation ID from the originating request,
   *                        for log traceability (design.md §6).
   * @returns Ifrs17ExportPayload with category aggregates and per-claim detail.
   * @throws BadRequestException if the period format is invalid.
   */
  async exportForPeriod(
    period: string,
    correlationId: string,
  ): Promise<Ifrs17ExportPayload> {
    const parsed = parsePeriod(period);

    this.logger.log(
      {
        period: parsed.label,
        range_start: parsed.start.toISOString(),
        range_end: parsed.end.toISOString(),
        correlation_id: correlationId,
      },
      'Generating IFRS17 reserve export',
    );

    // Fetch all approved reserves where approved_at falls within the period.
    // We include director_approved_at IS NOT NULL check implicitly — any
    // reserve that reached `approved` status has passed all required tiers
    // (ADR-005: ReservesService enforces tier rules before setting approved).
    const records = await this.prisma.reserve.findMany({
      where: {
        approval_status: ApprovalStatus.approved,
        approved_at: {
          gte: parsed.start,
          lt: parsed.end,
        },
      },
      select: {
        id: true,
        claim_id: true,
        category: true,
        proposed_yen: true,
        prior_yen: true,
        approved_at: true,
        approved_by_id: true,
        director_approved_by_id: true,
      },
      orderBy: [
        { category: 'asc' },
        { approved_at: 'asc' },
      ],
    });

    this.logger.log(
      {
        period: parsed.label,
        record_count: records.length,
        correlation_id: correlationId,
      },
      'Retrieved approved reserve records for IFRS17 export',
    );

    // Build category aggregates.
    const summary = this.buildCategoryAggregates(records);

    // Build per-claim detail rows.
    const claims_detail: ClaimReserveDetail[] = records.map((r) => ({
      claim_id: r.claim_id,
      category: r.category,
      proposed_yen: r.proposed_yen.toFixed(0),
      prior_yen: r.prior_yen != null ? r.prior_yen.toFixed(0) : null,
      approved_at: r.approved_at,
      approved_by_id: r.approved_by_id,
      director_approved_by_id: r.director_approved_by_id,
    }));

    // Grand total across all categories.
    const totalBigInt = records.reduce(
      (acc, r) => acc + BigInt(r.proposed_yen.toFixed(0)),
      BigInt(0),
    );

    const payload: Ifrs17ExportPayload = {
      period: parsed.label,
      exported_at: new Date().toISOString(),
      summary,
      claims_detail,
      total_reserve_yen: totalBigInt.toString(),
      record_count: records.length,
    };

    this.logger.log(
      {
        period: parsed.label,
        total_reserve_yen: totalBigInt.toString(),
        category_count: summary.length,
        record_count: records.length,
        correlation_id: correlationId,
      },
      'IFRS17 reserve export completed',
    );

    return payload;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Aggregate reserve records by category.
   *
   * Iterates over the fetched records (already filtered to `approved` status
   * within the period) and computes per-category totals.
   *
   * All arithmetic is done in BigInt to avoid float precision issues with
   * large yen amounts (design.md §6: "Decimal-typed currency end-to-end —
   * no `number` for yen anywhere in the stack").
   *
   * @param records - Approved reserve records for the period.
   * @returns Array of ReserveCategoryAggregate, one entry per category
   *          present in the data. Categories with zero records are omitted.
   */
  private buildCategoryAggregates(
    records: Array<{
      category: ReserveCategory;
      proposed_yen: Decimal;
      prior_yen: Decimal | null;
    }>,
  ): ReserveCategoryAggregate[] {
    // Use a Map keyed by category to accumulate sums.
    type Accumulator = {
      totalProposed: bigint;
      totalPrior: bigint;
      count: number;
    };

    const accMap = new Map<ReserveCategory, Accumulator>();

    for (const record of records) {
      const existing = accMap.get(record.category) ?? {
        totalProposed: BigInt(0),
        totalPrior: BigInt(0),
        count: 0,
      };

      existing.totalProposed += BigInt(record.proposed_yen.toFixed(0));

      // prior_yen may be null if this is the first reserve for the claim+category.
      // Treat null as zero for walk-forward purposes.
      existing.totalPrior +=
        record.prior_yen != null
          ? BigInt(record.prior_yen.toFixed(0))
          : BigInt(0);

      existing.count += 1;

      accMap.set(record.category, existing);
    }

    // Convert accumulated map to sorted array.
    // Sort by category name for deterministic output (important for diff-based
    // IFRS17 walk-forward tooling that compares period exports).
    const categoryOrder: ReserveCategory[] = [
      ReserveCategory.loss_paid,
      ReserveCategory.loss_unpaid,
      ReserveCategory.alae,
      ReserveCategory.ulae,
    ];

    const aggregates: ReserveCategoryAggregate[] = [];

    for (const category of categoryOrder) {
      const acc = accMap.get(category);
      if (!acc) continue; // Skip categories with no records in this period.

      const netMovement = acc.totalProposed - acc.totalPrior;

      aggregates.push({
        category,
        total_proposed_yen: acc.totalProposed.toString(),
        record_count: acc.count,
        total_prior_yen: acc.totalPrior.toString(),
        net_movement_yen: netMovement.toString(),
      });
    }

    return aggregates;
  }
}