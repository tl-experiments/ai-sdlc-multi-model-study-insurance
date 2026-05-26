# ADR-004 — Claim status finite-state machine: one pure function owns every legal transition

- **Status:** Accepted (Track A)
- **Date:** 2024-09
- **Deciders:** Claims platform engineering; reviewed against the locked `brief.md` Adjuster Workbench specification (`PATCH /claims/:id/status` workflow) and `design.md` §1 (`ClaimStatus` enum) + §2 (API contract) + §3 (`claims/claims-status.fsm.ts`).
- **Related ADRs:** ADR-002 (audit immutability — every transition emits a `claim.status.transitioned` row), ADR-003 (role masking by APPI tier — status is `public` tier and never masked), ADR-005 (reserve approval tiers — the `awaiting_reserve_approval` state is entered and exited by reserve workflow events), ADR-006 (JFSA notification — a transition into `settlement_offered` after a threshold-crossing reserve is part of the correlation chain).
- **Related code:** `src/claims/claims-status.fsm.ts`, `src/claims/claims.service.ts`, `src/claims/claims.controller.ts`, `src/claims/dto/update-status.dto.ts`, `prisma/schema.prisma` (`ClaimStatus` enum + `Claim.status` column).

---

## 1. Context

A P&C claim moves through a regulated workflow from first notice of loss to final disposition. The brief enumerates seven states and the transitions among them:

> `PATCH /claims/:id/status` — workflow state machine: `intake` → `under_investigation` → `awaiting_reserve_approval` → `settlement_offered` → `closed_paid` | `closed_denied` | `reopened`. State transitions guarded; illegal transitions return 422 with explanation.

The seven states from `design.md` §1's `ClaimStatus` enum:

- `intake` — the FNOL has been recorded but no adjuster work has begun.
- `under_investigation` — an adjuster has been assigned and is gathering evidence, taking statements, and assessing liability.
- `awaiting_reserve_approval` — the adjuster has proposed a reserve and is waiting on the manager (and, for amounts above ¥10M, the claims director) to approve it (ADR-005).
- `settlement_offered` — the reserve is approved and a settlement offer has gone out to the claimant.
- `closed_paid` — terminal: the settlement has been paid and the claim is closed.
- `closed_denied` — terminal: the claim has been denied (coverage exclusion, fraud determination, claimant withdrawal) and is closed without payment.
- `reopened` — a previously closed claim has been reopened (new evidence, regulator inquiry, litigation). From here it re-enters the live workflow.

Three design pressures fall out of this:

1. **Some transitions are legal; most are not.** Of the 7 × 7 = 49 ordered pairs of states, only a small minority correspond to legitimate workflow moves. `intake → under_investigation` is legal; `intake → closed_paid` is not (you cannot pay a claim that no adjuster has seen). `under_investigation → reopened` is not (only closed claims reopen). Without an explicit enumeration of the legal set, every controller path that touches `status` becomes an opportunity to write a buggy `if/else` ladder that allows an illegitimate move.
2. **Legality is not just "which states connect to which" — it is also "who is allowed to make this move, and under what state of the claim."** A manager closing a claim as `closed_denied` from `under_investigation` is legal; an adjuster doing the same on a claim assigned to someone else is not. A transition into `settlement_offered` requires an approved reserve on the claim; without that pre-condition, the transition is illegal regardless of who is asking. Authorisation (who) and pre-conditions (what state of the world) are entangled with the transition graph itself, and a maintainable design has to handle all three uniformly.
3. **Illegal transitions must produce a reasoned response, not a generic 4xx.** The brief's text — "illegal transitions return 422 with explanation" — is specific. The workbench UI displays the reason inline next to the disabled transition button; the audit log records the rejection; a manager investigating a stuck claim needs to read the reason and understand why their action was refused. A boolean `allowed?` is insufficient; the FSM must produce a structured rejection with a human-readable reason.

A fourth pressure, methodological rather than architectural: this is the kind of logic that *attracts* drift. Without an explicit and visible home, transition rules accumulate inside `ClaimsService` methods, inside controller guards, inside DTO validators, inside the workbench UI's enable/disable logic. Six months later, the question "can a manager move a claim from `awaiting_reserve_approval` back to `under_investigation`?" has four different answers in four different files. The discipline question is *where* the answer lives.

## 2. Decision

