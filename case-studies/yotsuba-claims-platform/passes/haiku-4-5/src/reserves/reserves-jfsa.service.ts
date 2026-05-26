import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Decimal } from '@prisma/client/runtime/library';

/**
 * ReservesJfsaService
 *
 * Handles JFSA (Japan Financial Services Agency) regulatory notifications
 * triggered by reserve changes crossing thresholds.
 *
 * Context:
 *   - JFSA expects daily notification of reserves crossing ¥100M threshold
 *   - This service emits NotificationToRegulator rows synchronously when threshold crossed
 *   - A (future) daily job aggregates and flushes to regulatory wire format
 *   - The POC captures the event shape; actual JFSA wire format is Track B
 *
 * Thresholds:
 *   - ¥100,000,000 (¥100M): triggers NotificationToRegulator
 *
 * Audit:
 *   - Every notification is immutable; no UPDATE/DELETE pathway
 *   - Notification creation is logged via AuditEvent in the calling service
 */
@Injectable()
export class ReservesJfsaService {
  private readonly logger = new Logger(ReservesJfsaService.name);

  // JFSA threshold: ¥100M
  private readonly JFSA_THRESHOLD_YEN = new Decimal('100000000');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Check if a reserve change crosses the JFSA threshold and emit a notification.
   *
   * Called synchronously after a reserve is proposed or approved. If the proposed
   * amount (or the change from prior reserve) crosses ¥100M, a NotificationToRegulator
   * row is created.
   *
   * Logic:
   *   - If proposed_yen >= ¥100M, emit notification
   *   - If prior_yen exists and (proposed_yen - prior_yen) crosses threshold, emit notification
   *   - Otherwise, no notification
   *
   * @param claimId - the claim ID
   * @param reserveId - the reserve ID
   * @param proposedYen - the proposed reserve amount (Decimal)
   * @param priorYen - the prior reserve amount, if any (Decimal | null)
   * @returns true if notification was emitted, false otherwise
   */
  async checkAndEmitThresholdNotification(
    claimId: string,
    reserveId: string,
    proposedYen: Decimal,
    priorYen: Decimal | null,
  ): Promise<boolean> {
    const proposed = new Decimal(proposedYen);
    const prior = priorYen ? new Decimal(priorYen) : new Decimal(0);

    // Check if proposed amount crosses threshold
    const proposedCrossesThreshold = proposed.gte(this.JFSA_THRESHOLD_YEN);

    // Check if change from prior crosses threshold
    const change = proposed.minus(prior);
    const changeCrossesThreshold = change.gte(this.JFSA_THRESHOLD_YEN);

    if (proposedCrossesThreshold || changeCrossesThreshold) {
      this.logger.warn(
        `JFSA threshold crossed: claim=${claimId}, reserve=${reserveId}, proposed=¥${proposed.toString()}, prior=¥${prior.toString()}`,
      );

      await this.prisma.notificationToRegulator.create({
        data: {
          kind: 'jfsa_reserve_threshold',
          claim_id: claimId,
          reserve_id: reserveId,
          amount_yen: proposed,
          triggered_at: new Date(),
          sent_at: null, // null until daily batch flushes
        },
      });

      return true;
    }

    return false;
  }

  /**
   * Retrieve all pending JFSA notifications (not yet sent).
   *
   * Used by auditors and regulatory reporting to see which thresholds have been
   * crossed and are awaiting daily flush.
   *
   * @returns array of pending NotificationToRegulator rows
   */
  async getPendingNotifications() {
    return this.prisma.notificationToRegulator.findMany({
      where: {
        sent_at: null,
      },
      orderBy: {
        triggered_at: 'desc',
      },
    });
  }

  /**
   * Mark notifications as sent (called by daily batch job in Track B).
   *
   * @param notificationIds - array of notification IDs to mark as sent
   * @returns count of updated rows
   */
  async markAsSent(notificationIds: string[]): Promise<number> {
    const result = await this.prisma.notificationToRegulator.updateMany({
      where: {
        id: {
          in: notificationIds,
        },
      },
      data: {
        sent_at: new Date(),
      },
    });

    return result.count;
  }

  /**
   * Get notifications for a specific claim.
   *
   * @param claimId - the claim ID
   * @returns array of NotificationToRegulator rows for the claim
   */
  async getNotificationsForClaim(claimId: string) {
    return this.prisma.notificationToRegulator.findMany({
      where: {
        claim_id: claimId,
      },
      orderBy: {
        triggered_at: 'desc',
      },
    });
  }
}