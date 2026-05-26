// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// IFRS17 reserve export aggregator — `GET /reserves/export?period=YYYY-MM`.
//
// The brief specifies (Module 3 — Reserves Management):
//
//   * "IFRS17 export hook — `GET /reserves/export?period=YYYY-MM`
//     returns reserve aggregates by category for the actuarial
//     pipeline. Format: tabular JSON suitable for downstream
//     IFRS17 calculation. (No actual IFRS17 calculation; just the
//     data export shape.)"
//
// design.md §6 further notes that currency is `Decimal` end-to-end
// — no JS `number` for yen anywhere in the stack. The aggregator
// therefore returns yen as decimal strings; downstream actuarial
// tooling will parse with arbitrary-precision libraries.
//
// What does "aggregate by category" mean in IFRS17 context? The
// four reserve buckets (`loss_paid`, `loss_unpaid`, `alae`, `ulae`)
// are the IFRS17-aligned categories (ADR-005). For a given
// reporting period (a calendar month, per the `YYYY-MM` query
// parameter), the export reports — per category — :
//
//   * `count` — number of distinct reserve rows in the period;
//   * `claim_count` — number of distinct claims touched in the period;
//   * `proposed_total_yen` — sum of `proposed_yen` across all rows;
//   * `approved_total_yen` — sum of `proposed_yen` across rows whose
//     `approval_status = 'approved'` and whose `approved_at` falls
//     in the period;
//   * `pending_total_yen` — sum across rows still `pending` as of
//     period end;
//   * `rejected_total_yen` — sum across rows whose
//     `approval_status = 'rejected'` in the period.
//
// The walk-forward delta (closing minus opening reserve) is left
// to the downstream IFRS17 calculator: this layer publishes the
// raw aggregates, not the actuarial arithmetic. That separation is
// deliberate — ADR-006's framing ("no false credibility about
// wire-format compliance") applies equally here.
//
// The `proposed_at` column is the inclusion filter for proposal-
// side aggregates (`count`, `claim_count`, `proposed_total_yen`,
// `pending_total_yen`); `approved_at` and the rejection timestamp
// (captured via `approved_at` being null and `approval_status =
// 'rejected'` — we use `proposed_at` as the rejection time-anchor
// since the schema does not carry a distinct `rejected_at`) drive
// the approval/rejection sub-aggregates.
// ─────────────────────────────────────────────────────────────────────────

import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, ReserveCategory } from '@prisma/client';

import { PrismaService } from '../prisma.service';

/**
 * The four IFRS17-aligned reserve categories, in canonical order.
 * Mirrors the Prisma enum but pinned here so the export shape is
 * stable even if the enum is re-ordered in a future migration.
 */
const RESERVE_CATEGORIES: readonly ReserveCategory[] = [
  'loss_paid',
  'loss_unpaid',
  'alae',
  'ulae',
];

/**
 * Per-category aggregate row in the export payload. Yen totals
 * are serialised as decimal strings to preserve the precision of
 * the underlying `Decimal(15,0)` column across the JSON boundary.
 */
export interface ReserveExportCategoryRow {
  category: ReserveCategory;
  count: number;
  claim_count: number;
  proposed_total_yen: string;
  approved_total_yen: string;
  pending_total_yen: string;
  rejected_total_yen: string;
}

/**
 * The full export envelope. The `period` echoes the requested
 * `YYYY-MM`; `period_start` / `period_end` are ISO-8601 timestamps
 * of the half-open interval `[start, end)` so downstream tools
 * have an unambiguous window definition.
 */
export interface ReserveExportPayload {
  period: string;
  period_start: string;
  period_end: string;
  generated_at: string;
  categories: ReserveExportCategoryRow[];
  totals: {
    count: number;
    claim_count: number;
    proposed_total_yen: string;
    approved_total_yen: string;
    pending_total_yen: string;
    rejected_total_yen: string;
  };
}

/**
 * Aggregator for the IFRS17 export. See file header for the full
 * rationale on the shape and the choice of time anchors.
 */
