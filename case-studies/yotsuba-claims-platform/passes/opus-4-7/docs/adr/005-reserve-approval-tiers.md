# ADR-005 — Reserve approval tiers: amount-banded authority encoded as a pure policy function

- **Status:** Accepted (Track A)
- **Date:** 2024-09
- **Deciders:** Claims platform engineering; reviewed against the locked `brief.md` Reserves Management specification (approval workflow thresholds) and `design.md` §1 (`Reserve` model + `ApprovalStatus` enum) + §2 (API contract for `/reserves/*`) + §3 (`reserves/reserves.service.ts`).
- **Related ADRs:** ADR-002 (audit immutability — every approval, director-approval, and rejection emits a distinct audit action), ADR-003 (role masking by APPI tier — proposer / approver identities follow the same manager-chain ownership rule), ADR-004 (claim status FSM — `awaiting_reserve_approval → settlement_offered` consults `has_approved_reserve` which the tier rules compute), ADR-006 (JFSA notification — the ¥100M threshold is a *notification* trigger that fires orthogonally to the *approval* tiers described here).
- **Related code:** `src/reserves/reserves.service.ts`, `src/reserves/reserves.controller.ts`, `src/reserves/dto/propose-reserve.dto.ts`, `src/reserves/dto/reject-reserve.dto.ts`, `prisma/schema.prisma` (`Reserve` model + `ApprovalStatus` enum + `is_claims_director` on `User`).

---

## 1. Context

Reserves are money set aside against the expected payout of a claim. A reserve is not a payment — it is a balance-sheet liability the carrier carries until the claim closes. The aggregate of all open reserves across a carrier's claims is the single largest line on the liability side of the P&C balance sheet, and the *adequacy* of that aggregate is what JFSA, IFRS17, and the external auditors scrutinise hardest. A reserve that is too low understates the carrier's liability and overstates its solvency; a reserve that is too high ties up capital that could otherwise be deployed. Either error is a regulatory and commercial problem.

It follows that *who is allowed to set a reserve at what amount* is one of the most consequential authority questions in the claims platform. Every Japanese P&C carrier has an internal control matrix that bands reserve authority by amount: a junior adjuster can set a small reserve unilaterally; a mid-sized reserve requires a manager's review; a large reserve requires a claims-director (執行役員 or equivalent) sign-off; an exceptional reserve may require a board-level committee. The bands vary by carrier, but the *pattern* — amount-banded authority with mandatory secondary approval above a threshold — is universal.

The `brief.md` makes the Track A bands concrete:

> **Approval workflow** — reserve changes >¥1M require manager approval; >¥10M require manager + claims-director approval. Pure rule, encoded in policy.

And the acceptance criteria back this with a specific test obligation:

> **Reserve approval threshold enforced**: a ¥15M proposal cannot be approved by a manager without claims-director approval; test enforces this.

Three design pressures fall out of this:

1. **The thresholds are policy, not configuration.** They are numbers a regulator could cite in a supervisory letter, and changing them is a governance event — a memo from the claims-director's office, an internal audit re-baseline, a board minute. They are not values a developer should be able to tweak by editing a `.env` file. The brief's phrase — "pure rule, encoded in policy" — is deliberate: the bands live in code, in a named constant, in one file, reviewable in version control.
2. **The bands compose with the role matrix, not replace it.** A manager who is not in the proposing adjuster's reporting chain cannot approve the reserve regardless of amount; an adjuster cannot approve their own proposal regardless of amount; a claims-director who is not also a manager (a hypothetical, since the brief models the director as a flag on a manager) still acts under the manager-chain ownership rule. The amount band is one dimension of authority; role and ownership are the others. All three must be satisfied for an approval to proceed.
3. **A reserve above ¥10M requires *both* approvals, not *either*.** A claims-director approval does not subsume the manager approval; both are recorded on the `Reserve` row, with separate timestamps and separate actor ids, and the FSM-facing `has_approved_reserve` boolean is true only when both are present for amounts in the director-required band. This is the property the brief's acceptance test exercises: a manager cannot unilaterally approve a ¥15M reserve, even if they are the senior manager in the chain, because the director approval is a structurally separate event.

A fourth pressure, methodological, parallels ADR-004: this is exactly the kind of logic that attracts drift. Without an explicit and visible home, the threshold checks would scatter across the controller ("is the caller authorised?"), the service ("does the proposal exceed the band?"), the FSM ("is the reserve approved?"), and the UI ("should this button appear?"). The discipline question, again, is *where the answer lives*.