All claim-status transition logic lives in **one pure function** in **one file**: `evaluateTransition(from, to, claim, actor) → TransitionDecision` in `src/claims/claims-status.fsm.ts`. The function is the single source of truth for the answer to "is this move legal right now for this caller?" Every code path that mutates `claim.status` — controller, service, seed script, future workflow automations — goes through this function. There is no second decision path.

The design has five parts.

### 2.1 The function signature — pure, synchronous, no I/O

```ts
type TransitionDecision =
  | { ok: true }
  | { ok: false; reason: string; code: TransitionRejectionCode };

export function evaluateTransition(
  from: ClaimStatus,
  to: ClaimStatus,
  claim: ClaimForFsm,
  actor: ActorForFsm,
): TransitionDecision;
```

The function takes four inputs and returns a discriminated union. It performs no database queries, no audit writes, no logging, no clock reads beyond what is passed in. The `claim` argument is a narrowed view (`ClaimForFsm`) carrying only the fields the FSM needs to decide — `assigned_adjuster_id`, `assigned_adjuster_reports_to_id`, `has_approved_reserve`, `has_any_reserve`, `created_at`, the current `status`. The `actor` argument is similarly narrowed: `{ id, role, is_claims_director, reports_to_id }`. The narrowing is enforced by TypeScript; a service that wants to call `evaluateTransition` must first project its full Prisma record down to `ClaimForFsm`, which is the moment to confirm the necessary preconditions have been loaded.

Purity is the property that makes the FSM testable without fixtures. The unit test suite (`test/claims-workbench.e2e.spec.ts` covers the integration; a sibling unit test exercises the function in isolation) enumerates every `(from, to, role, ownership, preconditions)` tuple as plain object literals, with no Prisma client and no test database. The matrix is exhaustive and the test runs in milliseconds.

### 2.2 The legal transition graph — the closed enumeration

The FSM declares the legal transitions as a typed constant. Every entry carries the required actor role(s), the required ownership relation, and the required claim preconditions:

| From | To | Required role | Ownership | Preconditions |
|---|---|---|---|---|
| `intake` | `under_investigation` | `manager` | reports' pool | claim has an `assigned_adjuster_id` |
| `intake` | `closed_denied` | `manager` | reports' pool | none (early dismissal — coverage clearly excludes) |
| `under_investigation` | `awaiting_reserve_approval` | `adjuster` | assigned only | `has_any_reserve = true` (a reserve has been proposed) |
| `under_investigation` | `closed_denied` | `manager` | reports' pool | none |
| `under_investigation` | `under_investigation` | — | — | **not legal** (self-transitions are uniformly illegal; use a note instead) |
| `awaiting_reserve_approval` | `under_investigation` | `manager` | reports' pool | the pending reserve has been rejected (`has_approved_reserve = false` and most recent reserve is `rejected`) |
| `awaiting_reserve_approval` | `settlement_offered` | `adjuster` | assigned only | `has_approved_reserve = true` |
| `settlement_offered` | `closed_paid` | `adjuster` | assigned only | `has_approved_reserve = true` |
| `settlement_offered` | `closed_denied` | `manager` | reports' pool | none (claimant rejects offer; carrier denies) |
| `closed_paid` | `reopened` | `manager` | reports' pool | none (regulator inquiry or new evidence) |
| `closed_denied` | `reopened` | `manager` | reports' pool | none |
| `reopened` | `under_investigation` | `manager` | reports' pool | claim has an `assigned_adjuster_id` (reassignment may be needed) |

Every other ordered pair is illegal by omission. The function does not enumerate the illegal set; it enumerates the legal set and rejects anything not in it. This is the property that keeps the FSM correct as the state vocabulary evolves: adding a new state requires adding new legal-set entries, not editing a sprawling switch over illegal cases.

A reviewer who wants to know "can a claim go from X to Y under role Z?" reads exactly one table. The table lives in the same file as the function that consults it.

### 2.3 The rejection reasons — a closed code vocabulary, human-readable text

When `evaluateTransition` rejects, it returns a structured reason. The rejection codes are a closed vocabulary, exported as a TypeScript union:

- `not_in_legal_set` — the `(from, to)` pair is not a legitimate workflow move regardless of who asks. Reason text identifies the pair: `"Cannot transition from 'intake' to 'closed_paid': not a legal workflow move."`
- `wrong_role` — the pair is legal but the caller's role is not authorised. Reason text identifies the required role: `"Only 'manager' may move a claim from 'intake' to 'under_investigation'."`
- `wrong_ownership` — the role is correct but the caller does not own the claim. Reason text identifies the ownership requirement: `"This claim is not assigned to you; only the assigned adjuster may move it from 'under_investigation' to 'awaiting_reserve_approval'."`
- `precondition_missing_assignee` — the transition requires an `assigned_adjuster_id` and none is set. Reason text: `"Cannot enter 'under_investigation' without an assigned adjuster."`
- `precondition_missing_reserve` — the transition requires a proposed reserve and none exists. Reason text: `"Cannot enter 'awaiting_reserve_approval' before a reserve has been proposed."`
- `precondition_missing_approved_reserve` — the transition requires an approved reserve. Reason text: `"Cannot enter 'settlement_offered' without an approved reserve."`
- `precondition_reserve_not_rejected` — the transition out of `awaiting_reserve_approval` back to `under_investigation` requires that the pending reserve be rejected, not still pending. Reason text: `"Cannot return to 'under_investigation' while a reserve proposal is still pending; reject the reserve first."`
- `terminal_state` — the `from` state is terminal in a way that requires `reopened` as an intermediate stop. Reason text: `"Closed claims must be 'reopened' before re-entering the live workflow."`

The controller maps a non-`ok` decision to HTTP 422 with the body `{ error: 'illegal_transition', code, reason }`. The reason text is the literal string the FSM produces; the controller does not paraphrase. The workbench UI displays the reason inline next to the disabled action.

The code is the machine-readable handle. UI logic that wants to disable a button uses the code to decide whether the button should appear at all (a `terminal_state` rejection means the button is hidden; a `wrong_role` rejection means the button is hidden for this user but visible for a manager).

### 2.4 The controller's role — a thin adapter

`PATCH /claims/:id/status` is a thin adapter over the FSM:

1. Validate the DTO (`update-status.dto.ts` — `to: ClaimStatus`, `reason: string`).
2. Load the claim from Prisma with the projection needed for `ClaimForFsm` (`assigned_adjuster_id`, `assigned_adjuster.reports_to_id`, a `has_approved_reserve` boolean computed from the reserves relation, a `has_any_reserve` boolean, `created_at`, current `status`).
3. Call `evaluateTransition(claim.status, dto.to, claimForFsm, actor)`.
4. If `ok: false`, throw `UnprocessableEntityException` with the rejection envelope. The global exception filter formats the response.
5. If `ok: true`, update `claim.status` to `dto.to`, persist `dto.reason` as the most recent status-change reason (a `ClaimNote` of kind `status_transition` is appended in the same transaction; the reason is *not* a free-form field on the claim row, because then it would be overwritten on every transition and lose history).
6. The `@Audit({ action: 'claim.status.transitioned' })` decorator (ADR-002) emits the audit row on successful response, with `payload_hash` covering the `{ to, reason }` body.

The controller does not contain any transition logic of its own. A reviewer who suspects a status-related bug reads the FSM first; the controller is a five-line wrapper.

### 2.5 The workbench UI's role — never the source of truth

The React workbench in `web/src/pages/ClaimDetail.tsx` shows a row of action buttons keyed by the current status: "Begin Investigation", "Propose Reserve", "Mark Settlement Offered", "Close as Paid", "Close as Denied", "Reopen". The UI's enable/disable logic is a *hint*, not an enforcement. It exists to spare users the round-trip of clicking a button only to receive a 422.

The UI consults a shared `legalNextStates(from, role, ownership)` helper that lives alongside the API client (`web/src/lib/api.ts`). The helper is a thin TypeScript port of the FSM's legal-set table, regenerated from the same source on every build. If the UI and the server disagree — because someone has edited only the UI's copy — the server wins: the 422 response surfaces the FSM's rejection text, and the user sees the authoritative reason.

The rationale for replicating the table in the UI is responsiveness: the workbench should not need a server round-trip to grey out an obviously inapplicable button. The rationale for not making the UI authoritative is the obvious one: any client-side guard can be bypassed by a curl, and the server must reject illegal transitions regardless. The FSM is server-side and final; the UI helper is a courtesy.

## 3. The transition diagram — one picture, one source

