// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// Reserves controller — HTTP surface for the reserves module.
//
// Routes (per design.md §2):
//
//   POST  /claims/:id/reserves          — propose (adjuster, assigned)
//   GET   /claims/:id/reserves          — history (any authenticated)
//   POST  /reserves/:id/approve         — manager approval (≤ ¥10M)
//   POST  /reserves/:id/director-approve — claims-director approval (> ¥10M)
//   POST  /reserves/:id/reject          — manager rejection
//   GET   /reserves/export?period=YYYY-MM — IFRS17 aggregate export (auditor)
//
// All write paths are decorated with `@Audit({...})` so the
// audit interceptor (see `common/audit.interceptor.ts`) emits
// an immutable `AuditEvent` row keyed to the persisted entity.
// The controller itself writes no audit rows directly.
//
// Authorisation is layered:
//   * `JwtAuthGuard` establishes identity;
//   * `RolesGuard` + `@Roles(...)` gates by role;
//   * service-layer checks enforce the finer-grained predicates
//     (assigned-only, director-flag, self-approval segregation).
// ─────────────────────────────────────────────────────────────────────────

import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Reserve, UserRole } from '@prisma/client';

import { Audit } from '../common/audit.decorator';
import { CurrentUser } from '../common/current-user.decorator';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import { ProposeReserveDto } from './dto/propose-reserve.dto';
import { RejectReserveDto } from './dto/reject-reserve.dto';
import {
  ReserveExportPayload,
  ReservesExportService,
} from './reserves-export.service';
import { ReservesCaller, ReservesService } from './reserves.service';

/**
 * Authenticated-caller shape extracted by the
 * `@CurrentUser()` decorator. Mirrors the JWT payload and
 * carries exactly the fields the reserves service needs.
 */
interface AuthenticatedUser {
  id: string;
  role: UserRole;
  is_claims_director: boolean;
}

/**
 * Project the authenticated user onto the `ReservesCaller`
 * envelope the service expects. Keeps the controller free of
 * `as` casts and makes the dependency surface explicit.
 */
function toCaller(user: AuthenticatedUser): ReservesCaller {
  return {
    id: user.id,
    role: user.role,
    is_claims_director: user.is_claims_director,
  };
}

@ApiTags('reserves')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReservesController {
  constructor(
    private readonly reserves: ReservesService,
    private readonly exporter: ReservesExportService,
  ) {}

  // ───────────────────────────────────────────────────────────────
  // Propose — POST /claims/:id/reserves
  // ───────────────────────────────────────────────────────────────

  @Post('claims/:id/reserves')
  @HttpCode(HttpStatus.CREATED)
  @Roles('adjuster')
  @Audit({ action: 'reserve.proposed' })
  @ApiOperation({
    summary:
      'Propose a reserve change against a claim. Assigned-adjuster only.',
  })
  async propose(
    @Param('id') claim_id: string,
    @Body() dto: ProposeReserveDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Reserve> {
    return this.reserves.propose(claim_id, dto, toCaller(user));
  }

  // ───────────────────────────────────────────────────────────────
  // History — GET /claims/:id/reserves
  // ───────────────────────────────────────────────────────────────

  @Get('claims/:id/reserves')
  @Roles('agent', 'adjuster', 'manager', 'auditor', 'siu_referrer')
  @ApiOperation({
    summary:
      'Return the full immutable reserve history for a claim, oldest-first.',
  })
  async history(@Param('id') claim_id: string): Promise<Reserve[]> {
    return this.reserves.historyForClaim(claim_id);
  }

  // ───────────────────────────────────────────────────────────────
  // Approve — POST /reserves/:id/approve
  // ───────────────────────────────────────────────────────────────

  @Post('reserves/:id/approve')
  @HttpCode(HttpStatus.OK)
  @Roles('manager')
  @Audit({ action: 'reserve.approved' })
  @ApiOperation({
    summary:
      'Manager approves a pending reserve. For reserves above ¥10M a director approval is also required before the row flips to approved.',
  })
  async approve(
    @Param('id') reserve_id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Reserve> {
    return this.reserves.approve(reserve_id, toCaller(user));
  }

  // ───────────────────────────────────────────────────────────────
  // Director-approve — POST /reserves/:id/director-approve
  // ───────────────────────────────────────────────────────────────

  @Post('reserves/:id/director-approve')
  @HttpCode(HttpStatus.OK)
  @Roles('manager')
  @Audit({ action: 'reserve.director_approved' })
  @ApiOperation({
    summary:
      'Claims-director approval for reserves above ¥10,000,000. Caller must carry the is_claims_director flag.',
  })
  async directorApprove(
    @Param('id') reserve_id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Reserve> {
    // Defence in depth: the role guard restricts this route to
    // managers, and the service re-checks the director flag,
    // but rejecting here too produces a tighter 403 envelope
    // before we touch the database.
    if (!user.is_claims_director) {
      throw new ForbiddenException(
        'Only a claims director may director-approve a reserve.',
      );
    }
    return this.reserves.directorApprove(reserve_id, toCaller(user));
  }

  // ───────────────────────────────────────────────────────────────
  // Reject — POST /reserves/:id/reject
  // ───────────────────────────────────────────────────────────────

  @Post('reserves/:id/reject')
  @HttpCode(HttpStatus.OK)
  @Roles('manager')
  @Audit({ action: 'reserve.rejected' })
  @ApiOperation({
    summary:
      'Manager rejects a pending reserve. Rejection is terminal; the adjuster proposes a new reserve to retry.',
  })
  async reject(
    @Param('id') reserve_id: string,
    @Body() dto: RejectReserveDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Reserve> {
    return this.reserves.reject(reserve_id, dto, toCaller(user));
  }

  // ───────────────────────────────────────────────────────────────
  // IFRS17 export — GET /reserves/export?period=YYYY-MM
  // ───────────────────────────────────────────────────────────────

  @Get('reserves/export')
  @Roles('auditor')
  @ApiOperation({
    summary:
      'IFRS17 reserve aggregates for a single calendar month, suitable for the downstream actuarial pipeline.',
  })
  @ApiQuery({
    name: 'period',
    required: true,
    description: "Calendar month in 'YYYY-MM' format (UTC anchors).",
    example: '2024-03',
  })
  async exportReserves(
    @Query('period') period: string,
  ): Promise<ReserveExportPayload> {
    return this.exporter.export(period);
  }
}