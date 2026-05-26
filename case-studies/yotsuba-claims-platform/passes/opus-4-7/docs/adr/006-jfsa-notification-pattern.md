# ADR-006 — JFSA notification pattern: an event-shaped trigger captured at the moment the threshold is crossed, flushed by a Track B daily job

- **Status:** Accepted (Track A)
- **Date:** 2024-09
- **Deciders:** Claims platform engineering; reviewed against the locked `brief.md` Reserves Management specification (the ¥100M JFSA threshold notification) and `design.md` §1 (`NotificationToRegulator` model) + §2 (API contract for `/notifications/jfsa-pending`) + §3 (`reserves/reserves-jfsa.service.ts`).
- **Related ADRs:** ADR-002 (audit immutability — the threshold-crossing detection emits a `jfsa.notification_queued` audit action that pairs with the `NotificationToRegulator` row), ADR-003 (role masking by APPI tier — the pending-notifications endpoint is auditor-only and returns claim ids that the auditor can already see), ADR-004 (claim status FSM — the correlation chain from FNOL through reserve approval to threshold detection is reconstructible via the shared `correlation_id`), ADR-005 (reserve approval tiers — the ¥100M notification threshold is *orthogonal* to the ¥1M / ¥10M approval tiers and the two ADRs are deliberately separate).
- **Related code:** `src/reserves/reserves-jfsa.service.ts`, `src/reserves/reserves.service.ts` (the call site that invokes the JFSA service after a reserve approval lands), `src/audit/audit.controller.ts` (for the `/notifications/jfsa-pending` adjacent endpoint), `prisma/schema.prisma` (`NotificationToRegulator` model).

---

## 1. Context

The Japan Financial Services Agency (金融庁, JFSA) supervises P&C insurers under the Insurance Business Act (保険業法) and a body of supervisory guidelines that, among many other things, require carriers to notify the regulator of certain material events on a defined cadence. A reserve change of a sufficiently large magnitude on a single claim is one such event: it signals that the carrier has revised its view of a potentially solvency-affecting liability, and the regulator wants to know about it within a defined window — typically next business day, sometimes same day for very large amounts — so that the supervisory team can ask follow-up questions before the change is buried in the next quarterly aggregate.

The `brief.md` makes the Track A trigger concrete:

> **JFSA threshold notification** — any single reserve change crossing ¥100M triggers an asynchronous notification record (`NotificationToRegulator`) earmarked for daily JFSA reporting. Captured as an event; not actually sent in POC.

And the brief frames the Track A delivery posture explicitly:

> The POC captures the *event shape* — the regulatory wire format is Track B.

Three design pressures fall out of this:

1. **The detection must happen at the moment the threshold is crossed, not at the moment a daily batch runs.** A reserve approved at 23:55 on a Tuesday must produce a notification row dated Tuesday, with the actor and reserve ids captured at the moment of approval, even if the daily flush to the regulator does not run until Wednesday morning. If the detection lived in the daily job, a reserve approval whose data was subsequently amended (a `prior_yen` correction, a rejection-and-re-proposal) would produce ambiguity about *which* version of the reserve crossed the threshold. The synchronous emit-at-approval pattern binds the notification to the specific approval event that caused it, by `reserve_id` and by audit `correlation_id`.
2. **The threshold is on the *change*, not on the *level*.** A reserve that is revised from ¥80M to ¥150M crosses the ¥100M threshold by the amount of the change (¥70M) and by the absolute level (¥150M). A reserve that is revised from ¥120M to ¥130M does not cross the threshold by change (¥10M) but *is* at a level above ¥100M. The brief's phrase — "any single reserve change crossing ¥100M" — is ambiguous between these readings, and the ADR has to pick a reading and stick to it. Track A reads the threshold as *crossing*: a notification fires when the absolute approved amount transitions from below-or-equal ¥100M to above ¥100M, or when a fresh proposal lands above ¥100M with no prior. This matches the regulatory intent (the regulator wants to know about the *event* of crossing the threshold, not about every ongoing reserve that happens to sit above it) and is the reading the §2.3 specification codifies.
3. **The Track A deliverable is the event shape, not the wire protocol.** A real JFSA submission carries a defined XML / fixed-width record format, electronic signatures from a registered carrier representative, a transmission timestamp from the regulator's receiving system, and an acknowledgement workflow. None of these are in scope for Track A. The ADR must be explicit that the `NotificationToRegulator` row is the *internal* record that *would be* serialised and sent by a Track B daily job, and that the POC's evidentiary value is in demonstrating that the threshold is reliably detected and the notification queue is reliably populated — not in any claim of wire-format conformance.

