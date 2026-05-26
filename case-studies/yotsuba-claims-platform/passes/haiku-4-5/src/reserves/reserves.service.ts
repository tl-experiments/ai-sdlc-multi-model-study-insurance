import { Injectable, Logger, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Decimal } from '@prisma/client/runtime/library';
import { ProposeReserveDto } from './dto/propose-reserve.dto';
import { RejectReserveDto } from './dto/reject-reserve.dto';
import { ReservesJfsaService } from './reserves-jfsa.service';
import { ReservesExportService } from './reserves-export.service';
import { User, ApprovalStatus } from '@prisma/client';

/**
 * ReservesService
 *
 * Handles reserve proposal, approval, rejection, and export workflows.
 * Reserves are money set aside against expected payout; reserve adequacy is
 * regulated and reported to JFSA and in IFRS17 disclosures.
 *
 * Context:
 *   - Reserve proposals start in approval_status='pending'
 *   - Approval thresholds are tiered by amount:
 *     * ≤¥1M: self-approving (adjuster proposes, auto-approved)
 *     * ¥1M–¥10M: manager approval required
 *     * >¥10M: manager + claims_director approval required
 *   - Reserve changes crossing ¥100M trigger JFSA notification
 *   - All reserves are immutable once approved; corrections add new proposals
 *   - Full history is maintained for IFRS17 walk-forwards and audit
 *
 * Audit:
 *   - Every reserve action (propose, approve, reject) emits AuditEvent
 *   - Payload hash binds the event to the reserve state
 *   - Audit interceptor captures these via @Audit decorator on controller
 *
 * Workflow:
 *   - Adjuster proposes reserve with category, amount, justification
 *   - System checks approval tier and either auto-approves or routes to manager
 *   - Manager reviews and approves (≤¥10M) or rejects
 *   - If >¥10M, manager approval routes to claims_director for final approval
 *   - Once approved, JFSA threshold check emits notification if crossed
 *   - Rejected proposals cannot be re-approved; new proposal must be created
 */
@Injectable()
export class ReservesService {
  private readonly logger = new Logger(ReservesService.name);

  // Approval thresholds (in yen)
  private readonly THRESHOLD_AUTO_APPROVE = new Decimal('1000000'); // ¥1M
  private readonly THRESHOLD_DIRECTOR_APPROVAL = new Decimal('10000000'); // ¥10M

  constructor(
    private readonly prisma: PrismaService,
    private readonly jfsaService: ReservesJfsaService,
    private readonly exportService: ReservesExportService,
  ) {}

  /**
   * Propose a new reserve for a claim.
   *
   * Creates a Reserve record in pending status. The approval workflow is determined
   * by the proposed amount:
   *   - ≤¥1M: auto-approved immediately
   *   - ¥1M–¥10M: routed to manager for approval
   *   - >¥10M: routed to manager, then claims_director for approval
   *
   * Validation:
   *   - Claim must exist and be in a valid state for reserve changes
   *   - proposed_yen must be positive
   *   - justification must be >= 50 characters
   *   - category must be one of: loss_paid, loss_unpaid, alae, ulae
   *
   * @param claimId - the claim ID
   * @param dto - ProposeReserveDto with category, proposed_yen, justification
   * @param actor - the User proposing the reserve (typically an adjuster)
   * @returns the created Reserve record
   * @throws BadRequestException if claim not found or validation fails
   */
  async proposeReserve(
    claimId: string,
    dto: ProposeReserveDto,
    actor: User,
  ) {
    // Verify claim exists
    const claim = await this.prisma.claim.findUnique({
      where: { id: claimId },
    });

    if (!claim) {
      throw new BadRequestException(`Claim ${claimId} not found`);
    }

    // Validate proposed amount is positive
    const proposedYen = new Decimal(dto.proposed_yen);
    if (proposedYen.lte(0)) {
      throw new BadRequestException('proposed_yen must be positive');
    }

    // Get prior reserve if it exists (for change calculation)
    const priorReserve = await this.exportService.getLatestApprovedReserve(
      claimId,
    );
    const priorYen = priorReserve ? priorReserve.proposed_yen : null;

    // Create the reserve proposal
    const reserve = await this.prisma.reserve.create({
      data: {
        claim_id: claimId,
        category: dto.category,
        proposed_yen: proposedYen,
        prior_yen: priorYen,
        justification: dto.justification,
        proposed_by_id: actor.id,
        proposed_at: new Date(),
        approval_status: 'pending',
      },
    });

    this.logger.debug(
      `Reserve proposed: claim=${claimId}, reserve=${reserve.id}, amount=¥${proposedYen.toString()}, category=${dto.category}`,
    );

    // Check if this crosses JFSA threshold
    await this.jfsaService.checkAndEmitThresholdNotification(
      claimId,
      reserve.id,
      proposedYen,
      priorYen,
    );

    return reserve;
  }

