// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/claims/claims-status.fsm.ts
//
// Pure finite-state machine for claim workflow status transitions.
//
// Design reference: design.md §4 ADR-004
// Brief reference:  brief.md §2 Adjuster Workbench — PATCH /claims/:id/status
//
// The FSM is a pure function — no I/O, no side effects — so it can be:
//   1. Unit-tested in complete isolation from the database and NestJS runtime.
//   2. Imported by the service layer for transition guarding.
//   3. Audited as a single artefact that encodes all legal workflow paths.
//
// Legal transition graph:
//
//   intake
//     → under_investigation          (adjuster or manager)
//
//   under_investigation
//     → awaiting_reserve_approval    (adjuster or manager)
//     → settlement_offered           (manager only — fast-track small claims)
//     → closed_denied                (manager only)
//
//   awaiting_reserve_approval
//     → settlement_offered           (manager only — after reserve approved)
//     → under_investigation          (manager only — send back)
//     → closed_denied                (manager only)
//
//   settlement_offered
//     → closed_paid                  (adjuster or manager)
//     → closed_denied                (manager only)
//     → reopened                     (manager only)
//
//   closed_paid
//     → reopened                     (manager only)
//
//   closed_denied
//     → reopened                     (manager only)
//
//   reopened
//     → under_investigation          (adjuster or manager)
//
// Terminal states without reopening: none (manager can always reopen a closed
// claim — JFSA regulations permit reopening within a prescribed window).
//
// Actor roles recognised:
//   'adjuster' — transitions that a working adjuster can initiate.
//   'manager'  — all adjuster transitions plus management-only transitions.
//   Any other role attempting a write transition will receive an ACTOR_NOT_PERMITTED
//   error (callers should guard with the role matrix before calling the FSM,
//   but the FSM itself is the last line of defence).
//
// Return shape:
//   { ok: true }                          — transition is legal
//   { ok: false; reason: string; code: FsmErrorCode } — transition refused
//
// Error codes are string literals so callers can switch on them without
// importing an enum separately.
// =============================================================================

import { ClaimStatus, UserRole } from '@prisma/client';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Discriminated union returned by `checkTransition`.
 *
 * On success the caller can proceed with the database update.
 * On failure the HTTP layer returns 422 Unprocessable Entity with the
 * human-readable `reason` field in the error envelope.
 */
export type FsmResult =
  | { ok: true }
  | { ok: false; reason: string; code: FsmErrorCode };

/**
 * Machine-readable error codes for FSM refusals.
 *
 * Callers may switch on these to produce localised error messages without
 * string-matching on `reason`.
 */
export type FsmErrorCode =
  | 'SAME_STATE'             // from === to; no-op transition
  | 'ILLEGAL_TRANSITION'     // edge does not exist in the graph
  | 'ACTOR_NOT_PERMITTED'    // actor's role is insufficient for this edge
  | 'REASON_REQUIRED';       // transition requires a non-empty reason

/**
 * Minimal claim context the FSM needs from the caller.
 *
 * The FSM does not query the database — the service layer resolves the claim
 * and passes the relevant fields in.
 */
export interface FsmClaimContext {
  /** Current persisted status of the claim. */
  current_status: ClaimStatus;
  /** The adjuster currently assigned to the claim (may be null). */
  assigned_adjuster_id: string | null;
}

/**
 * The actor requesting the transition.
 *
 * The FSM uses the role to enforce the role-specific edge restrictions
 * described in the transition graph above.
 */
export interface FsmActor {
  id: string;
  role: UserRole;
}

// ---------------------------------------------------------------------------
// Transition graph
// ---------------------------------------------------------------------------

/**
 * A single permitted edge in the FSM graph.
 *
 * `min_role` is the least-privileged role that may take this edge:
 *   - 'adjuster' → both adjusters AND managers may use this edge
 *   - 'manager'  → managers only
 *
 * This two-value scheme is sufficient for Track A; Track B may expand to
 * a set of roles if finer-grained control is needed.
 */
interface FsmEdge {
  from: ClaimStatus;
  to: ClaimStatus;
  /**
   * Minimum role required to traverse this edge.
   *
   * Roles in ascending privilege order (for this purpose):
   *   adjuster < manager
   *
   * When min_role is 'adjuster', both adjusters and managers may traverse.
   * When min_role is 'manager', only managers (and claims directors, who are
   * a flag on a manager) may traverse.
   */
  min_role: 'adjuster' | 'manager';
  /** When true, the `reason` field in the transition request must be non-empty. */
  reason_required: boolean;
}