A fourth pressure, methodological, parallels ADR-004 and ADR-005: the threshold rule must live in one named constant in one file, reviewable in version control as a policy edit rather than as a configuration tweak. The brief's §6 framing — "Regulatory thresholds encoded as policy, not magic numbers — every JFSA / IFRS17 / APPI rule is a named constant in a single config module" — applies to the ¥100M figure exactly as it applies to the ¥1M / ¥10M figures of ADR-005.

## 2. Decision

The threshold-crossing detection is implemented as **one pure function plus one transactional emit** in `src/reserves/reserves-jfsa.service.ts`. The pure function decides whether a given reserve approval event crosses the threshold; the transactional emit writes the `NotificationToRegulator` row and the paired audit row in the same database transaction as the approval that triggered them, so that the notification queue is never observable in a state inconsistent with the reserve table that produced it. The Track B daily flush job is a separate consumer of the notification queue and is explicitly out of scope here.

The design has six parts.

### 2.1 The threshold constant — named, typed, alongside the approval thresholds

The JFSA notification threshold lives as a named `Decimal` constant at the top of `reserves-jfsa.service.ts`:

```ts
import { Decimal } from '@prisma/client/runtime/library';

export const JFSA_NOTIFICATION_THRESHOLD_YEN = new Decimal(100_000_000);  // > ¥100M crosses
```

The constant is `Decimal`, not `number`, for the same reasons ADR-005 §2.1 articulates: the design §6 invariant against floating-point currency, and the regulatory consequence of a comparison whose result determines whether the regulator is notified. The comparator is `Decimal.gt` — strictly greater than ¥100,000,000, matching the brief's "crossing ¥100M" wording.

The constant is exported so tests can reference it by name. A future policy change (the JFSA raising the threshold, or the carrier adopting a stricter internal threshold below the regulatory minimum) is a one-line edit to the constant plus the ADR amendment that documents the change. The constant is deliberately *not* read from `.env` or from a tenant-policy table; the policy framing forbids configuration of regulatory thresholds outside the version-controlled source.

The constant lives in `reserves-jfsa.service.ts` rather than in `reserves.service.ts` because the JFSA threshold is operationally separate from the approval tiers — ADR-005 §6 closes with this exact separation argument. A reviewer who wants to know the approval bands reads `reserves.service.ts`; a reviewer who wants to know the regulator-notification trigger reads `reserves-jfsa.service.ts`. The two files import each other's types where necessary but neither imports the other's threshold constants.

### 2.2 The trigger event — full approval, not intermediate states

The notification fires at the moment a reserve reaches `approval_status = 'approved'` *and* the approved amount crosses the threshold. Specifically:

- For a `self_approving`-band reserve (ADR-005 §2.2), the approval and the proposal are the same event; the threshold check runs at proposal time.
- For a `manager_required`-band reserve, the approval is the manager's call to `POST /reserves/:id/approve`; the threshold check runs at that moment.
- For a `director_required`-band reserve, the approval becomes *full* at the moment the second of the two timestamps lands (whichever of `approved_at` or `director_approved_at` arrives second). The threshold check runs at that second-approval moment, not at the first. A reserve that is manager-approved but still awaiting director approval does *not* trigger a notification, even though the amount is necessarily above ¥10M and could be above ¥100M.

