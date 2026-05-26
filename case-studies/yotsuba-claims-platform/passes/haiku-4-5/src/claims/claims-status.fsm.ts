import { ClaimStatus } from '@prisma/client';

/**
 * Claim status finite-state machine.
 *
 * This module defines the legal state transitions for a claim throughout its lifecycle,
 * from initial intake through investigation, reserve approval, settlement, and closure.
 *
 * The FSM is a pure function that takes the current state, desired next state, and claim context,
 * and returns either {ok: true} or {ok: false, reason: string} explaining why the transition
 * is illegal.
 *
 * This centralized FSM ensures that all workflow logic is auditable and testable in one place,
 * rather than scattered across multiple service methods.
 *
 * Legal transitions:
 *   intake → under_investigation
 *   under_investigation → awaiting_reserve_approval | settlement_offered | closed_denied
 *   awaiting_reserve_approval → settlement_offered | closed_denied
 *   settlement_offered → closed_paid | reopened
 *   closed_paid → (terminal)
 *   closed_denied → reopened
 *   reopened → under_investigation
 *
 * All other transitions are illegal and will be rejected with a reason.
 */

export interface FsmTransitionResult {
  ok: boolean;
  reason?: string;
}

export interface FsmContext {
  claimId: string;
  currentStatus: ClaimStatus;
  desiredStatus: ClaimStatus;
  actorRole: string; // 'agent' | 'adjuster' | 'manager' | 'auditor' | 'siu_referrer'
  hasReserveApproval?: boolean; // true if all required reserves are approved
}

/**
 * Validates a claim status transition.
 *
 * @param context - The FSM context including current state, desired state, and actor role
 * @returns FsmTransitionResult with ok=true if transition is legal, ok=false with reason if illegal
 *
 * Authorization:
 *   - Agents cannot transition claim status (read-only after FNOL submission)
 *   - Adjusters can transition claims assigned to them
 *   - Managers can transition claims in their reports' pool
 *   - Auditors cannot transition (read-only)
 *   - SIU referrers cannot transition (read-only)
 *
 * Business rules:
 *   - A claim cannot transition to the same status it is already in
 *   - Transitions must follow the defined legal paths
 *   - Some transitions may require additional context (e.g., reserve approval)
 */
export function validateClaimStatusTransition(
  context: FsmContext,
): FsmTransitionResult {
  const { currentStatus, desiredStatus, actorRole } = context;

  // Reject if trying to transition to the same status
  if (currentStatus === desiredStatus) {
    return {
      ok: false,
      reason: `Claim is already in status '${currentStatus}'; no transition needed.`,
    };
  }

  // Reject if actor role is not authorized to transition
  if (['agent', 'auditor', 'siu_referrer'].includes(actorRole)) {
    return {
      ok: false,
      reason: `Role '${actorRole}' is not authorized to transition claim status.`,
    };
  }

  // Define the legal transition matrix
  const legalTransitions: Record<ClaimStatus, ClaimStatus[]> = {
    [ClaimStatus.intake]: [ClaimStatus.under_investigation],
    [ClaimStatus.under_investigation]: [
      ClaimStatus.awaiting_reserve_approval,
      ClaimStatus.settlement_offered,
      ClaimStatus.closed_denied,
    ],
    [ClaimStatus.awaiting_reserve_approval]: [
      ClaimStatus.settlement_offered,
      ClaimStatus.closed_denied,
    ],
    [ClaimStatus.settlement_offered]: [
      ClaimStatus.closed_paid,
      ClaimStatus.reopened,
    ],
    [ClaimStatus.closed_paid]: [],
    [ClaimStatus.closed_denied]: [ClaimStatus.reopened],
    [ClaimStatus.reopened]: [ClaimStatus.under_investigation],
  };

  // Check if the desired transition is legal
  const allowedTransitions = legalTransitions[currentStatus] || [];
  if (!allowedTransitions.includes(desiredStatus)) {
    return {
      ok: false,
      reason: `Illegal transition from '${currentStatus}' to '${desiredStatus}'. Allowed transitions from '${currentStatus}': ${allowedTransitions.length > 0 ? allowedTransitions.join(', ') : 'none (terminal state)'}`,
    };
  }

  // Additional business rule: transitioning to awaiting_reserve_approval requires context
  // (This is informational; the actual reserve approval check happens in the service layer)
  if (desiredStatus === ClaimStatus.awaiting_reserve_approval) {
    // The service layer will verify that reserves have been proposed
    // This FSM only validates the state machine itself
  }

  // Transition is legal
  return { ok: true };
}

/**
 * Returns a human-readable description of the current claim status.
 * Used in UI and logging.
 */
export function describeClaimStatus(status: ClaimStatus): string {
  const descriptions: Record<ClaimStatus, string> = {
    [ClaimStatus.intake]: 'Intake — claim received, awaiting initial triage',
    [ClaimStatus.under_investigation]:
      'Under Investigation — adjuster is gathering information and evidence',
    [ClaimStatus.awaiting_reserve_approval]:
      'Awaiting Reserve Approval — reserves proposed, pending manager approval',
    [ClaimStatus.settlement_offered]:
      'Settlement Offered — settlement proposal sent to claimant',
    [ClaimStatus.closed_paid]: 'Closed — Paid — claim settled and payment issued',
    [ClaimStatus.closed_denied]: 'Closed — Denied — claim denied and closed',
    [ClaimStatus.reopened]: 'Reopened — claim reopened for further investigation',
  };
  return descriptions[status] || `Unknown status: ${status}`;
}

/**
 * Returns the next legal statuses from a given status.
 * Used in UI to populate status transition dropdowns.
 */
export function getNextLegalStatuses(currentStatus: ClaimStatus): ClaimStatus[] {
  const legalTransitions: Record<ClaimStatus, ClaimStatus[]> = {
    [ClaimStatus.intake]: [ClaimStatus.under_investigation],
    [ClaimStatus.under_investigation]: [
      ClaimStatus.awaiting_reserve_approval,
      ClaimStatus.settlement_offered,
      ClaimStatus.closed_denied,
    ],
    [ClaimStatus.awaiting_reserve_approval]: [
      ClaimStatus.settlement_offered,
      ClaimStatus.closed_denied,
    ],
    [ClaimStatus.settlement_offered]: [
      ClaimStatus.closed_paid,
      ClaimStatus.reopened,
    ],
    [ClaimStatus.closed_paid]: [],
    [ClaimStatus.closed_denied]: [ClaimStatus.reopened],
    [ClaimStatus.reopened]: [ClaimStatus.under_investigation],
  };
  return legalTransitions[currentStatus] || [];
}