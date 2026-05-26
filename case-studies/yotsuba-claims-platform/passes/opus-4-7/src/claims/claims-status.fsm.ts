// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// Claim status finite-state machine.
//
// Per ADR-004, the workflow logic for claim status transitions lives
// in a single pure function so that every reviewer — adjuster, manager,
// auditor, regulator — can read the entire state machine in one file
// and trust that no other module is silently mutating `Claim.status`.
//
// The transitions encoded here come from the brief:
//
//   intake
//     → under_investigation         (adjuster picks the claim up)
//
//   under_investigation
//     → awaiting_reserve_approval   (reserve proposed, pending sign-off)
//     → closed_denied               (coverage denied outright)
//
//   awaiting_reserve_approval
//     → under_investigation         (reserve rejected, return to work)
//     → settlement_offered          (reserve approved, offer extended)
//
//   settlement_offered
//     → closed_paid                 (offer accepted, payout issued)
//     → closed_denied               (offer withdrawn / claim denied)
//     → under_investigation         (offer disputed, reopen workup)
//
//   closed_paid
//     → reopened                    (e.g. supplemental damage discovered)
//
//   closed_denied
//     → reopened                    (e.g. new evidence surfaces)
//
//   reopened
//     → under_investigation         (resume workup after reopen)
//
// Authority rules layered on top of the transition graph:
//
//   * Transitions out of `closed_paid` or `closed_denied` (reopens)
//     and into the terminal `closed_*` states require `manager`
//     authority. Reopening a settled claim has financial and
//     regulatory weight; closing one terminates the case file.
//   * All other transitions are permitted to `adjuster` and `manager`.
//   * `agent`, `auditor`, and `siu_referrer` may not drive the FSM
//     at all — the controller guard rejects them before this
//     function is reached, but we double-check here for defence in
//     depth and so the FSM stands alone as the source of truth.
//
// The function is intentionally pure: no I/O, no database, no logging.
// The caller (`ClaimsService`) is responsible for persisting the new
// status, emitting the `claim.status.changed` audit event, and
// surfacing the `reason` field from a rejection as the HTTP 422 body.
// ─────────────────────────────────────────────────────────────────────────

import { ClaimStatus, UserRole } from '@prisma/client';

/**
 * Result of an FSM evaluation.
 *
 * When `ok` is `true`, the transition is legal and the caller may
 * persist the new status. When `ok` is `false`, `reason` carries a
 * human-readable explanation suitable for inclusion verbatim in the
 * HTTP 422 response body, as required by the brief:
 *
 *   > illegal transitions return 422 with explanation.
 */
export type FsmResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Minimal shape of a claim the FSM needs to reason about. We keep
 * this an interface rather than importing the full Prisma `Claim`
 * type so that the FSM can be unit-tested with plain object
 * literals and remains decoupled from the persistence layer.
 *
 * `assigned_adjuster_id` is included because some future transition
 * rules may want to verify the actor is the assignee; today the
 * controller layer enforces that check, but the field is here so the
 * FSM signature is stable.
 */
export interface FsmClaim {
  status: ClaimStatus;
  assigned_adjuster_id: string | null;
}

/**
 * Minimal shape of the actor driving the transition. Only the role
 * is consulted today; `id` is included so authority rules that may
 * later want to compare actor identity to claim assignment can do so
 * without a signature change.
 */
export interface FsmActor {
  id: string;
  role: UserRole;
  is_claims_director?: boolean;
}

/**
 * Adjacency list of legal transitions. Anything not listed here is
 * rejected. Terminal-looking states (`closed_paid`, `closed_denied`)
 * still have outgoing edges to `reopened` because the brief
 * explicitly lists `reopened` as a workflow state.
 */
const TRANSITIONS: Readonly<Record<ClaimStatus, readonly ClaimStatus[]>> = {
  intake: ['under_investigation'],
  under_investigation: ['awaiting_reserve_approval', 'closed_denied'],
  awaiting_reserve_approval: ['under_investigation', 'settlement_offered'],
  settlement_offered: ['closed_paid', 'closed_denied', 'under_investigation'],
  closed_paid: ['reopened'],
  closed_denied: ['reopened'],
  reopened: ['under_investigation'],
};

/**
 * Transitions that require `manager` authority. Adjusters may drive
 * the day-to-day workflow but may not close a claim or reopen a
 * closed one — those acts have financial / regulatory weight and
 * are reserved to managers.
 */
const MANAGER_ONLY_TRANSITIONS: ReadonlyArray<readonly [ClaimStatus, ClaimStatus]> = [
  ['under_investigation', 'closed_denied'],
  ['settlement_offered', 'closed_paid'],
  ['settlement_offered', 'closed_denied'],
  ['closed_paid', 'reopened'],
  ['closed_denied', 'reopened'],
];

/**
 * Roles that are permitted to drive the FSM at all. Other roles
 * (`agent`, `auditor`, `siu_referrer`) are rejected outright; the
 * controller guard would normally have stopped them first, but the
 * FSM enforces the rule independently so it stands alone as the
 * source of truth on workflow authority.
 */
const FSM_CAPABLE_ROLES: readonly UserRole[] = ['adjuster', 'manager'];

function isManagerOnly(from: ClaimStatus, to: ClaimStatus): boolean {
  return MANAGER_ONLY_TRANSITIONS.some(
    ([f, t]) => f === from && t === to,
  );
}

/**
 * Evaluate whether `actor` may transition `claim` from its current
 * `status` to `to`.
 *
 * Pure function: returns `{ok: true}` if the transition is legal and
 * authorised, or `{ok: false, reason}` with a human-readable
 * explanation otherwise. The caller is responsible for persistence
 * and audit emission.
 *
 * @param claim   the claim being transitioned (only `status` and
 *                `assigned_adjuster_id` are consulted)
 * @param to      the target status
 * @param actor   the user driving the transition
 */
export function evaluateTransition(
  claim: FsmClaim,
  to: ClaimStatus,
  actor: FsmActor,
): FsmResult {
  const from = claim.status;

  // No-op transitions are rejected explicitly so the audit log does
  // not accumulate spurious `claim.status.changed` events.
  if (from === to) {
    return {
      ok: false,
      reason: `Claim is already in status '${from}'; no transition required.`,
    };
  }

  if (!FSM_CAPABLE_ROLES.includes(actor.role)) {
    return {
      ok: false,
      reason:
        `Role '${actor.role}' is not permitted to change claim status. `
        + `Only 'adjuster' and 'manager' may drive the claim workflow.`,
    };
  }

  const allowed = TRANSITIONS[from];
  if (!allowed.includes(to)) {
    const allowedList = allowed.length > 0
      ? allowed.map((s) => `'${s}'`).join(', ')
      : '(none)';
    return {
      ok: false,
      reason:
        `Illegal status transition from '${from}' to '${to}'. `
        + `Allowed next states from '${from}': ${allowedList}.`,
    };
  }

  if (isManagerOnly(from, to) && actor.role !== 'manager') {
    return {
      ok: false,
      reason:
        `Transition from '${from}' to '${to}' requires 'manager' authority; `
        + `role '${actor.role}' is not permitted to perform it.`,
    };
  }

  return { ok: true };
}

/**
 * Convenience accessor for the transition graph, intended for
 * introspection (e.g. building a workbench dropdown of legal next
 * states). Returns a defensive copy so callers cannot mutate the
 * canonical table.
 */
export function allowedNextStates(from: ClaimStatus): ClaimStatus[] {
  return [...TRANSITIONS[from]];
}