The rationale for waiting on full approval: a notification to the regulator stating that the carrier has revised its view of a ¥150M liability is only true once the carrier has formally adopted that revised view. A manager-only approval on a director-required-band reserve is, by ADR-005's two-event semantics, an intermediate state; the carrier has not yet formally adopted the change. Notifying the regulator at the intermediate point would risk a subsequent director rejection producing a retraction, which the regulator's intake process is not designed to handle gracefully.

The rejection path is symmetrical: a reserve that reaches `approval_status = 'rejected'` produces no notification, regardless of the proposed amount. A proposal of ¥200M that the manager rejects is, from the regulator's perspective, a non-event.

The re-proposal path is the operationally interesting one. If a reserve at ¥80M is approved (no notification), and then a *new* `Reserve` row with `prior_yen = 80_000_000` and `proposed_yen = 150_000_000` is approved, the new row crosses the threshold at its approval moment and produces a notification. The notification's `reserve_id` points to the *new* row; the audit `correlation_id` chain links back to the original proposal. The append-only reserve history (ADR-005 §5) makes the chain reconstructible.

### 2.3 The crossing semantics — absolute level, not delta

The pure function that decides whether a notification is required:

```ts
export function crossesJfsaThreshold(reserve: ReserveForJfsa): boolean {
  return reserve.proposed_yen.gt(JFSA_NOTIFICATION_THRESHOLD_YEN);
}
```

The `ReserveForJfsa` projection carries `proposed_yen` and `prior_yen`. The function consults only `proposed_yen`. A reserve whose `proposed_yen` is above the threshold crosses it, regardless of where `prior_yen` sat.

The alternative reading — "crosses" as a delta-based predicate, `proposed_yen.minus(prior_yen ?? 0).gt(threshold)` — was considered and rejected. The rejection rationale:

- **Regulatory intent.** The regulator's concern is the carrier's adopted view of the liability, not the size of the bookkeeping step. A reserve revised from ¥99M to ¥101M is, by the delta reading, a ¥2M change that does not cross the threshold; by the absolute-level reading, it is a transition into the supervised band that the regulator wants to know about. The absolute-level reading aligns with how Japanese P&C carriers actually report to JFSA in practice.
- **Re-proposal stability.** A reserve at ¥150M that is rejected and re-proposed at ¥150M (unchanged amount, different justification) produces, under the absolute-level reading, a fresh notification on the new approval — which is correct, because the carrier has re-adopted the view after the rejection, and the regulator wants to see the re-adoption event. The delta reading would suppress this notification (delta = 0) and lose the audit-visible signal of the re-adoption.
- **Catastrophe correctness.** During a catastrophe event, multiple small revisions can stair-step a reserve from ¥10M to ¥110M over the course of a few hours. The absolute-level reading fires exactly one notification — at the revision that crosses ¥100M — regardless of how many small steps preceded it. The delta reading would fire zero notifications (no single delta exceeds ¥100M), which is the wrong answer.

The trade-off is that a reserve that is *already* above ¥100M on a prior approval and is then revised to a new amount *also* above ¥100M produces a fresh notification on each approval. A reserve revised from ¥150M to ¥160M, both fully approved, produces two notifications across its lifecycle. This is the correct behaviour: each approval is a distinct carrier-adopted view of the liability, and the regulator wants each one. The notification queue carries the `reserve_id` of each individual approved row, so the regulator-facing daily aggregation (Track B) can collapse adjacent revisions of the same claim into a single line item if the carrier's submission template prefers that view; the queue's job is to capture every event, not to deduplicate them.

### 2.4 The transactional emit — one transaction, three writes

When `reserves.service.ts` lands a reserve into `approval_status = 'approved'`, the surrounding Prisma transaction performs three writes:

1. **The `Reserve` row update** — flipping `approval_status` to `'approved'` and populating the relevant timestamp (or, in the second-approval case for a director-required reserve, populating the second timestamp; the flip to `'approved'` happens at the moment both are populated).
2. **The audit row for the approval action** — `reserve.approved`, `reserve.director_approved`, `reserve.auto_approved`, or the synthetic `reserve.status_flipped_to_approved` as described in ADR-005 §4.
3. **If `crossesJfsaThreshold(reserve)` returns true** — the `NotificationToRegulator` row write *plus* a paired `AuditEvent` row with `action = 'jfsa.notification_queued'`. Both are written inside the same transaction.