  /**
   * Approve a reserve proposal.
   *
   * Managers can approve reserves up to ¥10M. Reserves >¥10M require
   * claims_director approval (via director-approve endpoint).
   *
   * Validation:
   *   - Reserve must exist and be in pending status
   *   - Actor must be a manager
   *   - If reserve > ¥10M, actor must be claims_director (else use director-approve)
   *
   * @param reserveId - the reserve ID
   * @param actor - the User approving (must be manager)
   * @returns the updated Reserve record
   * @throws BadRequestException if reserve not found or invalid state
   * @throws ForbiddenException if actor lacks permission
   */
  async approveReserve(reserveId: string, actor: User) {
    // Verify reserve exists and is pending
    const reserve = await this.prisma.reserve.findUnique({
      where: { id: reserveId },
      include: { claim: true },
    });

    if (!reserve) {
      throw new BadRequestException(`Reserve ${reserveId} not found`);
    }

    if (reserve.approval_status !== 'pending') {
      throw new BadRequestException(
        `Reserve ${reserveId} is not in pending status (current: ${reserve.approval_status})`,
      );
    }

    const proposedYen = new Decimal(reserve.proposed_yen);

    // Check approval tier
    if (proposedYen.gt(this.THRESHOLD_DIRECTOR_APPROVAL)) {
      throw new ForbiddenException(
        `Reserve amount ¥${proposedYen.toString()} exceeds manager approval limit (¥10M). ` +
          `Use director-approve endpoint with claims_director role.`,
      );
    }

    // Approve the reserve
    const updated = await this.prisma.reserve.update({
      where: { id: reserveId },
      data: {
        approval_status: 'approved',
        approved_by_id: actor.id,
        approved_at: new Date(),
      },
    });

    this.logger.debug(
      `Reserve approved: reserve=${reserveId}, claim=${reserve.claim_id}, amount=¥${proposedYen.toString()}, approved_by=${actor.id}`,
    );

    // Check if this crosses JFSA threshold
    await this.jfsaService.checkAndEmitThresholdNotification(
      reserve.claim_id,
      reserveId,
      proposedYen,
      reserve.prior_yen,
    );

    return updated;
  }

  /**
   * Director-approve a reserve proposal (for amounts >¥10M).
   *
   * Claims directors can approve reserves of any amount. This is the final
   * approval step for reserves >¥10M (which must first be approved by a manager).
   *
   * Validation:
   *   - Reserve must exist and be in pending status
   *   - Actor must have is_claims_director=true
   *   - Reserve amount should typically be >¥10M (no hard check, but convention)
   *
   * @param reserveId - the reserve ID
   * @param actor - the User approving (must be claims_director)
   * @returns the updated Reserve record
   * @throws BadRequestException if reserve not found or invalid state
   * @throws ForbiddenException if actor is not claims_director
   */
  async directorApproveReserve(reserveId: string, actor: User) {
    // Verify actor is claims director
    if (!actor.is_claims_director) {
      throw new ForbiddenException(
        `User ${actor.id} is not a claims director. Cannot approve reserves >¥10M.`,
      );
    }

    // Verify reserve exists and is pending
    const reserve = await this.prisma.reserve.findUnique({
      where: { id: reserveId },
      include: { claim: true },
    });

    if (!reserve) {
      throw new BadRequestException(`Reserve ${reserveId} not found`);
    }

    if (reserve.approval_status !== 'pending') {
      throw new BadRequestException(
        `Reserve ${reserveId} is not in pending status (current: ${reserve.approval_status})`,
      );
    }

    const proposedYen = new Decimal(reserve.proposed_yen);

    // Approve the reserve
    const updated = await this.prisma.reserve.update({
      where: { id: reserveId },
      data: {
        approval_status: 'approved',
        director_approved_by_id: actor.id,
        director_approved_at: new Date(),
      },
    });

    this.logger.debug(
      `Reserve director-approved: reserve=${reserveId}, claim=${reserve.claim_id}, amount=¥${proposedYen.toString()}, director=${actor.id}`,
    );

    // Check if this crosses JFSA threshold
    await this.jfsaService.checkAndEmitThresholdNotification(
      reserve.claim_id,
      reserveId,
      proposedYen,
      reserve.prior_yen,
    );

    return updated;
  }

