# ADR-002 — Audit log immutability: append-only by code convention, prod-tightened in Track B

- **Status:** Accepted (Track A)
- **Date:** 2024-09
- **Deciders:** Claims platform engineering; reviewed against the locked `brief.md` non-functional requirements and `design.md` §1 (`AuditEvent` model) + §3 (module structure).
- **Related ADRs:** ADR-001 (PII encryption — the audit log records plaintext-access events without holding plaintext itself), ADR-003 (role masking — auditor reads of the audit log return unmasked data because auditor is the role the masking interceptor allows through), ADR-004 (claim status FSM — every transition emits an audit row), ADR-005 (reserve approval tiers — every approval/rejection emits an audit row), ADR-006 (JFSA notification — the threshold-crossing event is reconstructible from the audit log via `correlation_id`).
- **Related code:** `src/common/audit.interceptor.ts`, `src/common/audit.decorator.ts`, `src/audit/audit.service.ts`, `src/audit/audit.controller.ts`, `prisma/schema.prisma` (`AuditEvent` model).

---

## 1. Context

A Japanese P&C insurance carrier is regulated by the JFSA, audited by external accounting firms under IFRS17, and subject to APPI disclosure-right obligations (Article 28). All three regulators converge on the same expectation: the carrier must be able to reconstruct, after the fact, *who did what to which claim, when, and on what authority*. This is not a feature; it is the precondition for being allowed to operate.

The `brief.md` non-functional requirements are explicit:

> **Audit immutability** — the `audit_log` table has no UPDATE or DELETE pathway in code; documented in an ADR and reinforced by Postgres row-level security in a follow-up (Track B).

And from the acceptance criteria:

> **Audit log accumulates** entries that match every claim/note/evidence/reserve write 1-to-1.

Two design pressures fall out of this:

1. **Completeness.** Every write that touches a claim — FNOL create, note append, evidence attach, witness statement, status transition, assignment, reserve proposal, reserve approval, reserve rejection, director approval, JFSA notification, data-subject export, anonymisation — must produce exactly one `AuditEvent` row. Missing rows are worse than missing features; they are evidence of process failure.
2. **Immutability.** Once written, an `AuditEvent` row must not be modifiable or deletable through any path the application exposes. The audit log is the carrier's defence against insider tampering — including by engineers with database access — and its evidentiary value collapses the moment a single row can be retroactively rewritten.

A tertiary pressure, peculiar to Track A: we are a POC. We do not have a deployed Postgres cluster on which to author row-level security policies or `BEFORE UPDATE` triggers, and adding migration tooling for those policies inside Track A would substantially expand the scope. The pragmatic question is therefore: *how do we deliver auditable immutability now, in code, while leaving a clean and named hook for the production-grade database controls Track B will add?*

## 2. Decision

The `AuditEvent` table is **append-only by code convention in Track A**, enforced by four mutually reinforcing mechanisms, with database-level enforcement (Postgres row-level security + a trigger that raises on `UPDATE` / `DELETE`) deferred to Track B.

The four mechanisms:

### 2.1 A single writer — the `AuditInterceptor`

The `AuditEvent` table has exactly one writer in the codebase: `src/common/audit.interceptor.ts`. Domain services (`ClaimsService`, `ReservesService`, etc.) **do not** call `prisma.auditEvent.create(...)` themselves. Instead, they annotate their controller methods with `@Audit({ action: 'claim.created' })` (or the relevant action string), and the global `AuditInterceptor` writes the row on successful response.

The interceptor's responsibilities:

- Compute `payload_hash` as sha-256 over the canonicalised request body (keys sorted, undefined elided). This binds the audit row to the exact input that produced the side-effect.
- Extract `actor_id` and `actor_role` from the authenticated `request.user`.
- Extract `claim_id` from the route param when present; fall back to the response body's `claim_id` for routes like `POST /reserves/:id/approve` where the claim is inferred via the reserve.
- Extract `request_id` and `correlation_id` from the request (stamped by the middlewares — see ADR-006 and `ARCHITECTURE.md` §4).
- `INSERT` the row. Never `UPDATE`. Never `DELETE`.