The transactional bundling is the property that prevents observable inconsistency. A reader querying the `NotificationToRegulator` table cannot see a row whose corresponding `Reserve` row is not yet `approved`; a reader querying the audit log cannot see a `reserve.approved` row without the paired `jfsa.notification_queued` row if the threshold was crossed. The Track B daily flush job consumes the notification table and can rely on the invariant that every `triggered_at` it sees corresponds to a fully-approved reserve.

The `NotificationToRegulator` row's fields, from `design.md` §1:

- `id` — cuid, unique.
- `kind` — the literal string `"jfsa_reserve_threshold"`. The closed vocabulary leaves room for future notification kinds (subrogation recoveries above a threshold, fraud determinations on large claims) without changing the table shape; Track A emits exactly one kind.
- `claim_id` — the claim whose reserve crossed.
- `reserve_id` — the specific `Reserve` row that crossed. The append-only history (ADR-005 §5) means this id uniquely identifies the approval event.
- `amount_yen` — the `proposed_yen` of the crossing reserve, captured at emit time. A snapshot, not a join — if the reserve table were somehow corrupted, the notification still carries the amount that triggered it.
- `triggered_at` — `now()` at the moment of the emit. The transactional context means this is the same instant as the reserve's flip-to-approved.
- `sent_at` — `null` in Track A. The Track B daily flush job will populate this when the notification is included in a successful regulator submission. The presence of a `sent_at` column with no Track A write path is intentional: the schema is forward-compatible with the Track B job that hasn't been written yet, and the schema migration when Track B lands is the no-op of populating an existing column.

The paired audit row carries the standard envelope: `actor_id` and `actor_role` of the approving actor (the manager or director whose approval caused the threshold to cross, not a synthetic system actor — the human who took the action is the auditable actor), `claim_id` of the affected claim, `target_id` of the `NotificationToRegulator` row, `payload_hash` over the canonicalised `{ kind, claim_id, reserve_id, amount_yen }` body, and the `request_id` / `correlation_id` of the approval request. This means the correlation chain spans the entire causal sequence: FNOL request → assignment request → reserve proposal request → reserve approval request → (transparently within the approval request) the notification emit. A reviewer reconstructing "why did we notify the regulator about this claim?" reads `WHERE claim_id = $1 ORDER BY ts` on the audit log and sees the full chain in order.

### 2.5 The pending-notifications endpoint — auditor-only visibility into the queue

`GET /notifications/jfsa-pending`, from `design.md` §2, returns the rows of `NotificationToRegulator` whose `sent_at IS NULL`, ordered by `triggered_at`. The endpoint is `auditor`-only per the role matrix; no other role has any operational reason to read the regulator queue, and exposing it to managers or adjusters would invite informal pre-disclosure of regulatory submissions to claims-handling staff who should not be making submission decisions.

The endpoint's response is intentionally thin: the list of pending notifications with their `claim_id`, `reserve_id`, `amount_yen`, and `triggered_at`. It does not embed the full claim or reserve records; an auditor who wants to investigate a specific notification follows the `claim_id` to `GET /claims/:id` (which the auditor's role grants) and the `reserve_id` to `GET /claims/:id/reserves`. The endpoint's role is to surface the *existence and shape* of the pending queue, not to provide a one-shot investigative read.

The endpoint is itself audited as a read action — `@Audit({ action: 'jfsa.pending_queried' })` — so the audit log records every time an auditor inspects the queue. This is the audit-the-auditor pattern from ADR-002: a regulator inquiring about the integrity of the notification queue can ask "who has read this queue, and when?" and receive a complete answer.

In Track A there is no endpoint to *mark* a notification as sent; `sent_at` is populated only by the Track B daily flush job (which will operate as a database-direct background worker, not via the HTTP API). The absence of a `POST /notifications/:id/mark-sent` endpoint in Track A is intentional: the operational surface for marking submissions complete belongs to the (yet-to-be-built) submission tooling, not to the HTTP API that adjusters and managers use, and prematurely exposing it would create a path for accidentally marking notifications sent without an actual submission having occurred.

