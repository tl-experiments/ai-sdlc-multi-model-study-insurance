# ADR-004: Claim Status Finite-State Machine

**Status:** Accepted  
**Date:** 2024-01-01  
**Deciders:** Platform Architecture Team  
**Regulated under:** JFSA (金融庁) / APPI (個人情報保護法)  
**Track:** A (enforced) — Track B adds SIU referral and subrogation states

---

## Context

A P&C insurance claim passes through a well-defined sequence of lifecycle states from first notice of loss through to settlement or denial. Each state transition carries legal, financial, and operational significance:

- **`intake` → `under_investigation`** — the claim has been accepted as valid and an adjuster has been assigned. Reserve computation begins. The JFSA expects that once a claim is accepted, an investigation is commenced within a defined period.
- **`under_investigation` → `awaiting_reserve_approval`** — the adjuster has completed their field investigation and proposed a reserve. The transition signals that a financial liability estimate is pending management review.
- **`awaiting_reserve_approval` → `settlement_offered`** — a manager (and, for large reserves, a claims director) has approved the reserve. A settlement offer may now be communicated to the insured.
- **`settlement_offered` → `closed_paid`** — the insured has accepted the offer and payment has been authorised.
- **`settlement_offered` → `closed_denied`** — the claim has been denied after investigation (e.g. coverage exclusion, fraud indicator, policy lapse).
- **Any `closed_*` → `reopened`** — the claim is reopened, typically due to new evidence, a regulatory instruction, or a dispute lodged by the insured.
- **`reopened` → `under_investigation`** — the reopened claim re-enters the investigation pipeline.

### Problem Statement

Without a formally specified and centrally enforced state machine, several failure modes emerge:

1. **Illegal transitions execute silently.** A `PATCH /claims/:id/status` request that skips `awaiting_reserve_approval` and jumps directly to `closed_paid` would succeed, bypassing the reserve approval workflow and its JFSA-regulated financial controls.
2. **Business logic is scattered.** Each controller or service that touches `status` carries its own guard conditions. Adding a new state or a new transition requires auditing every guard in every file.
3. **Transition rejections are opaque.** Without a formal FSM, a rejected transition returns a generic error. A regulatory examiner or an adjuster deserves a specific explanation: *"Cannot transition from `intake` to `settlement_offered`: claim must pass through `under_investigation` and `awaiting_reserve_approval` first."*
4. **Role-conditional transitions are not enforced uniformly.** The FSM must also carry actor constraints: an `adjuster` may transition `intake` → `under_investigation`, but only a `manager` may transition `awaiting_reserve_approval` → `settlement_offered`.

We need a design that:

1. Encodes all valid state transitions in a single, auditable file.
2. Returns a structured rejection (not a generic 500) when a transition is illegal — with the reason surfaced in the 422 response body.
3. Enforces role constraints on transitions alongside state constraints.
4. Is a pure function, making it trivially testable without database fixtures.
5. Is the single place that must be edited when the workflow changes.

---

## Decision

### Pure FSM in `src/claims/claims-status.fsm.ts`

All transition logic is implemented as a single exported pure function:

```typescript
export function canTransition(
  from: ClaimStatus,
  to: ClaimStatus,
  actor: { role: UserRole; id: string },
  claim: { assigned_adjuster_id: string | null },
): TransitionResult

type TransitionResult =
  | { ok: true }
  | { ok: false; reason: string }
```

The function:
1. Receives the current status (`from`), the requested status (`to`), the actor's role and ID, and the minimal claim data needed for ownership checks.
2. Consults the transition table (below) to determine whether `(from, to)` is a defined edge.
3. Evaluates the role constraint for that edge.
4. Returns `{ ok: true }` if both checks pass, or `{ ok: false, reason: '<human-readable explanation>' }` otherwise.

No database calls, no side effects. The function is invoked by `claims.service.ts#transitionStatus()` before any Prisma write. If `canTransition` returns `{ ok: false }`, the service throws a `422 Unprocessable Entity` containing `reason` as the error message.

### Transition table

The FSM is defined as a lookup structure within `claims-status.fsm.ts`. Only entries in this table are valid transitions; all others are illegal by default.