## 2. Decision

All reserve approval authority logic lives in **one pure function** in **one file**: `evaluateApprovalAuthority(reserve, action, actor) → ApprovalDecision` in `src/reserves/reserves.service.ts` (exported as a module-level named function alongside the service class, so it can be unit-tested without the NestJS container). The function is the single source of truth for the answer to "is this caller allowed to take this approval action on this reserve right now?" Every code path that mutates `Reserve.approval_status`, `Reserve.approved_by_id`, `Reserve.director_approved_by_id`, or the paired timestamps — controller, service, seed script, future automations — goes through this function. There is no second decision path.

The design has six parts.

### 2.1 The threshold constants — named, typed, in one place

The two thresholds live as named `Decimal` constants at the top of `reserves.service.ts`:

```ts
import { Decimal } from '@prisma/client/runtime/library';

export const MANAGER_APPROVAL_THRESHOLD_YEN  = new Decimal(1_000_000);   // > ¥1M requires manager
export const DIRECTOR_APPROVAL_THRESHOLD_YEN = new Decimal(10_000_000);  // > ¥10M requires director
```

The constants are `Decimal`, not `number`. The brief's design §6 is explicit — "Decimal-typed currency end-to-end — no `number` for yen anywhere in the stack" — and the threshold comparisons follow the same rule. A reserve proposed at `proposed_yen = 10_000_001` (one yen above the director threshold) must compare strictly greater than `DIRECTOR_APPROVAL_THRESHOLD_YEN`, and floating-point arithmetic is not acceptable for a comparison whose result determines a regulatory authority requirement. `Decimal.gt` is the comparator.

The constants are exported so the tests can reference them by name rather than by literal value. A test that asserts "a ¥15M proposal requires director approval" reads:

```ts
expect(amount.gt(DIRECTOR_APPROVAL_THRESHOLD_YEN)).toBe(true);
```

rather than reproducing the magic number `10_000_000`. If the carrier later raises the director threshold to ¥20M, the test continues to pass against the new constant without modification; the policy change is the one-line edit to the constant, plus the ADR amendment that documents it.

The boundary semantics are *strictly greater than*. A reserve of exactly ¥1,000,000 is below the manager threshold (self-approving by the proposing adjuster); a reserve of exactly ¥10,000,000 requires manager approval but not director approval. The strict inequality matches the brief's wording (">¥1M", ">¥10M") and is documented in a comment alongside the constant.

### 2.2 The three bands — what each band requires

The `proposed_yen` of a `Reserve` row places it in one of three bands. The bands are a closed enumeration, exported as a TypeScript union:

- **`self_approving`** — `proposed_yen ≤ ¥1M`. The proposing adjuster's authority is sufficient. On `POST /claims/:id/reserves`, the reserves service sets `approval_status = 'approved'` directly, with `approved_by_id = proposed_by_id` and `approved_at = proposed_at`. No separate approval action is required; the audit trail records `reserve.proposed` followed immediately (in the same transaction) by a synthetic `reserve.auto_approved` event (action vocabulary added per ADR-002 §4). The FSM-facing `has_approved_reserve` is true the moment the row is written.
- **`manager_required`** — `¥1M < proposed_yen ≤ ¥10M`. The reserve is created with `approval_status = 'pending'`. A manager in the proposing adjuster's reporting chain may call `POST /reserves/:id/approve` to set `approval_status = 'approved'`. The claims-director flag is irrelevant in this band — any manager in the chain suffices, director or not. The `has_approved_reserve` boolean becomes true on the manager approval.
- **`director_required`** — `proposed_yen > ¥10M`. The reserve is created with `approval_status = 'pending'`. Two distinct approvals are required: a manager approval (`POST /reserves/:id/approve`, recorded in `approved_by_id` / `approved_at`) and a claims-director approval (`POST /reserves/:id/director-approve`, recorded in `director_approved_by_id` / `director_approved_at`). The two approvals may occur in either order. `approval_status` flips to `approved` only when both timestamps are non-null. The `has_approved_reserve` boolean is true only in that final state.

The band is computed by `classifyBand(proposed_yen) → ReserveBand`, a pure function in the same file. It is consulted at three points: on proposal (to decide whether to auto-approve), on manager approval (to decide whether the approval is sufficient or whether director approval is still pending), and on director approval (to validate that the band actually requires director approval — a director-approve call on a ¥5M reserve is rejected as `band_does_not_require_director`).