@Injectable()
export class ReservesExportService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Parse a `YYYY-MM` string into the half-open `[start, end)`
   * UTC interval that anchors the export. Rejects malformed
   * input with a 400-mappable exception so the controller does
   * not need its own validator. We use UTC deliberately: the
   * actuarial pipeline runs on UTC boundaries to avoid the
   * JST-vs-UTC ambiguity that haunts month-end batches at
   * Japanese carriers.
   */
  static parsePeriod(period: string): { start: Date; end: Date } {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
      throw new BadRequestException(
        "period must be a 'YYYY-MM' string (e.g. '2024-03').",
      );
    }
    const [yearStr, monthStr] = period.split('-');
    const year = Number.parseInt(yearStr, 10);
    const month = Number.parseInt(monthStr, 10); // 1-12

    const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
    // Month-end: first instant of the following month.
    const end = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));

    return { start, end };
  }

  /**
   * Build the export payload for the given `YYYY-MM` period.
   * Returns category rows in canonical order plus a top-level
   * totals roll-up so downstream tools can sanity-check the
   * per-category arithmetic without re-summing.
   */
  async export(period: string): Promise<ReserveExportPayload> {
    const { start, end } = ReservesExportService.parsePeriod(period);

    const categoryRows: ReserveExportCategoryRow[] = [];
    for (const category of RESERVE_CATEGORIES) {
      categoryRows.push(
        await this.aggregateCategory(category, start, end),
      );
    }

    // Roll up the per-category rows into a single totals object.
    // We sum as `Prisma.Decimal` to preserve precision, then
    // serialise to string at the boundary.
    const totals = categoryRows.reduce(
      (acc, row) => {
        acc.count += row.count;
        acc.claim_count += row.claim_count;
        acc.proposed_total_yen = acc.proposed_total_yen.add(
          row.proposed_total_yen,
        );
        acc.approved_total_yen = acc.approved_total_yen.add(
          row.approved_total_yen,
        );
        acc.pending_total_yen = acc.pending_total_yen.add(
          row.pending_total_yen,
        );
        acc.rejected_total_yen = acc.rejected_total_yen.add(
          row.rejected_total_yen,
        );
        return acc;
      },
      {
        count: 0,
        // `claim_count` summed across categories is an upper bound
        // (a single claim may have reserves in multiple
        // categories). The downstream IFRS17 layer treats this
        // total as informational; the per-category counts are the
        // authoritative figures.
        claim_count: 0,
        proposed_total_yen: new Prisma.Decimal(0),
        approved_total_yen: new Prisma.Decimal(0),
        pending_total_yen: new Prisma.Decimal(0),
        rejected_total_yen: new Prisma.Decimal(0),
      },
    );

    return {
      period,
      period_start: start.toISOString(),
      period_end: end.toISOString(),
      generated_at: new Date().toISOString(),
      categories: categoryRows,
      totals: {
        count: totals.count,
        claim_count: totals.claim_count,
        proposed_total_yen: totals.proposed_total_yen.toFixed(0),
        approved_total_yen: totals.approved_total_yen.toFixed(0),
        pending_total_yen: totals.pending_total_yen.toFixed(0),
        rejected_total_yen: totals.rejected_total_yen.toFixed(0),
      },
    };
  }

  /**
   * Build the aggregate row for a single category over the
   * `[start, end)` window. Kept as a private helper to keep
   * `export()` readable; each sub-aggregate is its own Prisma
   * call so the SQL planner can pick the right index per query.
   */
  private async aggregateCategory(
    category: ReserveCategory,
    start: Date,
    end: Date,
  ): Promise<ReserveExportCategoryRow> {
    // Proposal-side aggregate: every reserve row whose
    // `proposed_at` falls in the period, regardless of approval
    // status. This is the denominator-ish figure auditors expect.
    const proposedAgg = await this.prisma.reserve.aggregate({
      where: {
        category,
        proposed_at: { gte: start, lt: end },
      },
      _sum: { proposed_yen: true },
      _count: { _all: true },
    });

    // Distinct claims touched in the period for this category.
    // `findMany` + `distinct` is the portable way; the row count
    // is small in practice and the `(claim_id, proposed_at)`
    // index covers the lookup.
    const distinctClaims = await this.prisma.reserve.findMany({
      where: {
        category,
        proposed_at: { gte: start, lt: end },
      },
      distinct: ['claim_id'],
      select: { claim_id: true },
    });

    // Approval-side aggregate: rows approved within the period.
    // We anchor on `approved_at` (not `proposed_at`) because the
    // IFRS17-relevant moment is the approval, not the proposal.
    const approvedAgg = await this.prisma.reserve.aggregate({
      where: {
        category,
        approval_status: 'approved',
        approved_at: { gte: start, lt: end },
      },
      _sum: { proposed_yen: true },
    });

    // Pending aggregate: rows still pending as of period end.
    // "As of period end" means `proposed_at < end` and the row
    // is still in `pending` state at query time. For a closed
    // period this is a stable figure; for the current period it
    // is a snapshot.
    const pendingAgg = await this.prisma.reserve.aggregate({
      where: {
        category,
        approval_status: 'pending',
        proposed_at: { gte: start, lt: end },
      },
      _sum: { proposed_yen: true },
    });

    // Rejected aggregate: rows whose `approval_status =
    // 'rejected'` and whose `proposed_at` falls in the period.
    // The schema does not carry a distinct `rejected_at` column,
    // so `proposed_at` is the closest available time anchor.
    const rejectedAgg = await this.prisma.reserve.aggregate({
      where: {
        category,
        approval_status: 'rejected',
        proposed_at: { gte: start, lt: end },
      },
      _sum: { proposed_yen: true },
    });

    return {
      category,
      count: proposedAgg._count._all,
      claim_count: distinctClaims.length,
      proposed_total_yen: decimalToYenString(proposedAgg._sum.proposed_yen),
      approved_total_yen: decimalToYenString(approvedAgg._sum.proposed_yen),
      pending_total_yen: decimalToYenString(pendingAgg._sum.proposed_yen),
      rejected_total_yen: decimalToYenString(rejectedAgg._sum.proposed_yen),
    };
  }
}

/**
 * Normalise a (possibly-null) `Prisma.Decimal` sum into the
 * canonical zero-decimal yen string. Yen are an indivisible unit
 * — `toFixed(0)` strips any fractional artefact that might creep
 * in from a downstream `Decimal` operation, even though the
 * source column is `Decimal(15,0)`.
 */
function decimalToYenString(value: Prisma.Decimal | null): string {
  if (value === null || value === undefined) {
    return '0';
  }
  return value.toFixed(0);
}