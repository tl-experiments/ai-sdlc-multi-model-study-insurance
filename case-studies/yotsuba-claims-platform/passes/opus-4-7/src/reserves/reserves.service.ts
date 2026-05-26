// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// Reserves service — the actuarial-touching layer of the claims spine.
//
// This service is the single writer of `Reserve` rows and the
// orchestrator of the approval lifecycle. The brief (Module 3 —
// Reserves Management) and ADR-005 (design.md §4) together pin
// down the rules this file enforces:
//
//   * Reserves are proposed by the *assigned* adjuster on a claim;
//     any other adjuster is refused (the role matrix in brief.md
//     restricts `Reserve — propose` to "assigned only").
//   * Justification is mandatory and ≥ 50 characters — enforced at
//     the DTO layer; we trust the validator and do not re-check.
//   * Approval thresholds (ADR-005):
//       - ≤ ¥1,000,000     → self-approving (auto-approved on proposal);
//       - > ¥1M, ≤ ¥10M    → requires a single manager approval;
//       - > ¥10,000,000    → requires manager approval **and**
//                            a claims-director approval (the
//                            `is_claims_director` flag on User).
//   * The JFSA threshold (¥100M; brief Module 3 + ADR-006) emits a
//     `NotificationToRegulator` row on proposal *and* on approval
//     — both moments are auditable.
//   * Full immutable history per claim — we never UPDATE the
//     `proposed_yen` / `category` / `justification` columns after
//     creation. State columns (`approval_status`, approver IDs,
//     timestamps, `reason_for_rejection`) are the only mutable
//     fields, and only via the controlled approve / reject paths.
//
// The thresholds themselves live in this file as named constants
// (per design.md §6 — "regulatory thresholds encoded as policy,
// not magic numbers"). The JFSA threshold lives in
// `reserves-jfsa.service.ts` for the same reason.
//
// Audit events are emitted by the controller via the
// `@Audit({...})` decorator on each route — this service emits no
// audit rows directly. It does, however, return the persisted
// `Reserve` row so the interceptor has the canonical payload to
// hash.
// ─────────────────────────────────────────────────────────────────────────

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Reserve, UserRole } from '@prisma/client';

import { PrismaService } from '../prisma.service';
import { ProposeReserveDto } from './dto/propose-reserve.dto';
import { RejectReserveDto } from './dto/reject-reserve.dto';
import { ReservesJfsaService } from './reserves-jfsa.service';

/**
 * Self-approval ceiling, in whole yen. Reserves proposed at or
 * below this figure are auto-approved on creation — the proposing
 * adjuster's authority covers them outright. See ADR-005.
 */
export const RESERVE_SELF_APPROVAL_CEILING_YEN = new Prisma.Decimal(
  '1000000',
);

/**
 * Manager-approval ceiling, in whole yen. Reserves above this
 * figure require an additional claims-director approval beyond
 * the manager's. See ADR-005.
 */
export const RESERVE_MANAGER_APPROVAL_CEILING_YEN = new Prisma.Decimal(
  '10000000',
);

/**
 * Caller envelope — the minimum surface this service needs from
 * the authenticated user. Defined locally to keep the service
 * decoupled from the JWT payload shape.
 */
export interface ReservesCaller {
  id: string;
  role: UserRole;
  is_claims_director: boolean;
}

/**
 * Pure predicate: does a given proposed amount require director
 * approval on top of manager approval? Exported for use by tests
 * and by the controller's pre-flight guard on the
 * `director-approve` route.
 */
export function requiresDirectorApproval(
  amount_yen: Prisma.Decimal,
): boolean {
  return amount_yen.cmp(RESERVE_MANAGER_APPROVAL_CEILING_YEN) > 0;
}

/**
 * Pure predicate: is the proposed amount within the proposing
 * adjuster's self-approval authority?
 */
export function isSelfApproving(amount_yen: Prisma.Decimal): boolean {
  return amount_yen.cmp(RESERVE_SELF_APPROVAL_CEILING_YEN) <= 0;
}