### 2.6 The Track B boundary — what this ADR is explicitly not specifying

The boundary between Track A and Track B for JFSA notification is sharp and worth stating plainly:

- **Track A delivers:** detection at the moment of approval, transactional emit of `NotificationToRegulator` + paired audit row, an auditor-only read endpoint over the pending queue, a forward-compatible schema with a `sent_at` column awaiting the future writer.
- **Track B delivers:** the daily flush job (cron-scheduled background worker), the JFSA wire-format serialiser (XML / fixed-width per the relevant supervisory guideline), the carrier's electronic signature application, the transmission to the regulator's receiving endpoint, the acknowledgement-receipt handling, the failure-retry policy with bounded retries, the operational alerting when a notification is more than N hours old without being sent, the human-in-the-loop submission-review workflow for very large notifications, and the populate-`sent_at` write path that closes out the lifecycle.

The Track A code emits no false credibility about Track B's work. The `kind` field carries the literal `"jfsa_reserve_threshold"` rather than any pretense at a JFSA-defined message code; the `amount_yen` is the carrier's internal amount in JPY rather than any pretense at the regulator's reporting currency conversion (which doesn't apply here — JPY in, JPY out — but the principle of internal-vs-wire framing holds). A reviewer evaluating Track A's evidentiary weight for a JFSA-readiness conversation reads this ADR and understands that the platform demonstrates detection-and-capture, not transmission-and-acknowledgement.

## 3. The correlation chain — what makes the notification reconstructible end-to-end

The full causal chain for a JFSA-threshold-crossing reserve, with the `correlation_id` propagated by `correlation-id.middleware.ts` (design §3) at every hop:

1. An FNOL arrives at `POST /claims` with `correlation_id = X`. The audit log writes `claim.created` with `correlation_id = X`.
2. A manager assigns the claim at `POST /claims/:id/assign`. The middleware accepts a client-supplied `X-Correlation-Id` header from the workbench, which the workbench sets to the original FNOL's correlation id when continuing a logical workflow. The audit log writes `claim.assigned` with `correlation_id = X`. (If the workbench does *not* pass the header — assignment is often a fresh manager action — a new correlation id is generated and the chain links via `claim_id` instead.)
3. The adjuster proposes a reserve at `POST /claims/:id/reserves` for ¥150M with `correlation_id = Y`. The audit log writes `reserve.proposed` with `correlation_id = Y`.
4. The manager approves at `POST /reserves/:id/approve` with `correlation_id = Z1`. The audit log writes `reserve.approved` with `correlation_id = Z1`. The reserve is in the director-required band; `approval_status` remains `pending`. The JFSA service is *not* invoked — full approval has not landed.
5. The director approves at `POST /reserves/:id/director-approve` with `correlation_id = Z2`. Inside the same transaction:
   - The reserve row's `director_approved_by_id` and `director_approved_at` are populated.
   - Both timestamps are now non-null; `approval_status` flips to `approved`.
   - The audit log writes `reserve.director_approved` and the synthetic `reserve.status_flipped_to_approved`, both with `correlation_id = Z2`.
   - `crossesJfsaThreshold(reserve)` returns true (¥150M > ¥100M).
   - The `NotificationToRegulator` row is inserted with `triggered_at = now()`.
   - The audit log writes `jfsa.notification_queued` with `correlation_id = Z2` and `target_id = <notification row id>`.
6. (Track B) The daily flush job reads pending notifications, serialises them to the JFSA wire format, transmits, receives acknowledgement, and populates `sent_at`.

A reviewer asking "show me the full lineage of why we notified the regulator about claim Q" runs three queries: `audit_log WHERE claim_id = Q ORDER BY ts` for the full causal chain; `reserves WHERE claim_id = Q ORDER BY proposed_at` for the reserve history; `notifications_to_regulator WHERE claim_id = Q` for the notification record. The three views align on `claim_id` and the audit chain aligns on `correlation_id` within each request, with `claim_id` as the cross-request linking key. The brief's design §6 closes with "the full chain of 'agent intake → adjuster note → reserve proposal → approval' is reconstructible" — this ADR extends that chain to include the regulator-notification consequence, with the same correlation properties.