/**
 * Complete legal edge list for the claim status FSM.
 *
 * This is the single source of truth referenced by ADR-004.
 * Every legal status transition in the system is encoded here; anything
 * not listed is illegal and will return ILLEGAL_TRANSITION.
 */
const EDGES: readonly FsmEdge[] = [
  // ── intake ────────────────────────────────────────────────────────────────
  {
    from: ClaimStatus.intake,
    to: ClaimStatus.under_investigation,
    min_role: 'adjuster',
    reason_required: false,
  },

  // ── under_investigation ───────────────────────────────────────────────────
  {
    from: ClaimStatus.under_investigation,
    to: ClaimStatus.awaiting_reserve_approval,
    min_role: 'adjuster',
    reason_required: false,
  },
  {
    // Fast-track small/straightforward claims that don't need formal reserve
    // approval — manager discretion.
    from: ClaimStatus.under_investigation,
    to: ClaimStatus.settlement_offered,
    min_role: 'manager',
    reason_required: true,
  },
  {
    from: ClaimStatus.under_investigation,
    to: ClaimStatus.closed_denied,
    min_role: 'manager',
    reason_required: true,
  },

  // ── awaiting_reserve_approval ─────────────────────────────────────────────
  {
    from: ClaimStatus.awaiting_reserve_approval,
    to: ClaimStatus.settlement_offered,
    min_role: 'manager',
    reason_required: false,
  },
  {
    // Send back for further investigation if reserve calculation is insufficient.
    from: ClaimStatus.awaiting_reserve_approval,
    to: ClaimStatus.under_investigation,
    min_role: 'manager',
    reason_required: true,
  },
  {
    from: ClaimStatus.awaiting_reserve_approval,
    to: ClaimStatus.closed_denied,
    min_role: 'manager',
    reason_required: true,
  },

  // ── settlement_offered ────────────────────────────────────────────────────
  {
    from: ClaimStatus.settlement_offered,
    to: ClaimStatus.closed_paid,
    min_role: 'adjuster',
    reason_required: false,
  },
  {
    from: ClaimStatus.settlement_offered,
    to: ClaimStatus.closed_denied,
    min_role: 'manager',
    reason_required: true,
  },
  {
    from: ClaimStatus.settlement_offered,
    to: ClaimStatus.reopened,
    min_role: 'manager',
    reason_required: true,
  },

  // ── closed_paid ───────────────────────────────────────────────────────────
  {
    from: ClaimStatus.closed_paid,
    to: ClaimStatus.reopened,
    min_role: 'manager',
    reason_required: true,
  },

  // ── closed_denied ─────────────────────────────────────────────────────────
  {
    from: ClaimStatus.closed_denied,
    to: ClaimStatus.reopened,
    min_role: 'manager',
    reason_required: true,
  },

  // ── reopened ──────────────────────────────────────────────────────────────
  {
    from: ClaimStatus.reopened,
    to: ClaimStatus.under_investigation,
    min_role: 'adjuster',
    reason_required: false,
  },
] as const;

// ---------------------------------------------------------------------------
// Role privilege helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the actor's role meets or exceeds the minimum role
 * required by the edge.
 *
 * Privilege ladder for FSM purposes:
 *   adjuster  → satisfies min_role 'adjuster'
 *   manager   → satisfies min_role 'adjuster' AND 'manager'
 *
 * Agents, auditors, and SIU referrers are not permitted to trigger any
 * status transition — the FSM will return ACTOR_NOT_PERMITTED for them
 * regardless of the edge's min_role.
 */
function roleIsAtLeast(
  actorRole: UserRole,
  minRole: 'adjuster' | 'manager',
): boolean {
  if (actorRole === UserRole.manager) {
    // Manager satisfies both 'adjuster' and 'manager' minimum requirements.
    return true;
  }
  if (actorRole === UserRole.adjuster) {
    // Adjuster satisfies only 'adjuster' minimum; cannot use manager-only edges.
    return minRole === 'adjuster';
  }
  // agent, auditor, siu_referrer — no write transitions permitted.
  return false;
}

// ---------------------------------------------------------------------------
// Core FSM function
// ---------------------------------------------------------------------------

/**
 * Checks whether a requested status transition is legal given the current
 * claim state and the requesting actor's role.
 *
 * @param claim   - Minimal claim context (current status, assigned adjuster).
 * @param actor   - The user requesting the transition.
 * @param to      - The target status being requested.
 * @param reason  - Optional reason string accompanying the transition request.
 *                  Required for edges that have `reason_required: true`.
 *
 * @returns `{ ok: true }` if the transition is permitted, or
 *          `{ ok: false, reason, code }` explaining why it was refused.
 *
 * @example
 * ```typescript
 * const result = checkTransition(
 *   { current_status: ClaimStatus.intake, assigned_adjuster_id: 'usr_abc' },
 *   { id: 'usr_abc', role: UserRole.adjuster },
 *   ClaimStatus.under_investigation,
 *   undefined,
 * );
 * // → { ok: true }
 * ```
 */