| From | To | Permitted roles | Notes |
|---|---|---|---|
| `intake` | `under_investigation` | `adjuster` (assigned), `manager` | Requires adjuster to be assigned; assignment may be simultaneous (manager fast-path) |
| `under_investigation` | `awaiting_reserve_approval` | `adjuster` (assigned) | Adjuster declares investigation complete and reserve proposed |
| `under_investigation` | `intake` | `manager` | Manager rolls back to intake (e.g. incorrect triage; sends back for re-intake) |
| `awaiting_reserve_approval` | `settlement_offered` | `manager` | Reserve has been approved (enforced by reserve approval workflow; FSM checks status) |
| `awaiting_reserve_approval` | `under_investigation` | `manager` | Manager rejects reserve proposal; returns to investigation |
| `settlement_offered` | `closed_paid` | `manager` | Payment authorised |
| `settlement_offered` | `closed_denied` | `manager` | Claim denied |
| `closed_paid` | `reopened` | `manager` | Claim reopened after settlement |
| `closed_denied` | `reopened` | `manager` | Claim reopened after denial |
| `reopened` | `under_investigation` | `adjuster` (assigned), `manager` | Reopened claim re-enters investigation |

Transitions not listed in this table are unconditionally rejected with a reason of the form:

```
Transition from '<from>' to '<to>' is not a valid workflow step.
Valid transitions from '<from>' are: [<list>].
```

### Role constraint evaluation

For each transition edge, the FSM evaluates two conditions:

1. **Role check** — is `actor.role` in the permitted roles list for this edge?
2. **Ownership check** — if the permitted roles include `adjuster (assigned)`, is `actor.id === claim.assigned_adjuster_id`?

If the role check fails:
```
Role '<role>' is not permitted to perform this transition. Required: [<permitted roles>].
```

If the role is `adjuster` but the ownership check fails:
```
Adjuster is not assigned to this claim and cannot perform this transition.
```

Both checks use strict equality and enum comparisons; there are no string comparisons against role names.

### Integration with the controller layer

```
PATCH /claims/:id/status
        │
        ▼
  claims.controller.ts          — extracts caller, body: { to, reason }
        │
        ▼
  claims.service.ts
  #transitionStatus(id, to, reason, caller)
        │
        ▼
  ① prisma.claim.findUnique(id)  — fetch current status + assigned_adjuster_id
        │
        ▼
  ② canTransition(from, to, caller, claim)
        │
     ok=false ──► throw UnprocessableEntityException(reason)   → HTTP 422
        │
     ok=true
        │
        ▼
  ③ prisma.claim.update({ status: to })  — committed only if FSM approved
        │
        ▼
  ④ AuditInterceptor emits AuditEvent
     action = 'claim.status.transitioned'
     payload includes { from, to, reason }
```

Step ② is the single gate. No other code in the codebase updates `Claim.status` directly; all writes go through `#transitionStatus()`. This is enforced by convention and verified by CI grep (`prisma.claim.update` with a `status` key appearing outside `claims.service.ts` is a blocking failure).

### State diagram

```
                  ┌─────────┐
                  │  intake │◄────────────────────────────┐
                  └────┬────┘                             │
                       │ adjuster/manager                 │ manager
                       ▼                                  │
             ┌──────────────────────┐                    │
             │  under_investigation │◄──────────┐        │
             └──────────┬───────────┘           │        │
                        │ adjuster              │ mgr    │ manager
                        ▼                       │        │
             ┌───────────────────────────┐      │        │
             │  awaiting_reserve_        │──────┘        │
             │  approval                 │               │
             └──────────────┬────────────┘               │
                            │ manager                    │
                            ▼                            │
                  ┌──────────────────┐                   │
                  │ settlement_      │                   │
                  │ offered          │                   │
                  └────┬─────────┬───┘                   │
           manager     │         │ manager               │
                       ▼         ▼                       │
               ┌────────────┐  ┌─────────────┐          │
               │ closed_    │  │ closed_     │          │
               │ paid       │  │ denied      │          │
               └──────┬─────┘  └──────┬──────┘          │
                      │               │                  │
               manager│               │manager           │
                      └───────┬───────┘                  │
                              ▼                          │
                         ┌──────────┐                    │
                         │ reopened │────────────────────┘
                         └──────────┘
                     adjuster/manager
                              │
                              ▼
                    under_investigation
```

### Pure function guarantee

`canTransition` has no side effects and no imports from NestJS, Prisma, or any I/O-capable module. Its only imports are the `ClaimStatus` and `UserRole` enums from the shared types. This makes it:

- **Independently unit-testable** — no mocking required; call the function with enum values and assert on the return value.
- **Refactorable without risk** — changes to the transition table cannot accidentally trigger database writes or HTTP calls.
- **Readable as policy** — the transition table is the canonical specification of the workflow. A business analyst can read it without understanding NestJS.

---

## Consequences

### Positive

