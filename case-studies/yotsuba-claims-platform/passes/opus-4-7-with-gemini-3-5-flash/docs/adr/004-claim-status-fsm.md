# ADR 004: Claim Status Finite State Machine (FSM)

## Status
Accepted

## Context
Our system processes insurance and reimbursement claims. A claim progresses through a well-defined lifecycle, starting from creation and ending in a terminal state such as payment, rejection, or cancellation. 

Allowing arbitrary updates to a claim's status without validation poses significant risks:
1. **Data Integrity**: A claim could bypass critical validation or approval steps (e.g., moving directly from `DRAFT` to `PAID`).
2. **Auditability**: We must guarantee that every status change is deliberate, authorized, and accompanied by a clear audit trail (as established in [ADR 002](002-audit-immutability.md)).
3. **Business Logic Consistency**: Different states require different business rules (e.g., only claims in `UNDER_REVIEW` can be approved; claims in `PAID` or `REJECTED` are immutable and cannot be modified).

To enforce these rules reliably, we need a centralized, robust mechanism to govern claim status transitions, validate inputs, and execute side effects consistently.

## Decision
We will implement a strict, deterministic **Finite State Machine (FSM)** at the application layer to manage all claim status transitions.

### 1. State Machine Definition
We define the following states and valid transitions for a `Claim`:

- **`DRAFT`**: The claim is being prepared by the customer.
  - Allowed transitions: `SUBMITTED`, `CANCELLED`.
- **`SUBMITTED`**: The claim has been submitted and is awaiting initial triage.
  - Allowed transitions: `UNDER_REVIEW`, `REJECTED`.
- **`UNDER_REVIEW`**: A claims agent is actively reviewing the claim.
  - Allowed transitions: `APPROVED`, `REJECTED`, `INFO_REQUESTED`.
- **`INFO_REQUESTED`**: The agent has requested additional information from the customer.
  - Allowed transitions: `SUBMITTED` (when customer resubmits), `CANCELLED`.
- **`APPROVED`**: The claim has been approved and is queued for payment.
  - Allowed transitions: `PAID`, `REJECTED` (in case of post-approval fraud detection).
- **`PAID`**: The reimbursement has been successfully processed (Terminal State).
  - Allowed transitions: None.
- **`REJECTED`**: The claim has been rejected (Terminal State).
  - Allowed transitions: None.
- **`CANCELLED`**: The claim was cancelled by the customer (Terminal State).
  - Allowed transitions: None.

### 2. Implementation Strategy
- **State Machine Engine**: We will implement a lightweight, type-safe FSM pattern in TypeScript. We will avoid heavy external libraries to keep the bundle size small and maintain full control over integration with NestJS and Prisma.
- **Transition Configuration**: Transitions will be defined declaratively using a transition map:

```typescript
const CLAIM_TRANSITIONS: Record<ClaimStatus, ClaimStatus[]> = {
  [ClaimStatus.DRAFT]: [ClaimStatus.SUBMITTED, ClaimStatus.CANCELLED],
  [ClaimStatus.SUBMITTED]: [ClaimStatus.UNDER_REVIEW, ClaimStatus.REJECTED],
  [ClaimStatus.UNDER_REVIEW]: [ClaimStatus.APPROVED, ClaimStatus.REJECTED, ClaimStatus.INFO_REQUESTED],
  [ClaimStatus.INFO_REQUESTED]: [ClaimStatus.SUBMITTED, ClaimStatus.CANCELLED],
  [ClaimStatus.APPROVED]: [ClaimStatus.PAID, ClaimStatus.REJECTED],
  [ClaimStatus.PAID]: [],
  [ClaimStatus.REJECTED]: [],
  [ClaimStatus.CANCELLED]: [],
};
```

- **Centralized Transition Service**: A `ClaimStatusFsmService` will be the sole authority for updating a claim's status. Any service or controller attempting to update a claim's status must call this service.
- **Guards and Side Effects**:
  - **Pre-transition Guards**: Before a transition is executed, the FSM will run validation guards (e.g., verifying that a claim has supporting documents before moving to `SUBMITTED`, or verifying that the user has the `ClaimsAgent` role to move to `UNDER_REVIEW`).
  - **Post-transition Actions**: Upon a successful transition, the FSM will trigger asynchronous side effects (e.g., sending email notifications to the customer, triggering payment processing via a message queue, and writing to the immutable audit log).

### 3. Database Integrity (Prisma Middleware / Extensions)
To prevent bypasses of the FSM via direct database updates:
- We will implement a Prisma client extension that intercepts updates to the `status` field of a `Claim`.
- The extension will verify that the transition from the current database state to the requested state is valid according to the FSM configuration. If invalid, it will abort the transaction and throw a runtime exception.

## Consequences

### Positive (Benefits)
- **Guaranteed Consistency**: Prevents claims from entering invalid or impossible states, ensuring high data quality.
- **Centralized Business Logic**: All transition rules, role permissions, and side effects are defined in one place, making the codebase easier to maintain and audit.
- **Improved Auditability**: Every state transition is explicitly validated and logged, providing a clear history of the claim's lifecycle.
- **Developer Ergonomics**: Developers do not need to manually write validation logic for status updates in multiple controllers or services.

### Negative (Trade-offs & Mitigations)
- **Rigidity**: Changes to the business workflow require modifying the FSM configuration and potentially migrating existing claims if states are deprecated.
  - *Mitigation*: We will design the FSM to support versioned transition maps if complex workflow changes are anticipated in the future.
- **Slight Performance Overhead**: Running pre-transition guards and post-transition actions adds minor latency to status update operations.
  - *Mitigation*: Keep guards highly optimized (e.g., using database joins or caching where appropriate) and execute non-critical post-transition actions (like sending emails) asynchronously.