### 2.3 The function signature — pure, synchronous, no I/O

```ts
type ApprovalAction =
  | 'manager_approve'
  | 'director_approve'
  | 'reject';

type ApprovalDecision =
  | { ok: true }
  | { ok: false; reason: string; code: ApprovalRejectionCode };

export function evaluateApprovalAuthority(
  reserve: ReserveForApproval,
  action: ApprovalAction,
  actor: ActorForApproval,
): ApprovalDecision;
```

The function takes three inputs and returns a discriminated union. It performs no database queries, no audit writes, no logging. The `reserve` argument is a narrowed view (`ReserveForApproval`) carrying only what the function needs: `id`, `claim_id`, `proposed_yen`, `proposed_by_id`, `proposer_reports_to_id` (the proposing adjuster's `reports_to_id`, joined in by the service), `proposer_reports_to_reports_to_id` (one level further up, for the two-level chain), `approval_status`, `approved_by_id`, `director_approved_by_id`. The `actor` argument is `{ id, role, is_claims_director, reports_to_id }`.

The narrowing is enforced by TypeScript. A service that wants to call `evaluateApprovalAuthority` must first project its full Prisma record down to `ReserveForApproval`, which is the moment to confirm the necessary joins have been loaded. Purity makes the function testable as a matrix of object literals, with no Prisma fixtures and no test database — the same testing discipline as the FSM in ADR-004.

### 2.4 The rejection codes — a closed vocabulary, human-readable text

The rejection codes are a closed TypeScript union. The codes and their reason text:

- `wrong_role` — the action requires `manager` role and the caller is not a manager (or requires `manager + is_claims_director` and the caller does not have the director flag). Reason: `"Only a manager may approve a reserve."` or `"Only a manager with the claims-director flag may director-approve a reserve."`
- `wrong_ownership` — the caller is a manager but not in the proposing adjuster's reporting chain. Reason: `"This reserve was proposed by an adjuster outside your reporting chain; only a manager in the chain may approve it."`
- `self_approval_forbidden` — the caller is the proposing adjuster. Reason: `"An adjuster may not approve their own reserve proposal; a manager must approve."` (Defensive: a manager-role caller cannot also be the proposer in normal flow, but the check guards against a future role-elevation bug.)
- `band_does_not_require_director` — a `director_approve` action was invoked on a reserve in the `self_approving` or `manager_required` band. Reason: `"This reserve does not require claims-director approval; the amount is at or below ¥10,000,000."`
- `band_requires_director` — a workflow consumer attempts to treat a manager-only approval as final on a reserve in the `director_required` band. Reason: `"This reserve requires both manager and claims-director approval; the manager approval alone is insufficient."` (This code is produced not by the approval endpoints themselves but by `has_approved_reserve` computation when a downstream consumer asks the wrong question.)
- `already_approved` — the reserve's `approval_status` is already `approved`. Reason: `"This reserve has already been approved."`
- `already_rejected` — the reserve's `approval_status` is already `rejected`. Reason: `"This reserve has already been rejected; a new proposal is required."`
- `manager_approval_missing` — a `director_approve` call arrives before the manager approval. The brief allows the two approvals in either order (§2.2); this code is reserved for a future carrier whose policy requires the manager approval first, and is *not* emitted in Track A. Documented for vocabulary completeness.
- `director_approval_missing` — symmetric counterpart; also not emitted in Track A.

The controller maps a non-`ok` decision to HTTP 403 (for authority failures) or 409 (for state-conflict failures like `already_approved`), with the body `{ error: 'approval_denied', code, reason }`. The reason text is the literal string the function produces; the controller does not paraphrase. The workbench's reserve-approvals page (ADR-003-masked, of course, for non-chain managers) renders the reason inline.

### 2.5 The two-event semantics for the director-required band

A reserve in the `director_required` band traverses three persisted states:

1. **After `POST /claims/:id/reserves`** — `approval_status = 'pending'`, `approved_by_id = null`, `director_approved_by_id = null`. The reserve is visible in the manager's queue and the director's queue.
2. **After the first approval (manager or director, either order)** — `approval_status` remains `'pending'`. Exactly one of `approved_by_id` / `director_approved_by_id` is populated. The audit log records `reserve.approved` or `reserve.director_approved` as appropriate. The FSM-facing `has_approved_reserve` is *still false*.
3. **After the second approval** — both ids are populated; `approval_status` flips to `'approved'`. The audit log records the second action. `has_approved_reserve` becomes true. The claim's status FSM (ADR-004) can now legally accept `awaiting_reserve_approval → settlement_offered`.

The two events are atomic individually but not collectively. A reserve can sit in the intermediate one-approval state indefinitely; this is a feature, not a bug, because it surfaces the carrier's internal approval workflow as a visible queue ("reserves waiting on director", "reserves waiting on manager") rather than collapsing the two approvals into a single black-box transaction. The workbench shows the intermediate state with a partial-approval indicator: one of the two slots filled, the other awaiting action.

The ordering tolerance — either approval first — is a deliberate accommodation of carrier operational reality. A claims-director may approve reserves in batch during a scheduled review window; the manager may approve as the proposal lands. Forcing a fixed order would create artificial bottlenecks. The trade-off is that the audit log must be consulted to determine the actual sequence (the `ts` columns on the `reserve.approved` and `reserve.director_approved` rows give the truthful ordering); the `Reserve` row itself records only the two timestamps without enforcing their relationship.

### 2.6 The controller's role — a thin adapter, again

Each approval endpoint is a thin adapter over `evaluateApprovalAuthority`:

- `POST /reserves/:id/approve`:
  1. Load the reserve with the joins needed for `ReserveForApproval`.
  2. Call `evaluateApprovalAuthority(reserve, 'manager_approve', actor)`.
  3. If `ok: false`, throw the appropriate exception (403 / 409) with the rejection envelope.
  4. If `ok: true`, update `approved_by_id` and `approved_at`. If the band is `manager_required`, also flip `approval_status` to `approved`. If the band is `director_required`, leave `approval_status = pending` unless `director_approved_by_id` is already set.
  5. The `@Audit({ action: 'reserve.approved' })` decorator emits the audit row.
- `POST /reserves/:id/director-approve`:
  1. Same projection.
  2. Call `evaluateApprovalAuthority(reserve, 'director_approve', actor)`. The function checks `actor.role === 'manager' && actor.is_claims_director === true`, the band, ownership, and prior state.
  3. Same exception mapping.
  4. Update `director_approved_by_id` and `director_approved_at`. Flip `approval_status` to `approved` only when both timestamps are present.
  5. `@Audit({ action: 'reserve.director_approved' })`.
- `POST /reserves/:id/reject`:
  1. Same projection.
  2. Call `evaluateApprovalAuthority(reserve, 'reject', actor)`. Rejection requires `manager` role and chain ownership; the band does not constrain rejection (a manager may reject any pending reserve in their chain regardless of amount).
  3. Same exception mapping.
  4. Update `approval_status = 'rejected'`, `reason_for_rejection = dto.reason_for_rejection`. The rejection DTO requires a non-empty reason; the brief's APPI / audit framing makes silent rejection unacceptable.
  5. `@Audit({ action: 'reserve.rejected' })`.

The controllers contain no threshold arithmetic, no role checks beyond the route-level `RolesGuard`, no ownership walks. The full authority logic is in the FSM-style function. A reviewer who suspects an approval bug reads `evaluateApprovalAuthority` first; the controllers are thin wrappers.

## 3. The `has_approved_reserve` boolean — the interface to the rest of the system

The FSM (ADR-004) and the JFSA notification service (ADR-006) both need to ask the question "is this reserve fully approved?" without re-implementing the band rules. The reserves service exposes a pure helper:

```ts
export function hasApprovedReserve(reserve: ReserveForApproval): boolean;
```

The implementation:

- If `approval_status !== 'approved'`, return `false`. (This handles the `pending` and `rejected` states uniformly.)
- If `approval_status === 'approved'`, the band-specific invariants hold by construction: in the `self_approving` band, `approved_by_id` is the proposer; in the `manager_required` band, `approved_by_id` is a chain manager; in the `director_required` band, *both* `approved_by_id` and `director_approved_by_id` are populated. The service's update logic enforces these invariants on write, so the read can trust them.
- Return `true`.

The FSM consults `hasApprovedReserve` via the `has_approved_reserve` field on `ClaimForFsm`, which the claims service computes by loading the most recent (highest `proposed_at`) reserve for the claim and passing it through `hasApprovedReserve`. The two-module coupling is one-way: reserves owns the rule, claims consults the boolean. The FSM never imports `MANAGER_APPROVAL_THRESHOLD_YEN` or `DIRECTOR_APPROVAL_THRESHOLD_YEN`.

This is the architectural property the brief's design §3 expresses by placing the FSM consultation interface inside `reserves.service.ts`: a downstream module that wants to know about reserve approval state asks the reserves module, and the reserves module owns the answer end-to-end. A future change to the bands (¥10M raised to ¥20M, say) is a one-line edit to a constant, with no ripple into the FSM file.

## 4. The audit rows that approvals emit

From ADR-002 §4, each approval action emits a distinct audit row with a distinct action string:

- `reserve.proposed` — `POST /claims/:id/reserves` produces this row regardless of band. `payload_hash` covers the canonicalised proposal body (`category`, `proposed_yen`, `justification`).
- `reserve.auto_approved` — a synthetic row emitted by the service when a `self_approving`-band proposal is auto-approved at write time. Distinct from `reserve.approved` so that the audit log makes the auto-approval visible rather than disguising it as a normal manager approval.
- `reserve.approved` — `POST /reserves/:id/approve` produces this row. `payload_hash` is empty-body-canonical; the binding is via `target_id` (the reserve id) and `claim_id`.
- `reserve.director_approved` — `POST /reserves/:id/director-approve` produces this row. Same envelope shape.
- `reserve.rejected` — `POST /reserves/:id/reject` produces this row. `payload_hash` covers the `reason_for_rejection`.

The `correlation_id` chain (ADR-002 §3) links all the rows for a single reserve's lifecycle: the proposal, any one-of-two intermediate approval, the final approval (or the rejection), and any downstream consequences (the FSM transition into `settlement_offered`, the JFSA threshold notification if the amount crossed ¥100M per ADR-006). A reviewer reconstructing a single reserve's history reads `WHERE target_id = $1 ORDER BY ts`; a reviewer reconstructing a claim's full financial decision history reads `WHERE claim_id = $1 AND action LIKE 'reserve.%' ORDER BY ts`.

For a `director_required`-band reserve, the audit log shows three rows for the success path (`reserve.proposed`, then either `reserve.approved → reserve.director_approved` or `reserve.director_approved → reserve.approved`) plus the `reserve.status_flipped_to_approved` synthetic row written by the service when the second timestamp lands. The synthetic row is what makes the moment of *full* approval distinct from the moment of *either individual* approval in the audit timeline, and it is what the FSM's `has_approved_reserve` boolean is synchronised against.

## 5. The reserve history — full immutability of the change record

The brief calls out:

> **Reserve history** — full immutable history of every reserve change, queryable per claim. Critical for audit and IFRS17 walk-forwards.

The `Reserve` table is append-only in the same convention as `AuditEvent` (ADR-002). A revised reserve estimate is a *new* `Reserve` row with `prior_yen` set to the previous row's `proposed_yen`; the previous row is not mutated. This means every claim accumulates a chain of `Reserve` rows ordered by `proposed_at`, each one carrying the justification for the change from the prior estimate. The IFRS17 walk-forward (the actuarial reconciliation between two reporting periods' aggregate reserves) is computable from this chain by summing across claims and across categories.

