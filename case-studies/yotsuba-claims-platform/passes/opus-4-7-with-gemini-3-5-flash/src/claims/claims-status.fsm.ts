export enum ClaimStatus {
  DRAFT = 'DRAFT',
  SUBMITTED = 'SUBMITTED',
  UNDER_REVIEW = 'UNDER_REVIEW',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  APPEALED = 'APPEALED',
  SETTLED = 'SETTLED',
  CANCELLED = 'CANCELLED',
}

export enum ClaimEvent {
  SUBMIT = 'SUBMIT',
  REVIEW = 'REVIEW',
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
  APPEAL = 'APPEAL',
  RE_REVIEW = 'RE_REVIEW',
  SETTLE = 'SETTLE',
  CANCEL = 'CANCEL',
}

export const CLAIM_STATUS_TRANSITIONS: Record<
  ClaimStatus,
  Partial<Record<ClaimEvent, ClaimStatus>>
> = {
  [ClaimStatus.DRAFT]: {
    [ClaimEvent.SUBMIT]: ClaimStatus.SUBMITTED,
    [ClaimEvent.CANCEL]: ClaimStatus.CANCELLED,
  },
  [ClaimStatus.SUBMITTED]: {
    [ClaimEvent.REVIEW]: ClaimStatus.UNDER_REVIEW,
    [ClaimEvent.CANCEL]: ClaimStatus.CANCELLED,
  },
  [ClaimStatus.UNDER_REVIEW]: {
    [ClaimEvent.APPROVE]: ClaimStatus.APPROVED,
    [ClaimEvent.REJECT]: ClaimStatus.REJECTED,
    [ClaimEvent.CANCEL]: ClaimStatus.CANCELLED,
  },
  [ClaimStatus.APPROVED]: {
    [ClaimEvent.SETTLE]: ClaimStatus.SETTLED,
  },
  [ClaimStatus.REJECTED]: {
    [ClaimEvent.APPEAL]: ClaimStatus.APPEALED,
  },
  [ClaimStatus.APPEALED]: {
    [ClaimEvent.RE_REVIEW]: ClaimStatus.UNDER_REVIEW,
  },
  [ClaimStatus.SETTLED]: {},
  [ClaimStatus.CANCELLED]: {},
};

export function getNextStatus(currentStatus: ClaimStatus, event: ClaimEvent): ClaimStatus {
  const allowedTransitions = CLAIM_STATUS_TRANSITIONS[currentStatus];
  if (!allowedTransitions) {
    throw new Error(`No transitions defined for status: ${currentStatus}`);
  }

  const nextStatus = allowedTransitions[event];
  if (!nextStatus) {
    throw new Error(
      `Invalid transition: Event "${event}" is not allowed from status "${currentStatus}"`
    );
  }

  return nextStatus;
}

export function getAvailableEvents(currentStatus: ClaimStatus): ClaimEvent[] {
  const allowedTransitions = CLAIM_STATUS_TRANSITIONS[currentStatus];
  if (!allowedTransitions) {
    return [];
  }
  return Object.keys(allowedTransitions) as ClaimEvent[];
}

export function isValidTransition(currentStatus: ClaimStatus, event: ClaimEvent): boolean {
  const allowedTransitions = CLAIM_STATUS_TRANSITIONS[currentStatus];
  return !!(allowedTransitions && allowedTransitions[event]);
}