The state diagram, in ASCII so it lives in version control alongside the FSM code:

```
             ┌──────────────────────────────────────────────┐
             │                                              │
             ▼                                              │
         ┌────────┐   assign+begin    ┌─────────────────┐   │
         │ intake │──────────────────▶│under_investiga- │   │
         └────────┘     (manager)     │     tion        │   │
             │                        └─────────────────┘   │
             │  early dismissal              │   ▲          │
             │  (manager)                    │   │ reserve  │
             │                               │   │ rejected │
             │              propose reserve  │   │(manager) │
             │                  (adjuster)   ▼   │          │
             │                        ┌─────────────────┐   │
             │                        │awaiting_reserve_│   │
             │                        │   approval      │   │
             │                        └─────────────────┘   │
             │                                 │            │
             │           reserve approved      │            │
             │           (adjuster, after      │            │
             │            manager/director     ▼            │
             │            approval)   ┌─────────────────┐   │
             │                        │settlement_      │   │
             │                        │   offered       │   │
             │                        └─────────────────┘   │
             │                          │            │     │
             │          paid (adjuster) │            │     │
             │                          ▼            │     │
             ▼                  ┌─────────────┐      │     │
     ┌───────────────┐          │ closed_paid │      │     │
     │ closed_denied │◀─────────┴─────────────┘      │     │
     └───────────────┘   denied (manager)            │     │
             │                                       │     │
             │  reopen (manager)                     │     │
             └──────────────────▶ ┌──────────┐ ◀─────┘     │
                                  │ reopened │             │
                                  └──────────┘─────────────┘
                                       reassign (manager)
```

The diagram and the legal-set table in §2.2 are kept in sync by convention; the table is the machine-readable form and the diagram is the documentation form. If they ever disagree, the table wins and the diagram is a documentation bug.

## 4. Pre-conditions — why the FSM needs more than the current state

A naive FSM accepts `(from, to)` and consults a static graph. The claims FSM accepts `(from, to, claim, actor)` because three of the legal transitions depend on state outside the `status` column itself:

- **`intake → under_investigation`** requires `assigned_adjuster_id` to be set. The brief's role matrix makes manager assignment a separate action (`POST /claims/:id/assign`) from status transition. The FSM enforces the ordering: a manager cannot "begin investigation" on an unassigned claim, because there is no adjuster to investigate. The pre-condition prevents a race where a manager toggles status without having assigned an adjuster, leaving the claim in a logically inconsistent state.
- **`under_investigation → awaiting_reserve_approval`** requires `has_any_reserve = true`. The state name is literal: you cannot be "awaiting approval" of a reserve that does not exist. The pre-condition prevents the workbench from advancing a claim into a state that the reserves module would then reject as nonsensical.
- **`awaiting_reserve_approval → settlement_offered`** requires `has_approved_reserve = true`. This is the central interlock between the FSM and the reserves approval workflow (ADR-005). A reserve in `pending` status is not sufficient; the FSM consults the reserve's `approval_status` and requires `approved`. For amounts above ¥10M, ADR-005 requires director approval in addition to manager approval; the `has_approved_reserve` boolean is true only when both approvals are present. The FSM does not re-implement the approval tier rules — it consults the boolean that the reserves service computes.
- **`awaiting_reserve_approval → under_investigation`** requires the pending reserve to have been rejected, not merely still pending. This prevents a manager from clicking "back to investigation" while the reserves queue still considers the proposal live, which would leave the reserve in a zombie state.

The pre-condition checks are pure inspections of the `ClaimForFsm` projection. The service layer's responsibility is to load the projection correctly; the FSM's responsibility is to interpret it. The narrowing of `ClaimForFsm` to exactly the fields the FSM needs makes the contract explicit: if the service forgets to load `has_approved_reserve`, the FSM's input does not compile, and the bug surfaces at build time rather than as a missed pre-condition at runtime.

## 5. The audit row that every transition emits

From ADR-002, every status transition produces exactly one `AuditEvent` row with `action = 'claim.status.transitioned'`. The audit envelope captures:

- `actor_id`, `actor_role` — who moved the claim.
- `claim_id` — the claim moved.
- `payload_hash` — sha-256 over the canonicalised `{ to, reason }` body. The `from` state is recoverable from the prior row's `to`, so the hash binds the request to its authoritative input without duplicating data.
- `request_id`, `correlation_id` — the trace ids that link the transition to the upstream cause (an FNOL, a reserve approval, a regulator inquiry).