@Injectable()
export class ReservesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jfsa: ReservesJfsaService,
  ) {}

  // ───────────────────────────────────────────────────────────────
  // Propose
  // ───────────────────────────────────────────────────────────────

  /**
   * Propose a reserve change against a claim. Restricted to the
   * *assigned* adjuster by the role matrix; the controller's
   * `RolesGuard` confirms the caller is an adjuster, and this
   * method confirms the assignment.
   *
   * Side effects:
   *   * Creates the `Reserve` row.
   *   * If `proposed_yen ≤ ¥1M`, marks it auto-approved (the
   *     proposing adjuster acts as approver of record).
   *   * Snapshots the most recent prior reserve amount in the
   *     same category onto `prior_yen` so the history is
   *     self-describing.
   *   * Records a JFSA notification if the figure crosses ¥100M.
   *
   * Returns the persisted row so the audit interceptor can hash
   * it.
   */
  async propose(
    claim_id: string,
    dto: ProposeReserveDto,
    caller: ReservesCaller,
  ): Promise<Reserve> {
    const claim = await this.prisma.claim.findUnique({
      where: { id: claim_id },
      select: { id: true, assigned_adjuster_id: true },
    });
    if (claim === null) {
      throw new NotFoundException(`Claim ${claim_id} not found.`);
    }

    // The role matrix says "assigned only" — refuse any adjuster
    // who is not the current assignee. Managers and others are
    // already excluded by the controller's `@Roles(adjuster)`.
    if (
      caller.role === 'adjuster' &&
      claim.assigned_adjuster_id !== caller.id
    ) {
      throw new ForbiddenException(
        'Only the assigned adjuster may propose a reserve for this claim.',
      );
    }

    const proposed_yen = new Prisma.Decimal(dto.proposed_yen);
    if (proposed_yen.isNegative()) {
      throw new BadRequestException(
        'proposed_yen must be a non-negative integer.',
      );
    }

    // Snapshot the most recent prior reserve in the same
    // category. The history is append-only, so "most recent" is
    // unambiguously the latest `proposed_at` in that category.
    const prior = await this.prisma.reserve.findFirst({
      where: { claim_id, category: dto.category },
      orderBy: { proposed_at: 'desc' },
      select: { proposed_yen: true },
    });

    const selfApproving = isSelfApproving(proposed_yen);
    const now = new Date();

    const reserve = await this.prisma.reserve.create({
      data: {
        claim_id,
        category: dto.category,
        proposed_yen,
        prior_yen: prior?.proposed_yen ?? null,
        justification: dto.justification,
        proposed_by_id: caller.id,
        approval_status: selfApproving ? 'approved' : 'pending',
        approved_by_id: selfApproving ? caller.id : null,
        approved_at: selfApproving ? now : null,
      },
    });

    // JFSA notification — both proposal-time and (if self-
    // approving) approval-time events fire from here. The
    // producer is a no-op below the threshold.
    await this.jfsa.recordIfThresholdCrossed({
      claim_id,
      reserve_id: reserve.id,
      amount_yen: proposed_yen,
      stage: 'proposed',
    });
    if (selfApproving) {
      await this.jfsa.recordIfThresholdCrossed({
        claim_id,
        reserve_id: reserve.id,
        amount_yen: proposed_yen,
        stage: 'approved',
      });
    }

    return reserve;
  }

  // ───────────────────────────────────────────────────────────────
  // History / read
  // ───────────────────────────────────────────────────────────────

  /**
   * Return the full immutable reserve history for a claim,
   * oldest-first. The brief calls this out explicitly as
   * "critical for audit and IFRS17 walk-forwards".
   */
  async historyForClaim(claim_id: string): Promise<Reserve[]> {
    const claim = await this.prisma.claim.findUnique({
      where: { id: claim_id },
      select: { id: true },
    });
    if (claim === null) {
      throw new NotFoundException(`Claim ${claim_id} not found.`);
    }
    return this.prisma.reserve.findMany({
      where: { claim_id },
      orderBy: { proposed_at: 'asc' },
    });
  }

  /**
   * Load a single reserve by id, throwing 404 if absent. Used by
   * the approve/reject paths and exposed to the controller for
   * the rare direct-fetch case.
   */
  async findById(reserve_id: string): Promise<Reserve> {
    const reserve = await this.prisma.reserve.findUnique({
      where: { id: reserve_id },
    });
    if (reserve === null) {
      throw new NotFoundException(`Reserve ${reserve_id} not found.`);
    }
    return reserve;
  }

  // ───────────────────────────────────────────────────────────────
  // Approve (manager)
  // ───────────────────────────────────────────────────────────────

  /**
   * Manager-level approval. Permitted only when:
   *   * the row is still `pending`;
   *   * the proposed amount is ≤ ¥10M (above that, the
   *     director-approve path is the only legitimate entry);
   *   * the approver is not the proposer (segregation of
   *     duties — even though the role guard already excludes
   *     adjusters, an adjuster who is also a manager-equivalent
   *     in some future RBAC twist should still not self-
   *     approve).
   *
   * For reserves > ¥10M we *still* allow a manager to record
   * their approval — but the row stays `pending` until a
   * director also signs off. This is the two-key pattern: both
   * approvers must act, neither alone suffices. The transition
   * to `approved` happens on whichever sign-off arrives second.
   */
  async approve(
    reserve_id: string,
    caller: ReservesCaller,
  ): Promise<Reserve> {
    const reserve = await this.findById(reserve_id);

    if (reserve.approval_status === 'rejected') {
      throw new BadRequestException(
        'Reserve has already been rejected and cannot be approved.',
      );
    }
    if (reserve.approved_by_id !== null) {
      throw new BadRequestException(
        'Reserve has already received manager approval.',
      );
    }
    if (reserve.proposed_by_id === caller.id) {
      throw new ForbiddenException(
        'A reserve cannot be approved by its proposer.',
      );
    }

    const now = new Date();
    const needsDirector = requiresDirectorApproval(reserve.proposed_yen);
    // If the row also already has a director sign-off, the
    // manager's approval is the second key and flips the row to
    // `approved`. Otherwise, if no director sign-off is needed,
    // the manager's approval alone is sufficient.
    const hasDirector = reserve.director_approved_by_id !== null;
    const becomesApproved = !needsDirector || hasDirector;

    const updated = await this.prisma.reserve.update({
      where: { id: reserve_id },
      data: {
        approved_by_id: caller.id,
        approved_at: now,
        approval_status: becomesApproved ? 'approved' : 'pending',
      },
    });

    if (becomesApproved) {
      await this.jfsa.recordIfThresholdCrossed({
        claim_id: updated.claim_id,
        reserve_id: updated.id,
        amount_yen: updated.proposed_yen,
        stage: 'approved',
      });
    }

    return updated;
  }

  // ───────────────────────────────────────────────────────────────
  // Director-approve
  // ───────────────────────────────────────────────────────────────

  /**
   * Claims-director approval. Required for proposals > ¥10M; a
   * no-op-with-422 for proposals at or below that threshold so
   * the path is not abused as an alternative manager-approve.
   *
   * Caller must carry `is_claims_director = true`; the
   * controller's guard checks the role + flag, and we re-check
   * here for defence in depth.
   */
  async directorApprove(
    reserve_id: string,
    caller: ReservesCaller,
  ): Promise<Reserve> {
    if (!caller.is_claims_director) {
      throw new ForbiddenException(
        'Only a claims director may director-approve a reserve.',
      );
    }

    const reserve = await this.findById(reserve_id);

    if (reserve.approval_status === 'rejected') {
      throw new BadRequestException(
        'Reserve has already been rejected and cannot be approved.',
      );
    }
    if (!requiresDirectorApproval(reserve.proposed_yen)) {
      throw new BadRequestException(
        'Director approval is only required for reserves above ¥10,000,000.',
      );
    }
    if (reserve.director_approved_by_id !== null) {
      throw new BadRequestException(
        'Reserve has already received director approval.',
      );
    }
    if (reserve.proposed_by_id === caller.id) {
      throw new ForbiddenException(
        'A reserve cannot be approved by its proposer.',
      );
    }

    const now = new Date();
    // Two-key: if the manager has already signed off, this
    // director sign-off is the second key and flips to
    // `approved`. Otherwise the row stays `pending` until the
    // manager also acts.
    const hasManager = reserve.approved_by_id !== null;
    const becomesApproved = hasManager;

    const updated = await this.prisma.reserve.update({
      where: { id: reserve_id },
      data: {
        director_approved_by_id: caller.id,
        director_approved_at: now,
        approval_status: becomesApproved ? 'approved' : 'pending',
      },
    });

    if (becomesApproved) {
      await this.jfsa.recordIfThresholdCrossed({
        claim_id: updated.claim_id,
        reserve_id: updated.id,
        amount_yen: updated.proposed_yen,
        stage: 'approved',
      });
    }

    return updated;
  }

  // ───────────────────────────────────────────────────────────────
  // Reject
  // ───────────────────────────────────────────────────────────────

  /**
   * Manager-level rejection. Permitted only when the row is
   * still `pending`. A rejected row is terminal — there is no
   * un-reject path; the adjuster proposes a new reserve
   * (preserving the rejected row in history).
   */
  async reject(
    reserve_id: string,
    dto: RejectReserveDto,
    caller: ReservesCaller,
  ): Promise<Reserve> {
    const reserve = await this.findById(reserve_id);

    if (reserve.approval_status !== 'pending') {
      throw new BadRequestException(
        `Reserve is in '${reserve.approval_status}' state and cannot be rejected.`,
      );
    }
    if (reserve.proposed_by_id === caller.id) {
      throw new ForbiddenException(
        'A reserve cannot be rejected by its proposer.',
      );
    }

    return this.prisma.reserve.update({
      where: { id: reserve_id },
      data: {
        approval_status: 'rejected',
        reason_for_rejection: dto.reason_for_rejection,
        // We deliberately do not stamp `approved_by_id` /
        // `approved_at` on rejection — those columns are
        // reserved for the positive-approval path. The audit
        // event captures the rejecting actor.
      },
    });
  }
}