- **No illegal transitions.** The FSM is the single gate before every `status` write. An adjuster cannot accidentally skip reserve approval; a manager cannot close a claim that is still under investigation.
- **Auditable workflow specification.** The full workflow is encoded in ~80 lines of a single file. A JFSA examiner, internal auditor, or new engineer can read the transition table and understand the complete claims lifecycle without reading controllers or services.
- **Structured 422 responses.** Illegal transitions return `HTTP 422 Unprocessable Entity` with a human-readable `reason` field. Adjusters and managers see actionable messages, not generic server errors.
- **Pure function = trivial tests.** The FSM test suite (`test/claims-workbench.e2e.spec.ts` and a dedicated unit spec) covers the full transition matrix — every legal edge, every illegal edge, every role violation — without database fixtures or NestJS bootstrapping.
- **Role enforcement is co-located with transition rules.** The table encodes both *what* transitions are valid and *who* may perform them. There is no separate RBAC guard file for status transitions.
- **Audit events carry full transition context.** Because the FSM returns before the write, the `AuditEvent` for `claim.status.transitioned` can include both `from` and `to` states in the `payload_hash` computation, giving a content-bound record of every workflow step.

### Negative / Accepted trade-offs

- **Reserved approval state coupling.** The transition `awaiting_reserve_approval` → `settlement_offered` is gated at the FSM level by actor role, but the FSM does not independently verify that an approved reserve actually exists. The service layer is responsible for this additional check before calling `canTransition`. This is a deliberate separation of concerns — the FSM enforces workflow shape; the service enforces business preconditions.
- **Manager-only closure transitions.** The design gives managers exclusive control over `settlement_offered` → `closed_paid` and `settlement_offered` → `closed_denied`. This is intentional (financial controls) but means adjusters cannot close their own claims without manager sign-off, which may increase queue latency for simple claims. Accepted as a regulatory trade-off.
- **No concurrent transition protection.** If two requests attempt to transition the same claim simultaneously, both may pass the FSM check before either writes. This is a race condition mitigated by Postgres transaction isolation at the service layer. The FSM itself is not responsible for transaction management.
- **Reopened state has limited transitions.** `reopened` → `under_investigation` is the only forward path from `reopened`. There is no `reopened` → `closed_*` shortcut. If a reopened claim is immediately found to be without merit, it must re-traverse `under_investigation` → `awaiting_reserve_approval` → `settlement_offered` → `closed_denied`. This is intentional: reopened claims receive the same scrutiny as new claims.

---

## Alternatives Considered

### Option 1: Status as an unconstrained string field with per-service guard clauses

Rejected. Without a central FSM, every service method that can change status carries its own set of `if (current !== 'X') throw` guards. When a new state is added, every guard must be audited. When a new role is added, every guard must be updated. This approach has been the source of production workflow bugs in claims systems precisely because the guards diverge over time.

### Option 2: NestJS workflow library (e.g. `xstate`, `@nestjs-addons/workflow`)

Considered. `xstate` is a mature FSM library with excellent TypeScript support and visualisation tooling. However:

- It introduces a non-trivial dependency for a workflow with fewer than 15 transitions.
- The pure-function approach in `claims-status.fsm.ts` achieves the same guarantees with zero external dependencies.
- A custom implementation is more readable to domain reviewers who are not familiar with the xstate API.
- Track B can adopt `xstate` if the workflow expands significantly (SIU referral, subrogation, multi-party arbitration).

The pure-function approach is chosen for Track A. Adoption of a workflow library is a Track B option.

### Option 3: Database-layer state machine (Postgres check constraints + trigger)

Considered. A Postgres `CHECK` constraint on the `(from_status, to_status)` pair, enforced by a trigger, would prevent illegal transitions even from raw SQL. However:

- It requires encoding the transition table in both the application and the database, creating two sources of truth.
- The role-conditional nature of transitions (only an assigned adjuster may do X) cannot be expressed in a Postgres trigger without the application's user context, which is not available at the DB layer in the Prisma connection model.
- Trigger-based enforcement is a Track B hardening option, not a Track A requirement.

### Option 4: State machine encoded in the `ClaimStatus` enum metadata

Rejected. TypeScript enums do not carry metadata. Encoding valid successors as a lookup on the enum would require a separate constant anyway, which is equivalent to the transition table in `claims-status.fsm.ts`. The dedicated module is more readable.

---

## Test Matrix

The following combinations are covered by the FSM unit test suite and `test/claims-workbench.e2e.spec.ts`:

