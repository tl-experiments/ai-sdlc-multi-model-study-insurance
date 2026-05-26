// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/reserves/reserves-jfsa.service.ts
//
// JFSA threshold notification producer.
//
// Design reference: design.md §1 Data model (NotificationToRegulator),
//                   design.md §2 API contract, design.md §3 Module structure
// Brief reference:  brief.md §3 Reserves Management — JFSA threshold notification
//
// ADR-006: Reserve service emits NotificationToRegulator rows synchronously
// when a single reserve change crosses ¥100,000,000. A (future) daily batch
// job aggregates and flushes to the JFSA regulatory wire. This service
// captures the event shape — the regulatory wire format is Track B.
//
// JFSA threshold: ¥100,000,000 (one hundred million yen)
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../prisma.service';

/**
 * Threshold above which a single reserve change triggers a JFSA notification
 * event (brief.md §3: "any single reserve change crossing ¥100M").
 *
 * Encoded as a named constant per design.md §6 (regulatory thresholds as
 * policy, not magic numbers).
 */
export const JFSA_NOTIFICATION_THRESHOLD_YEN = BigInt(100_000_000);

/**
 * The kind string stored on NotificationToRegulator rows.
 * Stable identifier used by the (Track B) daily flush job to select records.
 */
export const JFSA_RESERVE_THRESHOLD_KIND = 'jfsa_reserve_threshold' as const;

/**
 * Result returned from `maybeEmit` so callers can log / respond accordingly.
 */
export interface JfsaEmitResult {
  /** Whether a notification record was created. */
  emitted: boolean;
  /** The new NotificationToRegulator row id, if emitted. */
  notification_id?: string;
  /** The amount that triggered the threshold, for logging. */
  amount_yen?: bigint;
}

/**
 * ReservesJfsaService
 *
 * Responsible for detecting when a proposed reserve amount crosses the
 * ¥100M JFSA notification threshold and creating an immutable
 * NotificationToRegulator record in the database.
 *
 * Called synchronously from ReservesService after a Reserve row is created,
 * so the notification event is captured in the same request lifecycle as the
 * reserve proposal. No external I/O; pure database write.
 *
 * Per ADR-006, this service does NOT send anything to JFSA — it only
 * persists the event record. The daily batch runner (Track B) is responsible
 * for aggregating pending records and flushing the regulatory wire payload.
 */
@Injectable()
export class ReservesJfsaService {
  private readonly logger = new Logger(ReservesJfsaService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Evaluate whether a reserve amount crosses the JFSA notification threshold
   * and, if so, persist a NotificationToRegulator record.
   *
   * @param claimId   - The claim the reserve belongs to.
   * @param reserveId - The newly created Reserve row id.
   * @param proposedYen - The proposed reserve amount as a Prisma Decimal.
   * @param correlationId - Correlation ID from the originating request,
   *                        for log traceability (design.md §6).
   * @returns JfsaEmitResult indicating whether a notification was emitted.
   *
   * This method is intentionally infallible from the caller's perspective:
   * errors are caught and logged rather than re-thrown, so a JFSA
   * notification failure never blocks the reserve proposal workflow.
   * The caller may inspect `emitted` to log a warning if desired.
   */
  async maybeEmit(
    claimId: string,
    reserveId: string,
    proposedYen: Decimal,
    correlationId: string,
  ): Promise<JfsaEmitResult> {
    try {
      const amountBigInt = BigInt(proposedYen.toFixed(0));

      if (amountBigInt < JFSA_NOTIFICATION_THRESHOLD_YEN) {
        // Below threshold — no notification required.
        return { emitted: false };
      }

      this.logger.warn(
        {
          claim_id: claimId,
          reserve_id: reserveId,
          amount_yen: amountBigInt.toString(),
          threshold_yen: JFSA_NOTIFICATION_THRESHOLD_YEN.toString(),
          correlation_id: correlationId,
        },
        'JFSA reserve threshold crossed — creating NotificationToRegulator record',
      );

      const notification = await this.prisma.notificationToRegulator.create({
        data: {
          kind: JFSA_RESERVE_THRESHOLD_KIND,
          claim_id: claimId,
          reserve_id: reserveId,
          // Prisma Decimal column; pass through the Decimal directly.
          amount_yen: proposedYen,
          // triggered_at defaults to now() via Prisma schema default.
          // sent_at remains null until the Track B daily flush batch runs.
        },
      });

      this.logger.log(
        {
          notification_id: notification.id,
          claim_id: claimId,
          reserve_id: reserveId,
          amount_yen: amountBigInt.toString(),
          correlation_id: correlationId,
        },
        'NotificationToRegulator record created for JFSA daily batch',
      );

      return {
        emitted: true,
        notification_id: notification.id,
        amount_yen: amountBigInt,
      };
    } catch (error) {
      // Per ADR-006: notification failure is logged but must not block the
      // reserve proposal. A monitoring alert on this log line is Track B.
      this.logger.error(
        {
          claim_id: claimId,
          reserve_id: reserveId,
          correlation_id: correlationId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to create JFSA NotificationToRegulator record — ' +
          'reserve proposal is NOT rolled back; manual remediation required',
      );

      // Return non-emitted so callers can observe and log the failure.
      return { emitted: false };
    }
  }

  /**
   * Retrieve all pending (unsent) JFSA notifications.
   *
   * Used by GET /notifications/jfsa-pending (auditor-only endpoint).
   * Returns records where `sent_at` is null, ordered by `triggered_at` asc
   * so the daily batch processes oldest-first.
   *
   * @param limit  - Maximum records to return (default 100; prevents unbounded
   *                 responses if the batch runner falls behind).
   * @param offset - Pagination offset.
   */
  async getPendingNotifications(
    limit = 100,
    offset = 0,
  ): Promise<
    {
      id: string;
      kind: string;
      claim_id: string;
      reserve_id: string;
      amount_yen: Decimal;
      triggered_at: Date;
      sent_at: Date | null;
    }[]
  > {
    return this.prisma.notificationToRegulator.findMany({
      where: { sent_at: null },
      orderBy: { triggered_at: 'asc' },
      take: limit,
      skip: offset,
    });
  }

  /**
   * Mark a batch of notification records as sent.
   *
   * Called by the Track B daily flush job after successfully transmitting
   * the JFSA regulatory payload. Sets `sent_at` to now() on each record.
   *
   * Not exposed via HTTP in Track A — included here so the Track B batch
   * runner has a clean service method to call without needing to reach into
   * PrismaService directly.
   *
   * @param ids - Array of NotificationToRegulator row ids to mark sent.
   * @returns Count of rows updated.
   */
  async markSent(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;

    const result = await this.prisma.notificationToRegulator.updateMany({
      where: { id: { in: ids }, sent_at: null },
      data: { sent_at: new Date() },
    });

    this.logger.log(
      { ids, updated_count: result.count },
      'JFSA notifications marked as sent',
    );

    return result.count;
  }

  /**
   * Check whether the given amount crosses the JFSA notification threshold.
   *
   * Pure utility — no I/O. Exposed for use in unit tests and for ReservesService
   * to pre-check before calling maybeEmit (avoids unnecessary DB round-trips
   * in the >¥100M case where we know we'll emit).
   *
   * @param proposedYen - Amount as a Prisma Decimal.
   * @returns true if amount >= JFSA_NOTIFICATION_THRESHOLD_YEN.
   */
  isAboveThreshold(proposedYen: Decimal): boolean {
    return BigInt(proposedYen.toFixed(0)) >= JFSA_NOTIFICATION_THRESHOLD_YEN;
  }
}