Because the interceptor is the only writer, there is exactly one code path to review for correctness. A reviewer grepping for `auditEvent` in `src/` should find exactly two non-test occurrences: the interceptor's `create` call and the audit service's read queries.

### 2.2 No update or delete method on `AuditService`

`src/audit/audit.service.ts` exposes read methods only:

- `list(filters)` — paginated query by `from`, `to`, `actor_id`, `claim_id`, `action`.
- `findOne(id)` — for deep-linking from a workbench timeline.

There is no `update`, no `delete`, no `redact`, no `correct`. If an audit row is wrong (e.g. a misclassified action string), the correction is itself a new audit row with an explicit `action='audit.correction'` referencing the original `target_id`. The original is preserved verbatim.

The write surface (`auditEvent.create`) is not re-exported from the service module; the interceptor accesses Prisma directly via the injected `PrismaService`. This means a controller author who wants to write an audit row cannot import a convenient helper from the audit module — there is no such helper. The only way to produce an audit row is to apply the `@Audit` decorator, which guarantees the interceptor's envelope shape.

### 2.3 Lint and test enforcement

Two mechanical checks run in CI to keep the convention from drifting:

- **A grep test.** A Jest test (`test/audit-immutability.spec.ts`, called out by `claims-workbench.e2e.spec.ts`'s setup) scans `src/` for occurrences of `auditEvent.update`, `auditEvent.delete`, `auditEvent.upsert`, `auditEvent.deleteMany`, `auditEvent.updateMany`. The test fails if any occurrence exists outside the interceptor's allowlisted file. This is a crude check, but crude is the right register for an invariant this load-bearing.
- **A schema test.** The same suite asserts that the Prisma client's generated `AuditEventDelegate` is never imported from a service file other than the interceptor and the audit service's read methods. Combined with the grep, this prevents an alternative writer being introduced behind a wrapper.

The checks are intentionally simple and reviewable. A future engineer who wants to bypass them must do so visibly — by editing the lint/test config — which itself shows up in code review.

### 2.4 Content-binding via `payload_hash`

Even granted that no code path mutates a row, a reviewer might ask: *what stops someone from `UPDATE`-ing the table directly via psql?* In Track A, nothing technical — but the `payload_hash` column means tampering is *detectable*. An auditor replaying the request log against the stored `payload_hash` values can identify any row whose hash no longer matches the recorded request body. Together with the `request_id` / `correlation_id` chain, this provides forensic evidence of tampering even when prevention is not yet airtight.

The hash uses sha-256 over a canonical JSON encoding: keys sorted lexicographically, undefined values elided, no whitespace. The canonicalisation function lives in `src/common/audit.interceptor.ts` and is used both at write time (to produce the stored hash) and at any future verification time.

## 3. The audit envelope — what every row contains

From `design.md` §1, every `AuditEvent` row carries:

| Column | Source | Purpose |
|---|---|---|
| `id` | `cuid()` | Primary key |
| `actor_id` | `request.user.id` | Who acted |
| `actor_role` | `request.user.role` | What role they acted in |
| `action` | `@Audit({ action })` metadata | What they did (e.g. `claim.created`, `reserve.approved`, `evidence.added`, `claim.status.transitioned`, `appi.data_subject_export`) |
| `claim_id` | route param / response body | Which claim the action concerned (nullable for cross-claim actions like `auth.login`) |
| `target_id` | response body | The sub-resource id when applicable — e.g. the `Reserve.id` for a `reserve.approved` action |
| `payload_hash` | sha-256 of canonical request body | Content-binding to the exact input |
| `request_id` | `RequestIdMiddleware` | Per-request trace id |
| `correlation_id` | `CorrelationIdMiddleware` | Cross-request / cross-service trace id |
| `ts` | `@default(now())` | Server-side timestamp (not client-controlled) |

The `correlation_id` is the property that makes the audit log usable for end-to-end investigation. The same correlation id propagates from the agent's FNOL intake through every downstream action on that claim — adjuster note, evidence attach, reserve proposal, manager approval, director approval, JFSA notification — so a single `WHERE correlation_id = $1 ORDER BY ts` query reconstructs the entire causal chain. This is called out in `ARCHITECTURE.md` §8 as "audit-as-trace".

## 4. Action vocabulary — the closed set

The `action` column is a free-text string at the schema level, but the codebase treats it as a closed vocabulary. The canonical list lives as named constants on the audit decorator's module so that a typo produces a TypeScript error rather than a silently misclassified audit row. The Track A vocabulary:

- `claim.created` — any of the four FNOL channels.
- `claim.assigned` — manager assigns or reassigns an adjuster.
- `claim.note.added` — append to `ClaimNote`.
- `claim.evidence.added` — append to `Evidence`.
- `claim.witness_statement.added` — append to `WitnessStatement`.
- `claim.status.transitioned` — FSM transition (ADR-004); payload includes `from` and `to`.
- `reserve.proposed` — new `Reserve` row created.
- `reserve.approved` — manager approval (≤ ¥10M).
- `reserve.director_approved` — claims-director approval (> ¥10M).
- `reserve.rejected` — manager rejection with `reason_for_rejection`.
- `regulator.jfsa_threshold_crossed` — `NotificationToRegulator` written.
- `appi.data_subject_export` — Article 28 disclosure read.
- `appi.personal_data_anonymised` — anonymisation write (Track B-gated).
- `auth.login.succeeded` / `auth.login.failed` — authentication events.

Adding a new action requires (a) a named constant, (b) the `@Audit` decorator applied to the controller method, and (c) a test that asserts the row appears with the expected envelope.

## 5. Read surface — auditor access

The audit log is read via `GET /audit?from=&to=&actor=&claim_id=&action=`, gated to the `auditor` role by `RolesGuard`. Auditors see unmasked rows — including `actor_id` and `claim_id` — because the masking interceptor (ADR-003) treats `auditor` as the role authorised to see the full picture across all claims. This is the deliberate asymmetry: auditors cannot write, but they can read everything.

Managers and adjusters cannot read the audit log directly. The workbench surfaces a claim-scoped timeline (`GET /claims/:id` includes a recent-actions slice for the assigned adjuster) but that slice is filtered to non-sensitive action types and never exposes the cross-claim view.

The `auditor` read path itself emits no audit row — auditing the auditors is a Track B concern (it requires a secondary audit channel, otherwise the recursion is meaningless). The audit interceptor's allowlist of `@Audit`-decorated routes deliberately excludes `GET /audit`.

## 6. Consequences

### Positive

- **Acceptance criterion #8 is mechanically met.** Every claim/note/evidence/reserve write produces exactly one audit row, because the `@Audit` decorator is the only path through the system that produces such writes.
- **A single file (`audit.interceptor.ts`) owns the audit envelope.** Reviewers can read 100 lines and know the entire write semantics.
- **The `correlation_id` chain makes "who did what" reconstructible from a single SQL query.** This is the operational property a real incident response needs.
- **`payload_hash` provides tamper-detection** even before the Track B database-level enforcement lands. An attacker who modifies a row in psql leaves a hash mismatch that any replay tool will surface.
- **The closed action vocabulary** prevents the slow drift toward free-text action strings that makes long-lived audit logs unsearchable.
- **No coupling between domain services and the audit module.** Domain services remain focused on domain logic; the audit envelope is an aspect, not a concern of `ClaimsService`.

### Negative / accepted costs

- **Database-level enforcement is deferred.** A sufficiently privileged psql user can today `DELETE FROM "AuditEvent"`. This is documented (the brief calls it out) and tracked for Track B. The code-level convention is the right register for a POC; production demands the row-level security policy described in §7.
- **Auditor-side actions are not themselves audited.** A malicious auditor reading sensitive data leaves no trace in the audit log. Track B introduces a secondary audit channel (a separate table with a separate writer) to cover this gap; for Track A, the access pattern is gated by role and the assumption is that auditors are trusted by construction.
- **`payload_hash` covers the request body but not the response.** If a service computes a value based on database state (e.g. a generated id) and the audit row records the request hash, an attacker who modifies database state between write and audit could in principle desynchronise the two. In practice the interceptor writes within the same request lifecycle and the window is millisecond-scale; Track B's RLS closes this window entirely by making the audit write atomic with the domain write.
- **The grep test is crude.** It catches `auditEvent.update` but not, e.g., a raw SQL `UPDATE` via `prisma.$executeRaw`. The schema test (no `AuditEventDelegate` import outside the allowlisted files) provides the second line of defence, and Track B's database-level enforcement is the third.

## 7. Track B follow-up

The items deferred to Track B that this ADR explicitly does not address:

- **Postgres row-level security.** A `CREATE POLICY` statement on the `AuditEvent` table that grants `INSERT` to the application role and grants `SELECT` only to the auditor read role and the application role. No `UPDATE` or `DELETE` grant exists for any role. Combined with `REVOKE ALL ON "AuditEvent" FROM PUBLIC`, this makes the table append-only at the database boundary, not merely at the application boundary.
- **A `BEFORE UPDATE OR DELETE` trigger that raises an exception.** Belt-and-braces alongside RLS: even a superuser who bypasses RLS triggers a `RAISE EXCEPTION 'AuditEvent rows are immutable'` and the operation aborts. This is the property that lets the CISO sign off on the control.
- **A secondary audit channel for auditor reads.** A separate `AuditorAccessLog` table written by a separate interceptor on `GET /audit` and `GET /claims/:id/data-subject-export`, with its own append-only enforcement. Auditing the auditors is the recursion-stopping move that completes the trust model.
- **Cryptographic chain (hash-linked log).** Each `AuditEvent` row stores the `payload_hash` of the previous row, forming a tamper-evident chain. Track B's RLS makes this unnecessary for tamper-prevention but it remains useful for tamper-evidence in the event of a backup compromise. Deferred until a concrete regulatory ask demands it.
- **External archival.** Daily export of the previous day's audit rows to an append-only S3 bucket with object lock, providing an off-system copy that survives even a full database compromise. Tracked alongside the JFSA daily-batch work (ADR-006).
- **Auditor-side query review.** A workflow that flags unusually broad auditor queries (e.g. `WHERE claim_id IS NOT NULL` returning > N rows) for secondary review. A behavioural control rather than a technical one; Track B alongside the SIU module.

## 8. References

- `brief.md` — non-functional requirements ("Audit immutability"), acceptance criterion #8.
- `design.md` §1 — `AuditEvent` model.
- `design.md` §3 — `common/audit.interceptor.ts`, `common/audit.decorator.ts`, `audit/audit.service.ts`.
- ADR-001 — PII encryption (the audit log records that decryption occurred via the `appi.data_subject_export` action).
- ADR-003 — role masking by APPI tier (auditor is the role authorised to bypass masking on audit reads).
- ADR-004 — claim status FSM (every transition emits `claim.status.transitioned`).
- ADR-005 — reserve approval tiers (every tier event emits a distinct action).
- ADR-006 — JFSA notification (the threshold-crossing event is correlated via `correlation_id`).
- 個人情報の保護に関する法律 (APPI) — Article 28 disclosure right; the audit log records every Article 28 read.
- JFSA Supervisory Guidelines for Insurance Companies — expectations around internal control documentation and the evidentiary use of audit trails.