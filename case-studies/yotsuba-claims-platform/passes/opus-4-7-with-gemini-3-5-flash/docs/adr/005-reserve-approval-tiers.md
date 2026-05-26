# ADR 005: Reserve Approval Tiers

## Status
Accepted

## Context
In insurance operations, a "reserve" is the estimated financial liability set aside to cover the future payout of a claim. Setting and adjusting reserves is a critical financial activity. If reserves are set too low, the company faces under-capitalization risks; if set too high, capital is unnecessarily tied up. Furthermore, unauthorized or excessive reserve adjustments present significant risks of fraud, operational error, and non-compliance with financial regulations (such as Sarbanes-Oxley / SOX).

To mitigate these risks, we must enforce strict financial controls. Not all users should have the authority to establish or increase reserves of any amount. Instead, authority must be delegated based on the user's role and seniority, structured as hierarchical "Reserve Approval Tiers."

We evaluated several approaches for enforcing these limits:
1. **Hardcoded Application-Level Checks**: Simple to implement but highly rigid. Any change to financial limits or roles requires a full code deployment.
2. **Database-Level Constraints**: Difficult to map to complex hierarchical roles and user identities, and lacks the flexibility to handle temporary delegation or multi-step approval workflows.
3. **Dynamic, Tier-Based Authorization Service**: A dedicated application service that evaluates reserve requests against a configurable matrix of roles and limits, integrated with our existing authentication and audit systems.

## Decision
We will implement a **Dynamic, Tier-Based Authorization Service** to govern all claim reserve creations and adjustments.

### 1. Reserve Approval Tier Matrix
We will establish a standard hierarchy of approval tiers based on user roles and maximum financial limits:

| Tier | Role | Maximum Reserve Limit (USD) | Description |
| :--- | :--- | :--- | :--- |
| **Tier 1** | `ClaimsAgent` | $10,000 | Standard claims handling and minor settlements. |
| **Tier 2** | `SeniorClaimsAgent` | $50,000 | Complex claims requiring deeper investigation. |
| **Tier 3** | `ClaimsManager` | $250,000 | High-value claims and operational oversight. |
| **Tier 4** | `VPOfClaims` | Unlimited (or > $250,000) | Executive-level approval for catastrophic or major losses. |

### 2. Enforcement Rules
- **Cumulative Limit Evaluation**: The approval limit is evaluated against the *total cumulative reserve* of the claim, not just the incremental increase. This prevents users from bypassing limits through multiple small, consecutive increases (known as "structuring").
- **Strict Validation**: Any request to create or update a reserve must pass through the `ReserveService`. The service will retrieve the authenticated user's role and verify that the proposed total reserve amount does not exceed their tier's limit.
- **Escalation Workflow**: If a user attempts to set a reserve that exceeds their authorized limit:
  - The reserve is not applied immediately.
  - Instead, the reserve status is set to `PENDING_APPROVAL`.
  - An approval request is generated and routed to users in the next appropriate tier.
  - The claim status remains locked or restricted (via the FSM defined in [ADR 004](004-claim-status-fsm.md)) until the reserve is approved or rejected by an authorized user.

### 3. Implementation Details
We will implement a type-safe `ReserveApprovalService` in NestJS:

```typescript
export interface ReserveTier {
  tier: number;
  role: string;
  maxLimit: number;
}

export const RESERVE_TIERS: Record<string, number> = {
  'ClaimsAgent': 10000,
  'SeniorClaimsAgent': 50000,
  'ClaimsManager': 250000,
  'VPOfClaims': Infinity,
};
```

- **Audit Integration**: Every reserve modification request, approval, rejection, or escalation must be logged in the immutable audit trail (as defined in [ADR 002](002-audit-immutability.md)), capturing the requesting user, the target claim, the previous reserve, the proposed reserve, and the decision outcome.
- **Bypass Prevention**: Similar to our FSM and Audit strategies, we will implement a Prisma middleware/extension to block direct database updates to the `Reserve` table that bypass the `ReserveApprovalService`.

## Consequences

### Positive (Benefits)
- **Financial Control & Compliance**: Ensures strict compliance with SOX and internal audit requirements by preventing unauthorized financial commitments.
- **Fraud Prevention**: Mitigates internal fraud risks by enforcing separation of duties and multi-level approvals for high-value claims.
- **Automated Escalation**: Streamlines operations by automatically routing high-value claims to managers and executives without manual intervention.
- **Traceability**: Provides a clear, immutable history of who authorized every dollar of reserve liability.

### Negative (Trade-offs & Mitigations)
- **Operational Bottlenecks**: Claims requiring high reserves may experience delays while waiting for manager or executive approval.
  - *Mitigation*: Implement automated real-time notifications (e.g., email or Slack alerts) to notify higher-tier approvers immediately when an escalation occurs.
- **Configuration Rigidity**: While more flexible than hardcoding, changing the limits still requires updating the configuration.
  - *Mitigation*: Store the tier limits in database-backed configuration tables or environment variables, allowing updates without redeploying code, subject to strict administrative access controls and auditing.