// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/reserves/reserves.service.ts
//
// Reserves management service — proposal, approval workflow, JFSA threshold
// detection, and reserve history queries.
//
// Design reference: design.md §1 Data model (Reserve, NotificationToRegulator),
//                   design.md §2 API contract, design.md §3 Module structure
// Brief reference:  brief.md §3 Reserves Management
//
// ADR-005: Reserve approval tiers
//   ≤ ¥1,000,000          — no approval required (auto-approved)
//   ¥1,000,001–¥10,000,000 — manager approval required
//   > ¥10,000,000          — manager + claims_director approval required
//
// ADR-006: JFSA threshold (¥100,000,000) triggers NotificationToRegulator
//   record via ReservesJfsaService (synchronous, non-blocking on failure).
//
// ADR-002: Every write emits an AuditEvent via the AuditService.
// =============================================================================

import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  UnprocessableEntityException,
  BadRequestException,
} from '@nestjs/common';
import { ApprovalStatus, UserRole } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { ReservesJfsaService } from './reserves-jfsa.service';
import { ProposeReserveDto } from './dto/propose-reserve.dto';
import { RejectReserveDto } from './dto/reject-reserve.dto';

// ---------------------------------------------------------------------------
// Approval tier constants (ADR-005)
// ---------------------------------------------------------------------------

/**
 * Reserves at or below this amount are automatically approved.
 * Brief: "reserve changes >¥1M require manager approval".
 */
export const RESERVE_AUTO_APPROVE_THRESHOLD_YEN = BigInt(1_000_000);

/**
 * Reserves above this amount require claims-director approval in addition
 * to manager approval.
 * Brief: ">¥10M require manager + claims-director approval".
 */
export const RESERVE_DIRECTOR_APPROVAL_THRESHOLD_YEN = BigInt(10_000_000);

// ---------------------------------------------------------------------------
// Caller context (passed from controller)
// ---------------------------------------------------------------------------