| Scenario | Expected result |
|---|---|
| `intake` → `under_investigation` by assigned adjuster | `{ ok: true }` |
| `intake` → `under_investigation` by manager | `{ ok: true }` |
| `intake` → `under_investigation` by non-assigned adjuster | `{ ok: false }` — ownership violation |
| `intake` → `under_investigation` by agent | `{ ok: false }` — role violation |
| `intake` → `settlement_offered` (skip) by manager | `{ ok: false }` — invalid edge |
| `under_investigation` → `awaiting_reserve_approval` by assigned adjuster | `{ ok: true }` |
| `under_investigation` → `awaiting_reserve_approval` by manager | `{ ok: false }` — role violation |
| `awaiting_reserve_approval` → `settlement_offered` by manager | `{ ok: true }` |
| `awaiting_reserve_approval` → `settlement_offered` by adjuster | `{ ok: false }` — role violation |
| `settlement_offered` → `closed_paid` by manager | `{ ok: true }` |
| `settlement_offered` → `closed_denied` by manager | `{ ok: true }` |
| `settlement_offered` → `closed_paid` by adjuster | `{ ok: false }` — role violation |
| `closed_paid` → `reopened` by manager | `{ ok: true }` |
| `closed_denied` → `reopened` by manager | `{ ok: true }` |
| `closed_paid` → `under_investigation` (illegal edge) by manager | `{ ok: false }` — invalid edge |
| `reopened` → `under_investigation` by assigned adjuster | `{ ok: true }` |
| `reopened` → `under_investigation` by manager | `{ ok: true }` |
| `intake` → `intake` (self-loop) by any role | `{ ok: false }` — invalid edge |
| HTTP 422 body contains human-readable `reason` | Response body has `{ message: string }` |
| `AuditEvent` emitted with `from` and `to` on every legal transition | Audit log entry present |

---

## Compliance Traceability

| Requirement | How this ADR satisfies it |
|---|---|
| JFSA — financial controls on settlement authorisation | `awaiting_reserve_approval` → `settlement_offered` gated to `manager` role; reserve approval is a precondition |
| JFSA — tamper-evident workflow records | Every transition emits an immutable `AuditEvent` with `payload_hash` including `{ from, to, reason }` |
| APPI Art. 20 — security management measures | State transitions that expose or alter PII (e.g. settlement) are role-gated; no adjuster can close a claim unilaterally |
| Internal claims governance — chain of custody | The full sequence of `claim.status.transitioned` audit events per `claim_id` is the authoritative lifecycle record |
| Acceptance criterion — state machine with 422 + explanation | `canTransition` returns `{ ok: false, reason }` which the service converts to `UnprocessableEntityException` |

---

## Related ADRs

- **ADR-002** — Audit log immutability (`claim.status.transitioned` events are written by the same interceptor; the transition payload including `from` / `to` is content-bound in `payload_hash`)
- **ADR-003** — Role masking by APPI tier (role constraints in the FSM align with the role matrix; the `adjuster` ownership check is the same `isAssignedAdjuster` pattern used in masking)
- **ADR-005** — Reserve approval tiers (the transition `awaiting_reserve_approval` → `settlement_offered` is FSM-gated; ADR-005 governs the reserve approval that must precede it)

---

## Implementation Reference

| File | Role |
|---|---|
| `src/claims/claims-status.fsm.ts` | `canTransition(from, to, actor, claim)` — pure FSM; single source of truth for transition validity |
| `src/claims/claims.service.ts` | `#transitionStatus()` — calls `canTransition`; throws 422 on `ok: false`; writes Prisma update on `ok: true` |
| `src/claims/claims.controller.ts` | `PATCH /claims/:id/status` — delegates entirely to `#transitionStatus()`; no transition logic in controller |
| `src/claims/dto/update-status.dto.ts` | `{ to: ClaimStatus; reason: string }` — validated by `class-validator`; `reason` required for audit |
| `test/claims-workbench.e2e.spec.ts` | Integration tests for legal transitions, illegal transitions, role violations, and 422 response shape |
| `docs/adr/004-claim-status-fsm.md` | This document |

---

## Track B Follow-On Actions

1. **SIU referral state** — add a `referred_to_siu` status reachable from `under_investigation` when an adjuster flags fraud suspicion. The FSM transition table gains one edge; the SIU module (Track B) adds the downstream handler.
2. **Subrogation hold state** — add a `subrogation_hold` status reachable from `closed_paid` when a recovery opportunity is identified. The subrogation module (Track B) drives the exit transition.
3. **Postgres trigger enforcement** — add a trigger that enforces the transition table at the database layer, providing a second line of defence below the application FSM. Requires encoding the valid `(from, to)` pairs as a Postgres table or function.
4. **`xstate` migration** — if the workflow expands beyond 20 transitions (Track B with SIU, subrogation, arbitration states), evaluate migration to `xstate` for visualisation tooling and parallel-state support.
5. **Transition timeout SLAs** — add a scheduled job that identifies claims that have been in `under_investigation` or `awaiting_reserve_approval` beyond JFSA-mandated SLA thresholds and escalates to the assigned adjuster's manager. The FSM itself is stateless; SLA tracking is a separate operational concern.
6. **Transition audit enrichment** — extend the `AuditEvent` payload for `claim.status.transitioned` to include the duration spent in the previous state, enabling SLA analytics without requiring a separate state-history table.