A reviewer who wants to reconstruct a claim's full status history reads `WHERE claim_id = $1 AND action = 'claim.status.transitioned' ORDER BY ts`. The result is the sequence of moves, in order, with the actor and reason of each. This is the operational property the brief calls out — auditors must be able to answer "who moved this claim into `closed_denied`, when, and why?" — and the FSM-plus-audit-decorator pair delivers it without any additional bookkeeping.

The `ClaimNote` of kind `status_transition` (§2.4 step 5) is the human-readable parallel record. The audit row is the machine-readable cryptographically-bound record; the note is the searchable workbench-facing record. Both are immutable (notes are append-only; the audit log is append-only per ADR-002).

## 6. Consequences

### Positive

- **One file owns the workflow policy.** A reviewer reads `src/claims/claims-status.fsm.ts` — roughly 200 lines including the legal-set table, the pre-condition checks, and the rejection-reason text — and knows every legal move in the system. This is the property the brief's "all workflow logic in one auditable file" decision asks for.
- **The legal-set table is mechanical to test.** The unit test enumerates every entry in §2.2 as a positive case and a sampling of the 49 − N illegal pairs as negative cases. Adding a new state means adding new table entries and new test cases; the framework does not change.
- **Reasoned rejections.** Every illegal transition surfaces a code and a sentence. The workbench UI shows the sentence; the API consumer logs the code; the audit log (on rejection, the failed request is *not* audited — the FSM is consulted before any state change attempt, and a 422 response does not produce a `claim.status.transitioned` row, only the request-level audit if the route is configured for it; in Track A it is not). A future Track B may add a `claim.status.transition_rejected` audit action for forensic purposes; explicitly deferred (§7).
- **The pre-condition interlocks make adjacent modules consistent.** The reserves module (ADR-005) and the claims FSM agree on what "a claim is ready for settlement" means, because the FSM consults the reserves module's computed boolean rather than re-implementing the approval tier rules.
- **The UI helper is a courtesy, not a duplication of policy.** The workbench's button enable/disable logic mirrors the FSM but does not replace it. A discrepancy is visible (the 422 response carries the authoritative reason) and is fixable in the UI without touching the server.
- **Pure-function testing.** The FSM has no dependency injection, no Prisma fixtures, no clock mocking. The test file is a long list of `expect(evaluateTransition(...)).toEqual(...)` calls. Reviewers can read the tests linearly and confirm the matrix matches the table.

### Negative / accepted costs