## 4. The audit action vocabulary additions

ADR-002 §4 defines the closed audit action vocabulary. This ADR adds two entries:

- `jfsa.notification_queued` — emitted by the reserves service in the same transaction as the threshold-crossing approval. `target_id` is the `NotificationToRegulator` row id; `claim_id` and `actor` are inherited from the approval request that caused the emit. The `payload_hash` covers `{ kind: "jfsa_reserve_threshold", claim_id, reserve_id, amount_yen }` canonicalised.
- `jfsa.pending_queried` — emitted by the audit controller's `/notifications/jfsa-pending` handler on every read. `target_id` is null (the query returns a list, not a single resource); `actor` is the querying auditor. No `payload_hash` of a meaningful body; the query parameters are part of the request envelope.

A future Track B will add `jfsa.notification_sent` (emitted by the daily flush job when a notification is successfully transmitted and acknowledged) and possibly `jfsa.notification_send_failed` (emitted on a bounded-retry exhaustion). Track A does not emit these.

The vocabulary additions go through the ADR-002 amendment process — a one-line edit to the closed list of action strings, plus this ADR as the rationale. The grep test that ADR-002 §4 references is updated to include the new strings.

## 5. Consequences

### Positive

- **The threshold is captured at the moment of crossing, not at the moment of batch run.** The notification row's `triggered_at` is the truthful timestamp of the carrier's adoption of the threshold-crossing view, regardless of when (or whether) a daily flush job is operational. A reviewer asking "when did we know we needed to notify the regulator?" gets a precise answer from the row, not an answer dependent on batch-job scheduling.
- **The transactional emit prevents observable inconsistency.** No reader can see a `Reserve` row in `approved` state that crossed the threshold without the paired notification row, nor vice versa. The Track B daily flush job inherits this invariant: every row it processes corresponds to a real, approved reserve.
- **Decimal-typed currency.** The threshold constant, the reserve amount, and the comparison are all `Decimal`. No floating-point arithmetic touches the regulator-notification decision. The design §6 invariant is upheld.
- **One file owns the policy.** The threshold constant, the crossing predicate, the emit logic, and the queue-read endpoint helper all live in `reserves-jfsa.service.ts`. A reviewer reads one file and knows the regulator-notification surface end-to-end. A policy change (threshold adjustment, kind vocabulary extension, additional payload field) is a localised edit reviewable in isolation.
- **Separation from the approval tier ADR.** ADR-005 owns the ¥1M / ¥10M approval tiers; this ADR owns the ¥100M notification trigger. The two thresholds do not compose into a third approval tier; the notification is a regulatory consequence of an already-approved reserve, not an additional approval step. The two ADRs cite each other and explicitly note the separation, so a future reviewer cannot conflate them.
- **The Track B boundary is explicit.** The ADR states what is and is not delivered, in terms that a JFSA-readiness conversation can use without overclaiming. The `sent_at` column awaits the Track B writer; the wire format is named as out-of-scope; the operational tooling is enumerated as Track B work.
- **Acceptance criterion #5's curl shape is supportable.** A `GET /notifications/jfsa-pending` with an auditor JWT returns a list of pending notifications with claim and reserve ids; the curl example in the README demonstrates this without requiring any Track B infrastructure to exist.

### Negative / accepted costs