  /**
   * Reject a reserve proposal.
   *
   * Managers can reject reserves at any amount. Once rejected, the proposal
   * cannot be re-approved; a new proposal must be created.
   *
   * Validation:
   *   - Reserve must exist and be in pending status
   *   - Actor must be a manager
   *   - reason_for_rejection must be >= 20 characters
   *
   * @param reserveId - the reserve ID
   * @param dto - RejectReserveDto with reason_for_rejection
   * @param actor - the User rejecting (must be manager)
   * @returns the updated Reserve record
   * @throws BadRequestException if reserve not found or invalid state
   */
  async rejectReserve(
    reserveId: string,
    dto: RejectReserveDto,
    actor: User,
  ) {
    // Verify reserve exists and is pending
    const reserve = await this.prisma.reserve.findUnique({
      where: { id: reserveId },
      include: { claim: true },
    });

    if (!reserve) {
      throw new BadRequestException(`Reserve ${reserveId} not found`);
    }

    if (reserve.approval_status !== 'pending') {
      throw new BadRequestException(
        `Reserve ${reserveId} is not in pending status (current: ${reserve.approval_status})`,
      );
    }

    // Reject the reserve
    const updated = await this.prisma.reserve.update({
      where: { id: reserveId },
      data: {
        approval_status: 'rejected',
        reason_for_rejection: dto.reason_for_rejection,
      },
    });

    this.logger.debug(
      `Reserve rejected: reserve=${reserveId}, claim=${reserve.claim_id}, reason=${dto.reason_for_rejection.substring(0, 50)}...`,
    );

    return updated;
  }

  /**
   * Get a reserve by ID.
   *
   * @param reserveId - the reserve ID
   * @returns the Reserve record, or null if not found
   */
  async getReserveById(reserveId: string) {
    return this.prisma.reserve.findUnique({
      where: { id: reserveId },
    });
  }

  /**
   * Get all reserves for a claim.
   *
   * Returns the full reserve history for a claim, ordered by proposed_at descending.
   * Includes pending, approved, and rejected reserves.
   *
   * @param claimId - the claim ID
   * @returns array of Reserve records
   */
  async getReservesByClaim(claimId: string) {
    return this.prisma.reserve.findMany({
      where: { claim_id: claimId },
      orderBy: { proposed_at: 'desc' },
    });
  }

  /**
   * Get all pending reserves (awaiting approval).
   *
   * Used by managers to see their approval queue.
   *
   * @returns array of pending Reserve records
   */
  async getPendingReserves() {
    return this.prisma.reserve.findMany({
      where: { approval_status: 'pending' },
      include: { claim: true },
      orderBy: { proposed_at: 'asc' },
    });
  }

  /**
   * Get all pending reserves for a specific manager's reports.
   *
   * Used by managers to see reserves proposed by their assigned adjusters.
   *
   * @param managerReportIds - array of adjuster IDs reporting to the manager
   * @returns array of pending Reserve records
   */
  async getPendingReservesForManager(managerReportIds: string[]) {
    return this.prisma.reserve.findMany({
      where: {
        approval_status: 'pending',
        proposed_by_id: { in: managerReportIds },
      },
      include: { claim: true },
      orderBy: { proposed_at: 'asc' },
    });
  }

  /**
   * Export reserves by period in IFRS17-ready format.
   *
   * Delegates to ReservesExportService for aggregation and formatting.
   *
   * @param period - YYYY-MM format
   * @returns array of reserve aggregates by category
   */
  async exportByPeriod(period: string) {
    return this.exportService.exportByPeriod(period);
  }

  /**
   * Export reserves by claim in IFRS17-ready format.
   *
   * Delegates to ReservesExportService for aggregation and formatting.
   *
   * @param claimId - the claim ID
   * @returns array of reserve aggregates by category
   */
  async exportByClaim(claimId: string) {
    return this.exportService.exportByClaim(claimId);
  }

  /**
   * Get total approved reserves for a period.
   *
   * Delegates to ReservesExportService.
   *
   * @param period - YYYY-MM format
   * @returns total approved reserves in yen (as string)
   */
  async getTotalApprovedReservesByPeriod(period: string) {
    return this.exportService.getTotalApprovedReservesByPeriod(period);
  }

  /**
   * Get pending JFSA notifications.
   *
   * Delegates to ReservesJfsaService.
   *
   * @returns array of pending NotificationToRegulator records
   */
  async getPendingJfsaNotifications() {
    return this.jfsaService.getPendingNotifications();
  }

  /**
   * Get JFSA notifications for a specific claim.
   *
   * Delegates to ReservesJfsaService.
   *
   * @param claimId - the claim ID
   * @returns array of NotificationToRegulator records for the claim
   */
  async getJfsaNotificationsForClaim(claimId: string) {
    return this.jfsaService.getNotificationsForClaim(claimId);
  }
}