- **Two-level manager-chain ownership.** The `wrong_ownership` check on manager-actioned transitions uses the same two-level walk that ADR-003 §4 describes (adjuster's `reports_to_id` matches the manager, or the next link up the chain). A four-level carrier hierarchy needs to extend the walk in both places. The walk is hardcoded for the realistic Japanese carrier structure; a configurable depth is Track B.
- **The `ClaimForFsm` projection must be kept in sync with the FSM's needs.** A future engineer who adds a new pre-condition must (a) add the field to the projection type, (b) load it in the service, (c) check it in the FSM. Missing any of these surfaces as a build error rather than a runtime bug, but the three-step contract is a maintenance cost.
- **`reopened` is a transient state.** A claim in `reopened` must move to `under_investigation` before further work; the FSM forbids any other move from `reopened` except via reassignment. This is correct but slightly awkward in the UI — a manager who reopens a claim cannot immediately also close it again without re-entering investigation first. The trade-off is explicit (it prevents reopen-immediately-reclose as a single audit event masking what is really two distinct decisions) and accepted.
- **No bulk transitions.** Each `PATCH /claims/:id/status` moves exactly one claim. A manager processing a batch of catastrophic-event claims must issue one request per claim. The audit chain is cleaner this way (one request → one audit row), and the realistic operational volume in Track A does not justify a bulk path. Track B may add a `POST /claims/bulk-status` for catastrophe-event scenarios.
- **The FSM does not own deletion or anonymisation.** APPI Article 28 anonymisation (Track B) operates orthogonally to the workflow state; an anonymised claim retains its terminal status. The FSM does not have a `terminal` ambient state for "this claim is closed and anonymised, do not even render the action row" — that decision lives in the UI's claim-detail component. This is intentional separation; the FSM is about *workflow*, not *visibility*.
- **Self-transitions are uniformly illegal.** A reviewer might expect `under_investigation → under_investigation` to be a no-op. The FSM rejects it with `not_in_legal_set`. The rationale: a self-transition that produces an audit row but no state change is a misleading artifact; the correct way to record "I worked on this claim for an hour and made no status change" is a `ClaimNote`, not a status transition.

## 7. Track B follow-up

The items deferred to Track B that this ADR explicitly does not address:

- **Rejection audit rows.** A future `claim.status.transition_rejected` action that records every attempted-but-refused transition with the rejection code and reason. Useful for behavioural analysis ("this adjuster keeps trying to close claims they aren't assigned to") but not required for evidentiary purposes. Track B alongside the SIU module's behavioural-flagging work.
- **Configurable manager-chain depth.** Same item as ADR-003 §7; the FSM consults the same ownership descriptor and benefits from the same generalisation.
- **Bulk transitions for catastrophe events.** `POST /claims/bulk-status` accepting a list of claim ids and a single `to` state, with the FSM evaluated per claim. The response is a per-claim accept/reject array; partial success is the design. Deferred until the operational volume justifies it (a real catastrophe event — typhoon, earthquake — produces tens of thousands of claims in days; Track A's volumes do not).
- **Time-based auto-transitions.** Some carriers move stale `intake` claims to `under_investigation` automatically after 24 hours of unassigned dwell, or auto-close `settlement_offered` claims that go unaccepted for 90 days. These are policy choices outside the brief's Track A scope; the FSM can be extended to expose `evaluateAutoTransition(claim, now)` for a background worker to consult. Tracked as part of the Track B operational-automation work.
- **Workflow customisation per line of business.** Auto, fire, marine, and personal accident claims have subtly different lifecycles in practice (marine claims often involve surveyor reports as a pre-condition to settlement). Track A uses one FSM for all incident types; Track B may parameterise the FSM by `incident_type` if a customer demand emerges. Deferred until the demand is concrete.
- **Transition guards based on external signals.** A reinsurance ceding event might pause a claim's progression past `awaiting_reserve_approval` until the cession is acknowledged. Track A has no reinsurance hook; Track B's reinsurance module would add a pre-condition consulted by the FSM through the same `ClaimForFsm` projection mechanism.
- **A state-transition replay tool.** Given a claim's audit history, replay every `claim.status.transitioned` event through the FSM and assert each was legal at the time. This is a forensic tool for incident response; deferred until the audit log accumulates enough history to make replay valuable.
- **Visualisation in the workbench.** A timeline view showing the claim's status history as a horizontal bar with transition annotations, drawn from the `ClaimNote` records of kind `status_transition`. The UI helper exists in Track A's workbench in basic form (the claim detail's timeline section); a richer interactive view is a Track B UX enhancement.

## 8. References

- `brief.md` — Adjuster Workbench specification (`PATCH /claims/:id/status` and the seven-state workflow), the "illegal transitions return 422 with explanation" requirement, the role matrix's status-transition column.
- `design.md` §1 — `ClaimStatus` enum and `Claim.status` column.
- `design.md` §2 — API contract for `PATCH /claims/:id/status`.
- `design.md` §3 — `claims/claims-status.fsm.ts` as the canonical location, `claims/claims.service.ts` and `claims/claims.controller.ts` as the consumers.
- `design.md` §6 — "An actual FSM for claim status with reasoned rejections; not a `string` status with anyone-can-set semantics" — the design's explicit framing of this ADR's subject.
- ADR-002 — audit immutability (every transition emits `claim.status.transitioned`; the `payload_hash` binds the audit row to the `{ to, reason }` body).
- ADR-003 — role masking by APPI tier (status is `public` tier and never masked; the two-level manager-chain ownership rule is shared between the masking interceptor and the FSM's `wrong_ownership` check).
- ADR-005 — reserve approval tiers (the FSM consults `has_approved_reserve`, which the reserves service computes per the tier rules).
- ADR-006 — JFSA notification (the `correlation_id` chain links FNOL through status transitions through reserve approvals to the threshold-crossing notification).
- JFSA Supervisory Guidelines for Insurance Companies — expectations around documented claim-handling workflows and the ability to demonstrate adherence to them.