- **Notifications can accumulate indefinitely until Track B ships.** In Track A there is no path to populate `sent_at`, so the pending queue grows monotonically with every threshold-crossing approval. Operationally this is fine for the POC volumes (the seed data produces a small handful of crossings); a long-running Track A deployment would need an operational note that the queue is unbounded until Track B lands. The auditor-only read endpoint at least makes the accumulation visible.
- **The absolute-level reading produces re-notifications on revisions above the threshold.** A reserve at ¥150M revised to ¥160M, both approved, produces two notifications. Some carriers might prefer dedup-on-claim semantics (one notification per claim per lifetime, regardless of subsequent revisions). The absolute-level reading is the more conservative — the regulator sees every adoption event — but the trade-off is a noisier queue. Dedup is a Track B daily-aggregation concern, not a Track A capture-time concern; the queue captures every event and Track B can collapse.
- **The notification carries no carrier-side commentary.** A real submission would often include a free-text note explaining the context of the change (a catastrophe event, a litigation development, a coverage-position revision). Track A's `NotificationToRegulator` schema has no such field. Adding it would require a Track B schema migration; the omission is intentional, because Track A's purpose is detection-and-capture, not submission-content authoring.
- **The actor on the threshold-crossing emit is the approving human, not a synthetic system actor.** This is correct (the approval is what caused the notification), but it does mean that an audit query for `WHERE action = 'jfsa.notification_queued'` returns rows whose `actor_id` is a manager or director, not a `system` user. A reviewer accustomed to attributing system-emitted events to a system identity may find this surprising. The ADR documents the choice; the rationale is that there is no system action without a human action, and attributing the emit to the human keeps the chain truthful.
- **The two-event approval semantics for the director-required band mean the notification fires on the *second* approval, which may be the manager's approval if the director acted first.** A reviewer reading the audit log might see `reserve.director_approved` followed by `reserve.approved` followed by `jfsa.notification_queued`, with the `actor_id` of the notification being the manager (whose approval was the second). This is correct — the manager's approval was what completed the carrier's adoption of the view — but it is non-obvious. The ADR's §2.2 ordering discussion documents the rationale.
- **The `kind` field is single-valued in Track A.** The schema's `kind` column is a string, which is forward-compatible with future notification kinds, but Track A's exclusive emission of `"jfsa_reserve_threshold"` means a `WHERE kind = ?` query is essentially trivial. The cost is the slight over-design of carrying a column that has one value today; the benefit is that Track B can add subrogation-recovery and fraud-determination notifications without a schema change.
- **The endpoint is auditor-only, which means managers cannot see the queue.** A claims-director who is also a manager might reasonably want to see the pending queue for situational awareness. The role-matrix decision is that they cannot; the queue is a regulator-facing artifact and only the audit function should have visibility. A future Track B may add a manager-visible "my chain's pending notifications" view with appropriate masking; Track A keeps the queue strictly auditor-only.

## 6. Track B follow-up

The items deferred to Track B that this ADR explicitly does not address:

- **The daily flush job.** A cron-scheduled background worker that reads `NotificationToRegulator WHERE sent_at IS NULL`, serialises to the JFSA wire format, transmits, awaits acknowledgement, populates `sent_at`, and emits the `jfsa.notification_sent` audit row. The job's failure-handling policy (bounded retries, exponential backoff, alerting on exhaustion) is part of Track B's operational scope.
- **The JFSA wire-format serialiser.** A module that consumes `NotificationToRegulator` rows and produces the regulator-defined record format. The format is specified in JFSA's supervisory guidelines and the carrier's existing legacy submission tooling; Track B reads both and produces a conformant serialiser with a documented format-version field.
- **Electronic signature application.** The carrier's registered representative's electronic signature must be applied to each submitted batch. Track B integrates with the carrier's existing signature service; the signature is itself an audit event (`jfsa.batch_signed`) with the representative as actor.
- **Acknowledgement-receipt handling.** The regulator's receiving system returns an acknowledgement record per submission. Track B captures the acknowledgement, links it back to the originating notifications, and stores the regulator's confirmation id alongside `sent_at`.
- **Same-day notification for very large reserves.** Some supervisory guidelines distinguish between next-business-day notification (the default) and same-day notification for reserves above a higher threshold (often around ¥1B). Track A treats all crossings uniformly; Track B introduces a `priority` column on the notification row and a separate priority-flush job with a tighter cadence.
- **Dedup-on-claim semantics.** A Track B daily-aggregation step that collapses adjacent revisions of the same claim within a single submission window into a single regulator-facing line item. The capture remains per-event; the *submission* deduplicates.
- **Free-text commentary field.** A `notes` column on `NotificationToRegulator` populated at emit time from a contextual hint (catastrophe-event id, litigation reference, coverage-position memo id) and serialised into the regulator submission as the carrier's explanatory note.
- **Manager-visible queue.** A masked, role-scoped view of pending notifications for managers in the proposing adjuster's reporting chain. The masking follows ADR-003's role-and-ownership rules.
- **Notification revocation.** If a reserve is found to have been approved in error and is being formally retracted (a rare but real event), the regulator submission must include a retraction. Track B introduces a `revoked_at` column and a `jfsa.notification_revoked` audit action.
- **Threshold parameterisation by line of business.** The brief's ¥100M is a universal figure; in practice, JFSA supervises lines of business with different reserve adequacy concerns and may apply different thresholds. Track B introduces per-line thresholds and a per-claim lookup at the crossing-check time.
- **A submission-readiness dashboard.** An operational view that surfaces the pending queue's age distribution, the upcoming flush window, the count of high-priority items, and the recent submission history. Built on the existing audit log and notification table.
- **Cross-event aggregation for catastrophe scenarios.** During a typhoon or earthquake, the per-claim notifications can number in the thousands; the regulator's receiving system may prefer an event-aggregated submission. Track B introduces a catastrophe-event grouping that bundles per-claim notifications under an event header.
- **A replay tool for historical notifications.** Given a date range, replay the threshold-crossing logic over the audit log and assert that every approval-and-crossing pair produced a notification row. This is a forensic tool for confirming the integrity of the capture path; deferred until the notification table accumulates enough history to make replay valuable.
- **Integration with the IFRS17 export.** The IFRS17 quarterly disclosure includes the count and aggregate of JFSA-notified reserve changes during the period. Track B's IFRS17 export consumes the notification table; Track A's `reserves-export.service.ts` does not.

## 7. References

- `brief.md` — Reserves Management specification (the ¥100M threshold, the "captured as an event; not actually sent in POC" framing), the explicit Track A-vs-Track B boundary for compliance reporting.
- `design.md` §1 — `NotificationToRegulator` model (`kind`, `claim_id`, `reserve_id`, `amount_yen`, `triggered_at`, `sent_at`).
- `design.md` §2 — API contract for `GET /notifications/jfsa-pending`.
- `design.md` §3 — `reserves/reserves-jfsa.service.ts` as the canonical location, `reserves/reserves.service.ts` as the call site.
- `design.md` §6 — "Regulatory thresholds encoded as policy, not magic numbers — every JFSA / IFRS17 / APPI rule is a named constant in a single config module" and "Decimal-typed currency end-to-end — no `number` for yen anywhere in the stack" — the design's explicit framings of this ADR's subject.
- ADR-002 — audit immutability (the two new action strings `jfsa.notification_queued` and `jfsa.pending_queried`, the closed action vocabulary, the `correlation_id` chain).
- ADR-003 — role masking by APPI tier (the auditor-only visibility of the pending-notifications endpoint, the audit-the-auditor pattern for queue reads).
- ADR-004 — claim status FSM (the FSM-side consequence of full reserve approval is `awaiting_reserve_approval → settlement_offered`, which happens in the same controller round-trip as the JFSA emit when the reserve is the one being approved; the correlation id propagates through both).
- ADR-005 — reserve approval tiers (the JFSA threshold is *orthogonal* to the approval tiers; the notification fires on full approval, which for the director-required band is the second-of-two timestamps landing).
- JFSA Supervisory Guidelines for Insurance Companies (保険会社向けの総合的な監督指針) — the regulatory source of the threshold-notification expectation; the specific wire format and cadence requirements are deferred to Track B.
- Insurance Business Act (保険業法) — the statutory basis for JFSA's supervisory authority and the carrier's notification obligations.
- IFRS17 — the reserve walk-forward disclosure context in which the JFSA notification volume is an aggregate disclosure data point.