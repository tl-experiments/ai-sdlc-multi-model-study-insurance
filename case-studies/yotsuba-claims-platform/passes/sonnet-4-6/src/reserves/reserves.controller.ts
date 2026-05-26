// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/reserves/reserves.controller.ts
//
// Reserves management controller — HTTP layer for reserve proposals,
// approval workflow, IFRS17 export, and JFSA pending notifications.
//
// Design reference: design.md §2 API contract, design.md §3 Module structure
// Brief reference:  brief.md §3 Reserves Management
//
// Routes handled:
//   POST   /claims/:id/reserves           — propose reserve change
//   GET    /claims/:id/reserves           — reserve history
//   POST   /reserves/:id/approve          — manager approval (≤ ¥10M)
//   POST   /reserves/:id/director-approve — claims director approval (> ¥10M)
//   POST   /reserves/:id/reject           — manager rejection
//   GET    /reserves/export               — IFRS17 export (?period=YYYY-MM)
//   GET    /notifications/jfsa-pending    — pending JFSA threshold notifications
//
// ADR-002: Every write emits an AuditEvent (delegated to ReservesService).
// ADR-005: Approval tier enforcement in ReservesService.
// ADR-006: JFSA threshold detection in ReservesService + ReservesJfsaService.
// =============================================================================

import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
  Logger,
  ParseIntPipe,
  DefaultValuePipe,
  Optional,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { CurrentUser } from '../common/current-user.decorator';
import { ReservesService, ReserveCallerContext } from './reserves.service';
import { ReservesJfsaService } from './reserves-jfsa.service';
import { ReservesExportService } from './reserves-export.service';
import { ProposeReserveDto } from './dto/propose-reserve.dto';
import { RejectReserveDto } from './dto/reject-reserve.dto';

// ---------------------------------------------------------------------------
// Authenticated user shape injected via @CurrentUser()
// ---------------------------------------------------------------------------

interface AuthenticatedUser {
  id: string;
  role: UserRole;
  is_claims_director: boolean;
}

// ---------------------------------------------------------------------------
// Request context helper
// ---------------------------------------------------------------------------

/**
 * Build a ReserveCallerContext from the authenticated user and the raw
 * Express request. The request object is used to extract the request_id
 * and correlation_id headers/properties set by the middleware.
 */
function buildCallerContext(
  user: AuthenticatedUser,
  req: Record<string, unknown>,
): ReserveCallerContext {
  return {
    user_id: user.id,
    role: user.role,
    is_claims_director: user.is_claims_director ?? false,
    correlation_id:
      typeof req['correlation_id'] === 'string'
        ? req['correlation_id']
        : (req.headers as Record<string, string>)?.['x-correlation-id'] ?? '',
    request_id:
      typeof req['request_id'] === 'string'
        ? req['request_id']
        : (req.headers as Record<string, string>)?.['x-request-id'] ?? '',
  };
}

// ---------------------------------------------------------------------------
// Controller — /claims/:id/reserves (claim-scoped reserve operations)
// ---------------------------------------------------------------------------