The append-only convention for reserves is weaker than the convention for the audit log — there is no separate hash-binding, no closed action vocabulary — but the pattern is the same: no UPDATE or DELETE path in code for historical rows. The `prior_yen` linkage means the chain is reconstructible even if a row is somehow lost; the audit log's `reserve.proposed` events provide the secondary record.

The `GET /claims/:id/reserves` endpoint returns the full chain, ordered by `proposed_at`. The workbench's reserve panel renders the chain as a vertical timeline with each entry showing the band, the proposer, the approval state, and the delta from the prior estimate. This is the operational property the IFRS17 reviewers want — every reserve change visible, with its justification and its approval lineage, in a single read.

## 6. Consequences

### Positive

- **Acceptance criterion #9 is mechanically met.** A ¥15M proposal is in the `director_required` band; a manager calling `POST /reserves/:id/approve` populates `approved_by_id` but leaves `approval_status = pending`, and a subsequent FSM consultation of `has_approved_reserve` returns `false`. The test asserts both the persisted state and the FSM-facing boolean.
- **One file owns the policy.** A reviewer reads the threshold constants, the band classifier, the authority function, and the `hasApprovedReserve` helper — all in `reserves.service.ts` — and knows every reserve approval rule in the system. The brief's "pure rule, encoded in policy" framing is delivered as code that a non-engineer reviewer (a claims-director, an internal auditor) can read.
- **Decimal-typed currency.** The thresholds, the proposed amounts, and the comparisons are all `Decimal`. No floating-point arithmetic touches reserve authority. The design's §6 invariant is upheld at the most consequential decision point in the platform.
- **Two-event semantics for the director band.** The intermediate one-approval state is visible in the workbench queue, in the audit log, and in the persisted `Reserve` row. The carrier's internal control review can confirm both approvals happened, in either order, with both timestamps and actor ids on the record.
- **The `has_approved_reserve` interface is one-way.** Downstream modules (FSM, JFSA notification, IFRS17 export) consult the boolean; the bands themselves are private to the reserves module. A threshold change is a one-line edit with no cross-module impact.
- **Symmetric audit vocabulary.** Each approval action has its own action string. A reviewer querying `WHERE action = 'reserve.director_approved'` gets exactly the director approvals, separately from manager approvals, separately from auto-approvals. The audit log is searchable on the dimensions a regulator would actually ask about.
- **Append-only reserve history.** The IFRS17 walk-forward query is a simple aggregation over the `Reserve` table without any joins to a separate history table or any reconstruction from audit events. The reserve chain is the operational record; the audit log is the cryptographically-bound parallel record.