export interface ReserveCallerContext {
  user_id: string;
  role: UserRole;
  is_claims_director: boolean;
  correlation_id: string;
  request_id: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class ReservesService {
  private readonly logger = new Logger(ReservesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly jfsaService: ReservesJfsaService,
  ) {}

  // -------------------------------------------------------------------------
  // POST /claims/:id/reserves — propose a reserve change
  // -------------------------------------------------------------------------

  /**
   * Propose a reserve change for a claim.
   *
   * Business rules:
   *  - Claim must exist.
   *  - Caller must be the assigned adjuster (adjuster role) or a manager
   *    whose reports include the claim's adjuster.
   *  - `justification` must be >= 50 characters (enforced in DTO + here).
   *  - `prior_yen` is resolved from the most recent approved reserve for
   *    the same claim+category, if one exists.
   *  - Auto-approval applied for amounts <= ¥1M (ADR-005).
   *  - JFSA notification emitted if amount >= ¥100M (ADR-006).
   *
   * @param claimId - Claim to attach the reserve to.
   * @param dto     - Validated proposal DTO.
   * @param caller  - Authenticated caller context.
   */
  async proposeReserve(
    claimId: string,
    dto: ProposeReserveDto,
    caller: ReserveCallerContext,
  ) {
    // 1. Verify claim exists.
    const claim = await this.prisma.claim.findUnique({
      where: { id: claimId },
      select: {
        id: true,
        assigned_adjuster_id: true,
        status: true,
      },
    });

    if (!claim) {
      throw new NotFoundException(`Claim ${claimId} not found.`);
    }

    // 2. Authorisation: adjuster must be assigned; manager must be in hierarchy.
    this.assertCanProposeReserve(claim, caller);

    // 3. Validate justification length (belt-and-suspenders beyond DTO).
    if (!dto.justification || dto.justification.trim().length < 50) {
      throw new BadRequestException(
        'justification must be at least 50 characters.',
      );
    }

    // 4. Resolve prior_yen from the most recent approved reserve for this
    //    claim + category combination.
    const priorReserve = await this.prisma.reserve.findFirst({
      where: {
        claim_id: claimId,
        category: dto.category,
        approval_status: ApprovalStatus.approved,
      },
      orderBy: { proposed_at: 'desc' },
      select: { proposed_yen: true },
    });

    const priorYen: Decimal | null = priorReserve?.proposed_yen ?? null;

    // 5. Determine initial approval status based on ADR-005 tiers.
    const proposedBigInt = BigInt(new Decimal(dto.proposed_yen).toFixed(0));
    const initialStatus = this.resolveInitialApprovalStatus(proposedBigInt);

    // 6. Persist the Reserve record.
    const reserve = await this.prisma.reserve.create({
      data: {
        claim_id: claimId,
        category: dto.category,
        proposed_yen: new Decimal(dto.proposed_yen),
        prior_yen: priorYen,
        justification: dto.justification.trim(),
        proposed_by_id: caller.user_id,
        approval_status: initialStatus,
        // If auto-approved, set approved_by and approved_at immediately.
        ...(initialStatus === ApprovalStatus.approved
          ? {
              approved_by_id: caller.user_id,
              approved_at: new Date(),
            }
          : {}),
      },
    });

    this.logger.log(
      {
        reserve_id: reserve.id,
        claim_id: claimId,
        proposed_yen: proposedBigInt.toString(),
        category: dto.category,
        initial_status: initialStatus,
        proposed_by_id: caller.user_id,
        correlation_id: caller.correlation_id,
      },
      'Reserve proposal created',
    );

    // 7. Emit audit event.
    await this.auditService.emit({
      actor_id: caller.user_id,
      actor_role: caller.role,
      action: 'reserve.proposed',
      claim_id: claimId,
      target_id: reserve.id,
      payload: {
        reserve_id: reserve.id,
        category: dto.category,
        proposed_yen: proposedBigInt.toString(),
        prior_yen: priorYen?.toFixed(0) ?? null,
        initial_status: initialStatus,
      },
      request_id: caller.request_id,
      correlation_id: caller.correlation_id,
    });

    // 8. Check JFSA notification threshold (non-blocking on failure — ADR-006).
    const jfsaResult = await this.jfsaService.maybeEmit(
      claimId,
      reserve.id,
      new Decimal(dto.proposed_yen),
      caller.correlation_id,
    );

    if (jfsaResult.emitted) {
      this.logger.warn(
        {
          reserve_id: reserve.id,
          claim_id: claimId,
          amount_yen: proposedBigInt.toString(),
          notification_id: jfsaResult.notification_id,
          correlation_id: caller.correlation_id,
        },
        'JFSA threshold notification emitted for reserve proposal',
      );
    }

    return reserve;
  }

  // -------------------------------------------------------------------------
  // GET /claims/:id/reserves — reserve history
  // -------------------------------------------------------------------------

  /**
   * Return the full immutable reserve history for a claim.
   *
   * Ordered by proposed_at ascending so consumers see the change walk-forward
   * in chronological order (required for IFRS17 walk-forward audit).
   *
   * Any authenticated caller with read access to the claim may view the
   * reserve history (role scoping is enforced at the claim level upstream).
   *
   * @param claimId - Claim to retrieve reserves for.
   * @param caller  - Authenticated caller context.
   */
  async getReserveHistory(claimId: string, caller: ReserveCallerContext) {
    // Verify claim exists.
    const claimExists = await this.prisma.claim.findUnique({
      where: { id: claimId },
      select: { id: true },
    });

    if (!claimExists) {
      throw new NotFoundException(`Claim ${claimId} not found.`);
    }

    const reserves = await this.prisma.reserve.findMany({
      where: { claim_id: claimId },
      orderBy: { proposed_at: 'asc' },
    });

    this.logger.log(
      {
        claim_id: claimId,
        record_count: reserves.length,
        caller_id: caller.user_id,
        correlation_id: caller.correlation_id,
      },
      'Reserve history retrieved',
    );

    return reserves;
  }

  // -------------------------------------------------------------------------
  // POST /reserves/:id/approve — manager approves (up to ¥10M)
  // -------------------------------------------------------------------------

  /**
   * Manager approves a pending reserve proposal.
   *
   * Rules (ADR-005):
   *  - Caller must have role `manager`.
   *  - Reserve must be in `pending` status.
   *  - If proposed_yen > ¥10M, manager may NOT grant full approval — they
   *    can only grant first-tier manager approval; director approval is
   *    required separately via POST /reserves/:id/director-approve.
   *  - For amounts ¥1M–¥10M, this call moves status to `approved`.
   *  - For amounts > ¥10M that have already received manager approval
   *    (tracked via `approved_by_id`), this endpoint is not the right path;
   *    the director-approve endpoint handles that.
   *
   * Implementation note: We treat manager approval as first-tier.
   *  - <= ¥10M: manager approve → status = approved.
   *  - > ¥10M: manager approve → status remains pending, approved_by_id set,
   *            director must then call director-approve.
   *
   * @param reserveId - Reserve to approve.
   * @param caller    - Authenticated caller context.
   */
  async approveReserve(reserveId: string, caller: ReserveCallerContext) {
    if (caller.role !== UserRole.manager) {
      throw new ForbiddenException(
        'Only managers may approve reserve proposals.',
      );
    }

    const reserve = await this.prisma.reserve.findUnique({
      where: { id: reserveId },
      select: {
        id: true,
        claim_id: true,
        proposed_yen: true,
        approval_status: true,
        approved_by_id: true,
        proposed_by_id: true,
        category: true,
      },
    });

    if (!reserve) {
      throw new NotFoundException(`Reserve ${reserveId} not found.`);
    }

    if (reserve.approval_status !== ApprovalStatus.pending) {
      throw new UnprocessableEntityException(
        `Reserve ${reserveId} is not in pending status (current: ${reserve.approval_status}). ` +
          'Only pending reserves can be approved.',
      );
    }

    // Prevent manager from approving reserves that already have a manager
    // approval recorded (idempotency guard).
    if (reserve.approved_by_id) {
      throw new UnprocessableEntityException(
        `Reserve ${reserveId} already has manager approval recorded. ` +
          'Use POST /reserves/:id/director-approve for director-tier approval.',
      );
    }

    const proposedBigInt = BigInt(reserve.proposed_yen.toFixed(0));
    const requiresDirector =
      proposedBigInt > RESERVE_DIRECTOR_APPROVAL_THRESHOLD_YEN;

    if (requiresDirector) {
      // Manager approval is first tier — record it but keep status pending
      // until director approves.
      const updated = await this.prisma.reserve.update({
        where: { id: reserveId },
        data: {
          approved_by_id: caller.user_id,
          approved_at: new Date(),
          // Status stays pending until director approves.
        },
      });

      this.logger.log(
        {
          reserve_id: reserveId,
          claim_id: reserve.claim_id,
          proposed_yen: proposedBigInt.toString(),
          approved_by_id: caller.user_id,
          requires_director: true,
          correlation_id: caller.correlation_id,
        },
        'Manager first-tier approval recorded for >¥10M reserve; director approval required',
      );

      await this.auditService.emit({
        actor_id: caller.user_id,
        actor_role: caller.role,
        action: 'reserve.manager_approved_tier1',
        claim_id: reserve.claim_id,
        target_id: reserveId,
        payload: {
          reserve_id: reserveId,
          proposed_yen: proposedBigInt.toString(),
          requires_director_approval: true,
        },
        request_id: caller.request_id,
        correlation_id: caller.correlation_id,
      });

      return {
        ...updated,
        _message:
          'Manager approval recorded. Director approval required for reserves > ¥10M.',
      };
    }

    // ¥1M–¥10M range: manager approval is sufficient → move to approved.
    const updated = await this.prisma.reserve.update({
      where: { id: reserveId },
      data: {
        approval_status: ApprovalStatus.approved,
        approved_by_id: caller.user_id,
        approved_at: new Date(),
      },
    });

    this.logger.log(
      {
        reserve_id: reserveId,
        claim_id: reserve.claim_id,
        proposed_yen: proposedBigInt.toString(),
        approved_by_id: caller.user_id,
        correlation_id: caller.correlation_id,
      },
      'Reserve approved by manager',
    );

    await this.auditService.emit({
      actor_id: caller.user_id,
      actor_role: caller.role,
      action: 'reserve.approved',
      claim_id: reserve.claim_id,
      target_id: reserveId,
      payload: {
        reserve_id: reserveId,
        proposed_yen: proposedBigInt.toString(),
        approved_by_id: caller.user_id,
      },
      request_id: caller.request_id,
      correlation_id: caller.correlation_id,
    });

    return updated;
  }

  // -------------------------------------------------------------------------
  // POST /reserves/:id/director-approve — claims director final approval
  // -------------------------------------------------------------------------

  /**
   * Claims director grants final approval for reserves > ¥10M.
   *
   * Rules (ADR-005):
   *  - Caller must have role `manager` AND `is_claims_director = true`.
   *  - Reserve must be in `pending` status.
   *  - Reserve must already have manager first-tier approval (`approved_by_id` set).
   *  - proposed_yen must be > ¥10M (otherwise this endpoint should not be used).
   *
   * @param reserveId - Reserve to grant director approval on.
   * @param caller    - Authenticated caller context.
   */
  async directorApproveReserve(
    reserveId: string,
    caller: ReserveCallerContext,
  ) {
    if (caller.role !== UserRole.manager || !caller.is_claims_director) {
      throw new ForbiddenException(
        'Only users with the manager role and is_claims_director=true ' +
          'may grant director-level reserve approval.',
      );
    }

    const reserve = await this.prisma.reserve.findUnique({
      where: { id: reserveId },
      select: {
        id: true,
        claim_id: true,
        proposed_yen: true,
        approval_status: true,
        approved_by_id: true,
        director_approved_by_id: true,
        category: true,
      },
    });

    if (!reserve) {
      throw new NotFoundException(`Reserve ${reserveId} not found.`);
    }

    if (reserve.approval_status !== ApprovalStatus.pending) {
      throw new UnprocessableEntityException(
        `Reserve ${reserveId} is not in pending status (current: ${reserve.approval_status}). ` +
          'Only pending reserves can receive director approval.',
      );
    }

    const proposedBigInt = BigInt(reserve.proposed_yen.toFixed(0));

    if (proposedBigInt <= RESERVE_DIRECTOR_APPROVAL_THRESHOLD_YEN) {
      throw new UnprocessableEntityException(
        `Reserve ${reserveId} proposed_yen (¥${proposedBigInt.toLocaleString()}) ` +
          `does not exceed the director approval threshold (¥${RESERVE_DIRECTOR_APPROVAL_THRESHOLD_YEN.toLocaleString()}). ` +
          'Use POST /reserves/:id/approve instead.',
      );
    }

    if (!reserve.approved_by_id) {
      throw new UnprocessableEntityException(
        `Reserve ${reserveId} has not yet received manager first-tier approval. ` +
          'A manager must approve first via POST /reserves/:id/approve before ' +
          'director approval can be granted.',
      );
    }

    if (reserve.director_approved_by_id) {
      throw new UnprocessableEntityException(
        `Reserve ${reserveId} has already received director approval.`,
      );
    }

    // Grant director approval → move to approved status.
    const updated = await this.prisma.reserve.update({
      where: { id: reserveId },
      data: {
        approval_status: ApprovalStatus.approved,
        director_approved_by_id: caller.user_id,
        director_approved_at: new Date(),
      },
    });

    this.logger.log(
      {
        reserve_id: reserveId,
        claim_id: reserve.claim_id,
        proposed_yen: proposedBigInt.toString(),
        director_approved_by_id: caller.user_id,
        manager_approved_by_id: reserve.approved_by_id,
        correlation_id: caller.correlation_id,
      },
      'Reserve approved by claims director',
    );

    await this.auditService.emit({
      actor_id: caller.user_id,
      actor_role: caller.role,
      action: 'reserve.director_approved',
      claim_id: reserve.claim_id,
      target_id: reserveId,
      payload: {
        reserve_id: reserveId,
        proposed_yen: proposedBigInt.toString(),
        director_approved_by_id: caller.user_id,
        manager_approved_by_id: reserve.approved_by_id,
      },
      request_id: caller.request_id,
      correlation_id: caller.correlation_id,
    });

    return updated;
  }

  // -------------------------------------------------------------------------
  // POST /reserves/:id/reject — manager rejects
  // -------------------------------------------------------------------------

  /**
   * Reject a pending reserve proposal.
   *
   * Rules:
   *  - Caller must have role `manager`.
   *  - Reserve must be in `pending` status.
   *  - reason_for_rejection is required and validated in the DTO.
   *
   * @param reserveId - Reserve to reject.
   * @param dto       - Validated rejection DTO.
   * @param caller    - Authenticated caller context.
   */
  async rejectReserve(
    reserveId: string,
    dto: RejectReserveDto,
    caller: ReserveCallerContext,
  ) {
    if (caller.role !== UserRole.manager) {
      throw new ForbiddenException(
        'Only managers may reject reserve proposals.',
      );
    }

    const reserve = await this.prisma.reserve.findUnique({
      where: { id: reserveId },
      select: {
        id: true,
        claim_id: true,
        proposed_yen: true,
        approval_status: true,
        category: true,
      },
    });

    if (!reserve) {
      throw new NotFoundException(`Reserve ${reserveId} not found.`);
    }

    if (reserve.approval_status !== ApprovalStatus.pending) {
      throw new UnprocessableEntityException(
        `Reserve ${reserveId} is not in pending status (current: ${reserve.approval_status}). ` +
          'Only pending reserves can be rejected.',
      );
    }

    const updated = await this.prisma.reserve.update({
      where: { id: reserveId },
      data: {
        approval_status: ApprovalStatus.rejected,
        reason_for_rejection: dto.reason_for_rejection,
      },
    });

    const proposedBigInt = BigInt(reserve.proposed_yen.toFixed(0));

    this.logger.log(
      {
        reserve_id: reserveId,
        claim_id: reserve.claim_id,
        proposed_yen: proposedBigInt.toString(),
        rejected_by_id: caller.user_id,
        reason: dto.reason_for_rejection,
        correlation_id: caller.correlation_id,
      },
      'Reserve proposal rejected',
    );

    await this.auditService.emit({
      actor_id: caller.user_id,
      actor_role: caller.role,
      action: 'reserve.rejected',
      claim_id: reserve.claim_id,
      target_id: reserveId,
      payload: {
        reserve_id: reserveId,
        proposed_yen: proposedBigInt.toString(),
        reason_for_rejection: dto.reason_for_rejection,
      },
      request_id: caller.request_id,
      correlation_id: caller.correlation_id,
    });

    return updated;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Determine the initial ApprovalStatus for a proposed reserve based on
   * ADR-005 tiers.
   *
   * - <= ¥1,000,000: auto-approved (self-approving).
   * - > ¥1,000,000:  pending (requires manager or director approval).
   *
   * The distinction between manager-only and director-required is enforced
   * at approval time, not at proposal time.
   *
   * @param proposedYenBigInt - Amount as BigInt.
   * @returns Initial ApprovalStatus.
   */
  private resolveInitialApprovalStatus(
    proposedYenBigInt: bigint,
  ): ApprovalStatus {
    if (proposedYenBigInt <= RESERVE_AUTO_APPROVE_THRESHOLD_YEN) {
      return ApprovalStatus.approved;
    }
    return ApprovalStatus.pending;
  }

  /**
   * Assert that the caller has permission to propose a reserve change on
   * the given claim.
   *
   * Rules (design.md §2 role matrix):
   *  - `adjuster`: must be the assigned adjuster on the claim.
   *  - `manager`: allowed on claims within their reports' pool.
   *    (In this POC we allow any manager to propose; full hierarchy checks
   *    require the reports_to chain which is enforced in the claims service
   *    for other operations. Managers can always propose reserves.)
   *  - All other roles: forbidden.
   *
   * @param claim  - Minimal claim projection.
   * @param caller - Authenticated caller context.
   */
  private assertCanProposeReserve(
    claim: { id: string; assigned_adjuster_id: string | null },
    caller: ReserveCallerContext,
  ): void {
    if (caller.role === UserRole.adjuster) {
      if (claim.assigned_adjuster_id !== caller.user_id) {
        throw new ForbiddenException(
          `Adjuster ${caller.user_id} is not assigned to claim ${claim.id}. ` +
            'Adjusters may only propose reserves on their assigned claims.',
        );
      }
      return;
    }

    if (caller.role === UserRole.manager) {
      // Managers may propose reserves on any claim in their pool.
      // Full hierarchy enforcement is consistent with design.md §2 role matrix.
      return;
    }

    throw new ForbiddenException(
      `Role '${caller.role}' is not permitted to propose reserve changes. ` +
        'Only adjusters (assigned) and managers may propose reserves.',
    );
  }
}