@ApiTags('reserves')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class ReservesController {
  private readonly logger = new Logger(ReservesController.name);

  constructor(
    private readonly reservesService: ReservesService,
    private readonly jfsaService: ReservesJfsaService,
    private readonly exportService: ReservesExportService,
  ) {}

  // -------------------------------------------------------------------------
  // POST /claims/:id/reserves — propose a reserve change
  // -------------------------------------------------------------------------

  /**
   * Propose a reserve change for a claim.
   *
   * Accessible by adjusters (assigned only) and managers (any claim in their
   * pool). Amounts <= ¥1M are auto-approved; higher amounts enter a pending
   * queue for manager / director approval (ADR-005).
   *
   * Emits a JFSA NotificationToRegulator record if the proposed amount crosses
   * ¥100M (ADR-006).
   */
  @Post('claims/:id/reserves')
  @HttpCode(HttpStatus.CREATED)
  @Roles(UserRole.adjuster, UserRole.manager)
  @ApiOperation({
    summary: 'Propose a reserve change',
    description:
      'Propose a reserve change for a claim. Amounts <= ¥1M are auto-approved. ' +
      '¥1M–¥10M require manager approval. > ¥10M require manager + claims-director approval. ' +
      'Amounts crossing ¥100M trigger a JFSA notification record.',
  })
  @ApiParam({ name: 'id', description: 'Claim ID' })
  @ApiResponse({ status: 201, description: 'Reserve proposal created.' })
  @ApiResponse({ status: 400, description: 'Validation error.' })
  @ApiResponse({ status: 403, description: 'Forbidden — role or ownership mismatch.' })
  @ApiResponse({ status: 404, description: 'Claim not found.' })
  @ApiResponse({ status: 422, description: 'Unprocessable entity.' })
  async proposeReserve(
    @Param('id') claimId: string,
    @Body() dto: ProposeReserveDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Record<string, unknown>,
  ) {
    const caller = buildCallerContext(user, req);

    this.logger.log(
      {
        claim_id: claimId,
        category: dto.category,
        proposed_yen: dto.proposed_yen,
        proposed_by_id: caller.user_id,
        correlation_id: caller.correlation_id,
      },
      'Reserve proposal request received',
    );

    return this.reservesService.proposeReserve(claimId, dto, caller);
  }

  // -------------------------------------------------------------------------
  // GET /claims/:id/reserves — reserve history
  // -------------------------------------------------------------------------

  /**
   * Retrieve the full immutable reserve history for a claim.
   *
   * Accessible by any authenticated user with read access (role scoping
   * is enforced at the claim level).
   */
  @Get('claims/:id/reserves')
  @HttpCode(HttpStatus.OK)
  @Roles(
    UserRole.adjuster,
    UserRole.manager,
    UserRole.auditor,
    UserRole.agent,
    UserRole.siu_referrer,
  )
  @ApiOperation({
    summary: 'Get reserve history for a claim',
    description:
      'Returns the full immutable reserve history for a claim, ordered by ' +
      'proposed_at ascending. Required for IFRS17 walk-forward audit.',
  })
  @ApiParam({ name: 'id', description: 'Claim ID' })
  @ApiResponse({ status: 200, description: 'Reserve history retrieved.' })
  @ApiResponse({ status: 404, description: 'Claim not found.' })
  async getReserveHistory(
    @Param('id') claimId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Record<string, unknown>,
  ) {
    const caller = buildCallerContext(user, req);

    this.logger.log(
      {
        claim_id: claimId,
        caller_id: caller.user_id,
        correlation_id: caller.correlation_id,
      },
      'Reserve history request received',
    );

    return this.reservesService.getReserveHistory(claimId, caller);
  }

  // -------------------------------------------------------------------------
  // POST /reserves/:id/approve — manager approves (≤ ¥10M full; > ¥10M tier-1)
  // -------------------------------------------------------------------------

  /**
   * Manager approves a pending reserve proposal.
   *
   * For amounts <= ¥10M: moves reserve to `approved` status.
   * For amounts > ¥10M: records manager first-tier approval; status remains
   * `pending` until a claims director calls POST /reserves/:id/director-approve.
   */
  @Post('reserves/:id/approve')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.manager)
  @ApiOperation({
    summary: 'Approve a pending reserve proposal (manager)',
    description:
      'Approves a pending reserve. For amounts <= ¥10M this completes approval. ' +
      'For amounts > ¥10M, records manager first-tier approval and awaits director approval.',
  })
  @ApiParam({ name: 'id', description: 'Reserve ID' })
  @ApiResponse({ status: 200, description: 'Reserve approved.' })
  @ApiResponse({ status: 403, description: 'Forbidden — manager role required.' })
  @ApiResponse({ status: 404, description: 'Reserve not found.' })
  @ApiResponse({ status: 422, description: 'Reserve not in pending status.' })
  async approveReserve(
    @Param('id') reserveId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Record<string, unknown>,
  ) {
    const caller = buildCallerContext(user, req);

    this.logger.log(
      {
        reserve_id: reserveId,
        approved_by_id: caller.user_id,
        correlation_id: caller.correlation_id,
      },
      'Reserve approval request received',
    );

    return this.reservesService.approveReserve(reserveId, caller);
  }

  // -------------------------------------------------------------------------
  // POST /reserves/:id/director-approve — claims director final approval
  // -------------------------------------------------------------------------

  /**
   * Claims director grants final approval for reserves > ¥10M.
   *
   * Caller must have role `manager` AND `is_claims_director = true`.
   * Reserve must already have manager first-tier approval recorded.
   */
  @Post('reserves/:id/director-approve')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.manager)
  @ApiOperation({
    summary: 'Claims director final approval for reserves > ¥10M',
    description:
      'Grants director-level approval for reserves exceeding ¥10M. ' +
      'Caller must be a manager with is_claims_director=true. ' +
      'Manager first-tier approval must already be recorded.',
  })
  @ApiParam({ name: 'id', description: 'Reserve ID' })
  @ApiResponse({ status: 200, description: 'Director approval granted; reserve now approved.' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden — claims director role required.',
  })
  @ApiResponse({ status: 404, description: 'Reserve not found.' })
  @ApiResponse({
    status: 422,
    description:
      'Reserve not in pending status, missing manager approval, or below director threshold.',
  })
  async directorApproveReserve(
    @Param('id') reserveId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Record<string, unknown>,
  ) {
    const caller = buildCallerContext(user, req);

    this.logger.log(
      {
        reserve_id: reserveId,
        director_id: caller.user_id,
        is_claims_director: caller.is_claims_director,
        correlation_id: caller.correlation_id,
      },
      'Director reserve approval request received',
    );

    return this.reservesService.directorApproveReserve(reserveId, caller);
  }

  // -------------------------------------------------------------------------
  // POST /reserves/:id/reject — manager rejects
  // -------------------------------------------------------------------------

  /**
   * Manager rejects a pending reserve proposal.
   *
   * Requires a reason_for_rejection in the request body.
   */
  @Post('reserves/:id/reject')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.manager)
  @ApiOperation({
    summary: 'Reject a pending reserve proposal',
    description:
      'Rejects a pending reserve proposal. ' +
      'A reason_for_rejection is required. Manager role required.',
  })
  @ApiParam({ name: 'id', description: 'Reserve ID' })
  @ApiResponse({ status: 200, description: 'Reserve rejected.' })
  @ApiResponse({ status: 403, description: 'Forbidden — manager role required.' })
  @ApiResponse({ status: 404, description: 'Reserve not found.' })
  @ApiResponse({ status: 422, description: 'Reserve not in pending status.' })
  async rejectReserve(
    @Param('id') reserveId: string,
    @Body() dto: RejectReserveDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Record<string, unknown>,
  ) {
    const caller = buildCallerContext(user, req);

    this.logger.log(
      {
        reserve_id: reserveId,
        rejected_by_id: caller.user_id,
        correlation_id: caller.correlation_id,
      },
      'Reserve rejection request received',
    );

    return this.reservesService.rejectReserve(reserveId, dto, caller);
  }

  // -------------------------------------------------------------------------
  // GET /reserves/export — IFRS17-ready aggregates
  // -------------------------------------------------------------------------

  /**
   * Export approved reserve aggregates for a reporting period.
   *
   * Returns tabular JSON suitable for downstream IFRS17 calculation pipelines.
   * Auditor-only. Query parameter: ?period=YYYY-MM (required).
   *
   * Note: This route is registered before /reserves/:id routes to ensure
   * the literal path segment "export" is not interpreted as a reserve ID.
   */
  @Get('reserves/export')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.auditor)
  @ApiOperation({
    summary: 'Export IFRS17-ready reserve aggregates',
    description:
      'Returns approved reserve aggregates for the specified reporting period ' +
      '(YYYY-MM). Includes category-level summaries and per-claim detail. ' +
      'Auditor-only. Suitable for downstream IFRS17 actuarial pipeline ingestion.',
  })
  @ApiQuery({
    name: 'period',
    required: true,
    description: 'Reporting period in YYYY-MM format (e.g. "2024-03")',
    example: '2024-03',
  })
  @ApiResponse({ status: 200, description: 'IFRS17 export payload.' })
  @ApiResponse({ status: 400, description: 'Invalid period format.' })
  @ApiResponse({ status: 403, description: 'Forbidden — auditor role required.' })
  async exportReserves(
    @Query('period') period: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Record<string, unknown>,
  ) {
    const caller = buildCallerContext(user, req);

    this.logger.log(
      {
        period,
        requested_by_id: caller.user_id,
        correlation_id: caller.correlation_id,
      },
      'IFRS17 reserve export request received',
    );

    return this.exportService.exportForPeriod(period, caller.correlation_id);
  }

  // -------------------------------------------------------------------------
  // GET /notifications/jfsa-pending — pending JFSA threshold notifications
  // -------------------------------------------------------------------------

  /**
   * List pending (unsent) JFSA threshold notifications.
   *
   * Returns NotificationToRegulator records where sent_at is null, ordered
   * oldest-first. Auditor-only. Supports pagination via limit/offset.
   *
   * Per ADR-006, these records are awaiting the Track B daily batch flush
   * that will transmit the regulatory wire payload to JFSA.
   */
  @Get('notifications/jfsa-pending')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.auditor)
  @ApiOperation({
    summary: 'List pending JFSA threshold notifications',
    description:
      'Returns unsent NotificationToRegulator records (sent_at IS NULL), ' +
      'ordered by triggered_at ascending. Auditor-only. ' +
      'These records represent reserve changes that crossed the ¥100M JFSA threshold ' +
      'and are awaiting the daily regulatory batch flush (Track B).',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Maximum records to return (default: 100)',
    example: 100,
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    description: 'Pagination offset (default: 0)',
    example: 0,
  })
  @ApiResponse({ status: 200, description: 'Pending JFSA notifications list.' })
  @ApiResponse({ status: 403, description: 'Forbidden — auditor role required.' })
  async getJfsaPendingNotifications(
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Record<string, unknown>,
  ) {
    const caller = buildCallerContext(user, req);

    this.logger.log(
      {
        limit,
        offset,
        requested_by_id: caller.user_id,
        correlation_id: caller.correlation_id,
      },
      'JFSA pending notifications request received',
    );

    return this.jfsaService.getPendingNotifications(limit, offset);
  }
}

// ---------------------------------------------------------------------------
// NestJS @Req() decorator import (must be at module scope)
// ---------------------------------------------------------------------------
// NestJS exports @Req from @nestjs/common but the import above does not
// include it because it conflicts with the ParseIntPipe / DefaultValuePipe
// imports visually. We re-export here to keep the file self-contained.
import { Req } from '@nestjs/common';
// (This is a re-declaration; the actual @Req usage above resolves correctly
// because NestJS resolves decorators at runtime via reflection, not by
// import order. The import at the bottom is valid TypeScript.)