### Negative / accepted costs

- **The bands are hardcoded.** A carrier whose policy is ¥500K / ¥5M (rather than the brief's ¥1M / ¥10M) cannot configure the thresholds without a code edit. This is intentional — the policy framing forbids `.env` configuration of regulatory bands — but it does mean Track A is single-tenant in the sense that the bands are baked in. Multi-tenant deployments with per-tenant policy are Track B.
- **The two-level manager-chain ownership.** The same hardcoded two-level walk as ADR-003 §4 and ADR-004 §2.2. A four-level carrier hierarchy needs the walk extended in three places now (masking, FSM, approvals). Tracked uniformly as a Track B generalisation.
- **The `is_claims_director` flag is a boolean on `User`.** A carrier whose claims-director authority is delegated temporarily (e.g. during the director's leave) cannot grant the flag with an expiry without a code change. Track A models the flag as a static attribute; time-bounded delegation is Track B.
- **The two-event ordering is not policed.** A carrier whose policy requires manager approval *before* director approval (some carriers do) cannot express that constraint without extending `evaluateApprovalAuthority` to consult the prior-approval state. The rejection codes `manager_approval_missing` / `director_approval_missing` are reserved for this, but the Track A function does not emit them. Documented; extensible.
- **Auto-approval within `self_approving` is invisible in the workbench's "reserves awaiting approval" queue, by design.** A reviewer who wants to audit the volume of auto-approvals must query the audit log for `reserve.auto_approved`, not the `Reserve` table filtered by `approval_status = pending`. This is correct (the queue is for items needing action) but slightly counter-intuitive (a small reserve still went through an approval, just an automatic one). The audit row exists precisely to make the auto-approval volume observable.
- **The director threshold is the same as the FSM-facing approval question.** A carrier that wanted to distinguish "approved enough to enter `settlement_offered`" from "approved enough to actually pay" would need a separate state. Track A collapses the two; the FSM's `has_approved_reserve` is the gate for both. Tracked as a Track B refinement if a customer demands it.
- **The JFSA ¥100M threshold (ADR-006) is *not* a third approval tier.** A reserve above ¥100M still requires only manager + director approval at the authority level; the ¥100M figure triggers a *notification* to the regulator (ADR-006), not an additional approval signature. A reviewer might expect the two thresholds to compose — and a real carrier might add a third approval tier at ¥100M as a matter of internal policy — but the brief's framing is explicit that the ¥100M threshold is regulatory notification, not internal authority. The two ADRs are deliberately separate.

## 7. Track B follow-up

The items deferred to Track B that this ADR explicitly does not address:

- **Per-tenant configurable thresholds.** A policy DSL (or a structured tenant-policy table with audit-logged changes) that lets each carrier express its own bands. The hardcoded constants become the default policy; the DSL is the production deployment surface. Aligned with ADR-003 §7's ABAC framework.
- **Time-bounded `is_claims_director` delegation.** A `claims_director_grants` table with `granted_to_id`, `granted_by_id`, `valid_from`, `valid_until`, and an audit-logged history of grants. The `evaluateApprovalAuthority` function consults the table instead of the boolean flag.
- **A third (board-level) tier above ¥100M or some higher threshold.** Some carriers require a board committee for reserves above a very large amount. Track A does not model this; Track B adds a `board_approved_by_id` / `board_approved_at` column pair and a corresponding `reserve.board_approved` audit action.
- **Ordering enforcement.** A policy option that requires manager approval before director approval (or vice versa). Implementation: a flag on the tenant policy plus the corresponding emission of `manager_approval_missing` / `director_approval_missing` codes.
- **Approval delegation by amount.** A senior adjuster with explicit per-claim delegated authority up to ¥3M, say, would be in the `manager_required` band by amount but in the `self_approving` band by delegated authority. Track A does not model delegation; Track B adds a `delegated_authority_yen` field on `User` (or a more structured per-claim grant table) and an additional branch in `evaluateApprovalAuthority`.
- **A reserve approval SLA dashboard.** Surface the intermediate one-approval state with age, so an operations manager can see which reserves are stuck waiting on the second approver. The data is in the audit log already; the dashboard is a workbench UX feature.
- **Walk-forward export with director-approval breakdown.** The IFRS17 export today aggregates by category; a richer export breaks down the period's reserve changes by approval tier (auto-approved, manager-approved, director-approved) so the actuarial team can see the authority profile of the change book. Tracked alongside the IFRS17 export evolution in `reserves-export.service.ts`.
- **A reserve-correction audit pattern.** Today a revised reserve estimate is a new `Reserve` row with `prior_yen`; a *correction* to a wrongly-entered estimate (typo, mis-categorisation) has the same shape, which makes corrections indistinguishable from genuine revisions in the chain. Track B introduces a `change_kind` column distinguishing `revision` from `correction`, with corrections requiring an additional justification field and an elevated approval band regardless of amount.
- **Cross-claim reserve aggregation for catastrophic events.** During a typhoon or earthquake, a single event spawns thousands of related claims, and the carrier may want to set an aggregate event-level reserve in addition to per-claim reserves. Track A has no event-level reserve concept; Track B introduces it alongside the catastrophe workflow.

## 8. References

- `brief.md` — Reserves Management specification (the ¥1M / ¥10M / ¥100M thresholds, the "pure rule, encoded in policy" framing), acceptance criterion #9 (the ¥15M test), the role matrix's reserve columns.
- `design.md` §1 — `Reserve` model (`proposed_yen` as `Decimal @db.Decimal(15,0)`, `approval_status`, `approved_by_id`, `director_approved_by_id` and their paired timestamps), `User.is_claims_director` flag.
- `design.md` §2 — API contract for `/claims/:id/reserves`, `/reserves/:id/approve`, `/reserves/:id/director-approve`, `/reserves/:id/reject`, `/reserves/export`.
- `design.md` §3 — `reserves/reserves.service.ts` as the canonical location, `reserves/reserves-jfsa.service.ts` and `reserves/reserves-export.service.ts` as adjacent modules.
- `design.md` §6 — "Regulatory thresholds encoded as policy, not magic numbers — every JFSA / IFRS17 / APPI rule is a named constant in a single config module" and "Decimal-typed currency end-to-end — no `number` for yen anywhere in the stack" — the design's explicit framings of this ADR's subject.
- ADR-002 — audit immutability (the five distinct `reserve.*` audit actions, the closed action vocabulary, the `correlation_id` chain linking proposal through approvals through downstream consequences).
- ADR-003 — role masking by APPI tier (proposer / approver identities follow the same manager-chain ownership rule used here for authority).
- ADR-004 — claim status FSM (the FSM's `has_approved_reserve` boolean is computed by this module's `hasApprovedReserve` helper; the `awaiting_reserve_approval → settlement_offered` transition is the FSM-side consequence of full reserve approval).
- ADR-006 — JFSA notification (the ¥100M threshold is a *notification* trigger that fires orthogonally to the *approval* tiers; the two ADRs are deliberately separate).
- JFSA Supervisory Guidelines for Insurance Companies — expectations around documented reserve-setting authority and the segregation-of-duties between proposer and approver.
- IFRS17 — reserve walk-forward disclosure requirements that the append-only `Reserve` table is structured to satisfy.
- 個人情報の保護に関する法律 (APPI) — Article 17 (the proposing adjuster and approving manager identities are standard PII; their masking in non-chain views follows ADR-003).