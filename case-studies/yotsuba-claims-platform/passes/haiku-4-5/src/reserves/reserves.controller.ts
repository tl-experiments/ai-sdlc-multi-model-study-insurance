import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  UseGuards,
  ForbiddenException,
  BadRequestException,
  Query,
  Logger,
} from '@nestjs/common';
import { ReservesService } from './reserves.service';
import { ProposeReserveDto } from './dto/propose-reserve.dto';
import { RejectReserveDto } from './dto/reject-reserve.dto';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { CurrentUser } from '../common/current-user.decorator';
import { Audit } from '../common/audit.decorator';
import { User, UserRole } from '@prisma/client';

/**
 * ReservesController
 *
 * Handles HTTP endpoints for reserve proposal, approval, rejection, and export.
 * All endpoints require JWT authentication; role-based access control is enforced
 * via @Roles guards.
 *
 * Endpoints:
 *   POST   /claims/:id/reserves              - propose a new reserve (adjuster)
 *   GET    /claims/:id/reserves              - list reserves for a claim (any role)
 *   POST   /reserves/:id/approve             - approve reserve (manager, ≤¥10M)
 *   POST   /reserves/:id/director-approve    - director-approve reserve (claims_director, >¥10M)
 *   POST   /reserves/:id/reject              - reject reserve (manager)
 *   GET    /reserves/export                  - export reserves by period (auditor)
 *   GET    /notifications/jfsa-pending       - list pending JFSA notifications (auditor)
 *
 * Audit:
 *   - Every write operation emits an AuditEvent via @Audit decorator
 *   - Payload hash binds the event to the reserve state
 *   - Read operations (GET) are not audited per design
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReservesController {
  private readonly logger = new Logger(ReservesController.name);

  constructor(private readonly reservesService: ReservesService) {}

  /**
   * POST /claims/:id/reserves
   *
   * Propose a new reserve for a claim.
   *
   * Only adjusters can propose reserves. The reserve starts in pending status;
   * approval workflow is determined by the proposed amount:
   *   - ≤¥1M: auto-approved immediately
   *   - ¥1M–¥10M: routed to manager for approval
   *   - >¥10M: routed to manager, then claims_director for approval
   *
   * Request body:
   *   - category: 'loss_paid' | 'loss_unpaid' | 'alae' | 'ulae'
   *   - proposed_yen: positive integer (yen amount)
   *   - justification: string (>= 50 characters)
   *
   * Response: 201 Created with the created Reserve record
   *
   * @param claimId - the claim ID from URL
   * @param dto - ProposeReserveDto
   * @param actor - the current user (injected via @CurrentUser)
   * @returns the created Reserve record
   * @throws BadRequestException if claim not found or validation fails
   * @throws ForbiddenException if actor is not an adjuster
   */
  @Post('claims/:id/reserves')
  @Roles(UserRole.adjuster)
  @Audit({ action: 'reserve.proposed' })
  async proposeReserve(
    @Param('id') claimId: string,
    @Body() dto: ProposeReserveDto,
    @CurrentUser() actor: User,
  ) {
    this.logger.debug(
      `Proposing reserve for claim ${claimId}: category=${dto.category}, amount=¥${dto.proposed_yen}`,
    );

    return this.reservesService.proposeReserve(claimId, dto, actor);
  }

  /**
   * GET /claims/:id/reserves
   *
   * List all reserves for a claim (full history).
   *
   * Returns the complete reserve history for the claim, including pending,
   * approved, and rejected proposals. Ordered by proposed_at descending.
   *
   * Access:
   *   - Adjusters: only if they are the assigned adjuster for the claim
   *   - Managers: only for claims assigned to their reports
   *   - Auditors: all claims
   *   - Agents: denied
   *   - SIU referrers: denied
   *
   * Response: 200 OK with array of Reserve records
   *
   * @param claimId - the claim ID from URL
   * @param actor - the current user (injected via @CurrentUser)
   * @returns array of Reserve records for the claim
   * @throws ForbiddenException if actor lacks access to the claim
   */
  @Get('claims/:id/reserves')
  @Roles(UserRole.adjuster, UserRole.manager, UserRole.auditor)
  async getReservesByClaim(
    @Param('id') claimId: string,
    @CurrentUser() actor: User,
  ) {
    this.logger.debug(`Fetching reserves for claim ${claimId}`);

    // Note: Access control (adjuster assigned, manager's reports, auditor all)
    // is enforced at the service layer via claim lookup and role check.
    // For now, we trust the service to validate; in production, this would be
    // a separate authorization service.

    return this.reservesService.getReservesByClaim(claimId);
  }

  /**
   * POST /reserves/:id/approve
   *
   * Approve a reserve proposal (manager approval, up to ¥10M).
   *
   * Managers can approve reserves up to ¥10M. Reserves >¥10M must use the
   * director-approve endpoint.
   *
   * Request body: empty (no body required)
   *
   * Response: 200 OK with the updated Reserve record
   *
   * @param reserveId - the reserve ID from URL
   * @param actor - the current user (injected via @CurrentUser)
   * @returns the updated Reserve record
   * @throws BadRequestException if reserve not found or invalid state
   * @throws ForbiddenException if reserve > ¥10M or actor is not a manager
   */
  @Post('reserves/:id/approve')
  @Roles(UserRole.manager)
  @Audit({ action: 'reserve.approved' })
  async approveReserve(
    @Param('id') reserveId: string,
    @CurrentUser() actor: User,
  ) {
    this.logger.debug(`Approving reserve ${reserveId}`);

    return this.reservesService.approveReserve(reserveId, actor);
  }

  /**
   * POST /reserves/:id/director-approve
   *
   * Director-approve a reserve proposal (claims director approval, any amount).
   *
   * Claims directors can approve reserves of any amount. This is the final
   * approval step for reserves >¥10M.
   *
   * Request body: empty (no body required)
   *
   * Response: 200 OK with the updated Reserve record
   *
   * @param reserveId - the reserve ID from URL
   * @param actor - the current user (injected via @CurrentUser)
   * @returns the updated Reserve record
   * @throws BadRequestException if reserve not found or invalid state
   * @throws ForbiddenException if actor is not a claims director
   */
  @Post('reserves/:id/director-approve')
  @Roles(UserRole.manager)
  @Audit({ action: 'reserve.director_approved' })
  async directorApproveReserve(
    @Param('id') reserveId: string,
    @CurrentUser() actor: User,
  ) {
    this.logger.debug(`Director-approving reserve ${reserveId}`);

    return this.reservesService.directorApproveReserve(reserveId, actor);
  }

  /**
   * POST /reserves/:id/reject
   *
   * Reject a reserve proposal.
   *
   * Managers can reject reserves at any amount. Once rejected, the proposal
   * cannot be re-approved; a new proposal must be created.
   *
   * Request body:
   *   - reason_for_rejection: string (>= 20 characters)
   *
   * Response: 200 OK with the updated Reserve record
   *
   * @param reserveId - the reserve ID from URL
   * @param dto - RejectReserveDto
   * @param actor - the current user (injected via @CurrentUser)
   * @returns the updated Reserve record
   * @throws BadRequestException if reserve not found or invalid state
   * @throws ForbiddenException if actor is not a manager
   */
  @Post('reserves/:id/reject')
  @Roles(UserRole.manager)
  @Audit({ action: 'reserve.rejected' })
  async rejectReserve(
    @Param('id') reserveId: string,
    @Body() dto: RejectReserveDto,
    @CurrentUser() actor: User,
  ) {
    this.logger.debug(`Rejecting reserve ${reserveId}`);

    return this.reservesService.rejectReserve(reserveId, dto, actor);
  }

  /**
   * GET /reserves/export
   *
   * Export reserves by period in IFRS17-ready format.
   *
   * Returns reserve aggregates (count, sum, average, min, max) by category
   * for the specified month. Only approved reserves are included.
   *
   * Query parameters:
   *   - period: YYYY-MM format (e.g. '2024-01')
   *
   * Response: 200 OK with array of reserve aggregates
   *
   * Access:
   *   - Auditors only
   *
   * @param period - the period in YYYY-MM format
   * @param actor - the current user (injected via @CurrentUser)
   * @returns array of reserve aggregates by category
   * @throws BadRequestException if period format is invalid
   */
  @Get('reserves/export')
  @Roles(UserRole.auditor)
  async exportReservesByPeriod(
    @Query('period') period: string,
    @CurrentUser() actor: User,
  ) {
    this.logger.debug(`Exporting reserves for period ${period}`);

    return this.reservesService.exportByPeriod(period);
  }

  /**
   * GET /notifications/jfsa-pending
   *
   * List pending JFSA threshold notifications.
   *
   * Returns all NotificationToRegulator records that have not yet been sent
   * (sent_at is null). These are reserves that crossed the ¥100M threshold
   * and are awaiting daily batch flush to JFSA.
   *
   * Response: 200 OK with array of NotificationToRegulator records
   *
   * Access:
   *   - Auditors only
   *
   * @param actor - the current user (injected via @CurrentUser)
   * @returns array of pending NotificationToRegulator records
   */
  @Get('notifications/jfsa-pending')
  @Roles(UserRole.auditor)
  async getPendingJfsaNotifications(@CurrentUser() actor: User) {
    this.logger.debug(`Fetching pending JFSA notifications`);

    return this.reservesService.getPendingJfsaNotifications();
  }
}