export function checkTransition(
  claim: FsmClaimContext,
  actor: FsmActor,
  to: ClaimStatus,
  reason?: string | null,
): FsmResult {
  const from = claim.current_status;

  // ── 1. Guard: same-state no-op ───────────────────────────────────────────
  if (from === to) {
    return {
      ok: false,
      code: 'SAME_STATE',
      reason: `Claim is already in status '${from}'. No transition performed.`,
    };
  }

  // ── 2. Find a matching edge ───────────────────────────────────────────────
  const edge = EDGES.find((e) => e.from === from && e.to === to);

  if (edge === undefined) {
    return {
      ok: false,
      code: 'ILLEGAL_TRANSITION',
      reason:
        `Transition from '${from}' to '${to}' is not a legal workflow step. ` +
        `Legal transitions from '${from}': ${legalTargetsFrom(from).join(', ') || 'none'}.`,
    };
  }

  // ── 3. Guard: actor role ──────────────────────────────────────────────────
  if (!roleIsAtLeast(actor.role, edge.min_role)) {
    return {
      ok: false,
      code: 'ACTOR_NOT_PERMITTED',
      reason:
        `Role '${actor.role}' is not permitted to transition a claim from ` +
        `'${from}' to '${to}'. Minimum required role: '${edge.min_role}'.`,
    };
  }

  // ── 4. Guard: reason required ─────────────────────────────────────────────
  if (edge.reason_required && (!reason || reason.trim().length === 0)) {
    return {
      ok: false,
      code: 'REASON_REQUIRED',
      reason:
        `A non-empty 'reason' is required when transitioning from '${from}' to '${to}'.`,
    };
  }

  // ── All guards passed ─────────────────────────────────────────────────────
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Utility helpers (exported for use in controller error messages and tests)
// ---------------------------------------------------------------------------

/**
 * Returns the list of legal target statuses reachable from a given status.
 *
 * Useful for generating helpful error messages when an illegal transition
 * is attempted, and for rendering the available transition options in the
 * Adjuster Workbench quick-action panel.
 *
 * @param from - The current claim status.
 * @returns Array of ClaimStatus values reachable from `from`.
 */
export function legalTargetsFrom(from: ClaimStatus): ClaimStatus[] {
  return EDGES.filter((e) => e.from === from).map((e) => e.to);
}

/**
 * Returns the list of legal target statuses reachable from a given status
 * that the specified role is permitted to take.
 *
 * Useful for rendering role-filtered quick-action options in the workbench
 * without exposing transitions the actor cannot perform.
 *
 * @param from  - The current claim status.
 * @param role  - The actor's role.
 * @returns Array of ClaimStatus values the role can transition to from `from`.
 */
export function legalTargetsFromForRole(
  from: ClaimStatus,
  role: UserRole,
): ClaimStatus[] {
  return EDGES.filter(
    (e) => e.from === from && roleIsAtLeast(role, e.min_role),
  ).map((e) => e.to);
}

/**
 * Returns true if the given status is a terminal state from which no
 * further transitions are possible without managerial intervention
 * (i.e., the only outbound edge is `→ reopened`, or there are no edges).
 *
 * Used by the workbench UI to visually distinguish closed vs active claims.
 *
 * @param status - The claim status to query.
 * @returns true if the status is effectively closed.
 */
export function isClosedStatus(status: ClaimStatus): boolean {
  const outbound = EDGES.filter((e) => e.from === status);
  if (outbound.length === 0) return true;
  return outbound.every((e) => e.to === ClaimStatus.reopened);
}

/**
 * Returns whether a specific edge (from → to) requires a reason string.
 *
 * Exposed so the workbench can dynamically show/hide the reason input field
 * before the adjuster submits the transition request.
 *
 * @param from - Source status.
 * @param to   - Target status.
 * @returns true if the edge requires a non-empty reason, false otherwise.
 *          Returns false for non-existent edges (the FSM will reject them
 *          for a different reason).
 */
export function isReasonRequired(from: ClaimStatus, to: ClaimStatus): boolean {
  const edge = EDGES.find((e) => e.from === from && e.to === to);
  return edge?.reason_required ?? false;
}

/**
 * Returns the full edge list for documentation and testing purposes.
 *
 * Not intended for runtime use in the service layer — prefer
 * `checkTransition` for all transition decisions.
 */
export function getEdges(): ReadonlyArray<Readonly<FsmEdge>> {
  return EDGES;
}