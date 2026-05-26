// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// JFSA notification producer — emits `NotificationToRegulator` rows
// when a reserve change crosses the regulatory threshold.
//
// The brief specifies (Module 3 — Reserves Management):
//
//   * "any single reserve change crossing ¥100M triggers an
//     asynchronous notification record (`NotificationToRegulator`)
//     earmarked for daily JFSA reporting. Captured as an event;
//     not actually sent in POC."
//
// ADR-006 (design.md §4) further specifies:
//
//   * the producer writes synchronously when the threshold is
//     crossed;
//   * a (future) daily job aggregates and flushes by setting
//     `sent_at`;
//   * the wire format to JFSA is Track B — we capture only the
//     event shape here.
//
// What does "crossing" mean? The brief says "any single reserve
// change crossing ¥100M". We interpret that as: the *proposed*
// reserve figure is at or above ¥100,000,000 (i.e. a reserve being
// *set* at or above the threshold is notification-worthy,
// regardless of the prior value). This is the conservative reading
// — it includes both step-ups across the threshold and reserves
// that start above it. The threshold itself is a named constant
// (per design.md §6) so it is reviewable in one place.
//
// The producer is invoked from `reserves.service.ts` at two
// distinct points: on initial *proposal* (so auditors can see
// pending high-value reserves) and on *approval* (the actual
// regulatory-significant moment). We expose two methods so the
// caller is explicit about which event it is recording; both
// share the same `NotificationToRegulator` shape, distinguished
// by the `kind` string.
// ─────────────────────────────────────────────────────────────────────────

import { Injectable, Logger } from '@nestjs/common';
import { NotificationToRegulator, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma.service';

/**
 * The JFSA single-reserve-change notification threshold, in whole
 * yen. The brief sets this at ¥100,000,000 (¥100M). Encoded as a
 * named constant (per design.md §6 — "regulatory thresholds
 * encoded as policy, not magic numbers").
 */
export const JFSA_RESERVE_NOTIFICATION_THRESHOLD_YEN = new Prisma.Decimal(
  '100000000',
);

/**
 * The `kind` discriminator on `NotificationToRegulator.kind`.
 * Stable string — auditors and downstream batch jobs filter on
 * this value. New notification kinds (e.g. catastrophe-event
 * aggregate) will use distinct constants in Track B.
 */
export const JFSA_RESERVE_THRESHOLD_KIND = 'jfsa_reserve_threshold';

/**
 * Producer for `NotificationToRegulator` rows triggered by the
 * reserves workflow. See file header and ADR-006 for the full
 * rationale.
 */
@Injectable()
export class ReservesJfsaService {
  private readonly logger = new Logger(ReservesJfsaService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Predicate: does `amount_yen` meet or exceed the JFSA
   * notification threshold? Pure function; exported for use by
   * tests and by `reserves.service.ts` when it wants to short-
   * circuit before incurring a DB write.
   */
  static crossesThreshold(amount_yen: Prisma.Decimal): boolean {
    // `Decimal.cmp` returns -1 / 0 / 1; >= 0 means at-or-above.
    return amount_yen.cmp(JFSA_RESERVE_NOTIFICATION_THRESHOLD_YEN) >= 0;
  }

  /**
   * Record a JFSA-pending notification for a reserve that has
   * crossed (or sits above) the threshold. Idempotent at the
   * caller's discretion — the schema does not enforce uniqueness
   * on `(reserve_id, kind)` because the lifecycle deliberately
   * emits one row at proposal time and one at approval time
   * (different `triggered_at`, same `reserve_id`). Auditors can
   * reconstruct the chain from `triggered_at`.
   *
   * Returns `null` if the amount does not cross the threshold —
   * callers can therefore invoke unconditionally and let the
   * predicate gate the write. This keeps the call sites in
   * `reserves.service.ts` uncluttered by threshold-checking
   * conditionals.
   */
  async recordIfThresholdCrossed(args: {
    claim_id: string;
    reserve_id: string;
    amount_yen: Prisma.Decimal;
    /**
     * Optional discriminator suffix appended to the `kind` field
     * so that proposal vs. approval events are distinguishable
     * in the notifications table. Defaults to the bare
     * `jfsa_reserve_threshold` kind for backwards-readability.
     */
    stage?: 'proposed' | 'approved';
  }): Promise<NotificationToRegulator | null> {
    if (!ReservesJfsaService.crossesThreshold(args.amount_yen)) {
      return null;
    }

    const kind =
      args.stage === undefined
        ? JFSA_RESERVE_THRESHOLD_KIND
        : `${JFSA_RESERVE_THRESHOLD_KIND}.${args.stage}`;

    const row = await this.prisma.notificationToRegulator.create({
      data: {
        kind,
        claim_id: args.claim_id,
        reserve_id: args.reserve_id,
        amount_yen: args.amount_yen,
        // `sent_at` is intentionally left null; the daily batch
        // job (Track B) is the sole writer of that column.
      },
    });

    // Structured log — Pino picks up the keys for correlation.
    // We log the amount as a string so that downstream log
    // aggregators do not coerce a 15-digit decimal through a JS
    // number and lose precision.
    this.logger.warn(
      {
        event: 'jfsa.notification.recorded',
        notification_id: row.id,
        claim_id: args.claim_id,
        reserve_id: args.reserve_id,
        amount_yen: args.amount_yen.toString(),
        kind,
      },
      'JFSA reserve threshold crossed; notification queued for daily flush.',
    );

    return row;
  }

  /**
   * List notifications that have not yet been flushed to the
   * (future) JFSA wire-format batch. Used by
   * `GET /notifications/jfsa-pending` (auditor-only). Ordered
   * oldest-first so the auditor sees the longest-pending event
   * at the top — the operational expectation is that nothing
   * lingers beyond one business day.
   */
  async listPending(): Promise<NotificationToRegulator[]> {
    return this.prisma.notificationToRegulator.findMany({
      where: { sent_at: null },
      orderBy: { triggered_at: 'asc' },
    });
  }
}