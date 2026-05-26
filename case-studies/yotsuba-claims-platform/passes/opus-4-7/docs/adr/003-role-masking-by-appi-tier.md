# ADR-003 — Role masking by APPI tier: a single response-layer interceptor as the only path that decides who sees what

- **Status:** Accepted (Track A)
- **Date:** 2024-09
- **Deciders:** Claims platform engineering; reviewed against the locked `brief.md` PII inventory + role matrix and `design.md` §1 (`*_ct` columns) + §2 (API contract) + §3 (`common/pii-mask.util.ts`, `common/audit.interceptor.ts`).
- **Related ADRs:** ADR-001 (PII encryption — the at-rest complement to this ADR), ADR-002 (audit immutability — auditor is the role that bypasses masking on audit reads), ADR-004 (claim status FSM — status is `public` tier and never masked), ADR-005 (reserve approval tiers — proposer / approver identities are masked outside the manager chain).
- **Related code:** `src/common/pii-mask.util.ts`, `src/common/audit.interceptor.ts` (sibling interceptor — same module boundary), `src/claims/claims.controller.ts` (the controllers whose responses pass through the masking interceptor), `prisma/schema.prisma` (`*_ct` columns and cleartext PII columns).

---

## 1. Context

The same claim row must yield five different response shapes depending on who is reading it. From the `brief.md` role matrix:

- An **agent** sees only the claims they themselves intook, and only for the first 24 hours after submission. They see the names and contact details they entered, because they entered them — there is no new disclosure.
- An **adjuster** sees full cleartext PII *only on the claim assigned to them*. On every other claim in the system — including claims of peers in the same office — they see prefecture-level location, masked phone, masked email, and a redacted policy number suffix. This is the realistic insider-threat boundary: an adjuster who can read every claim's reporter phone number is one social-engineering call away from a fraud incident.
- A **manager** sees full cleartext PII on every claim assigned to one of their direct reports (the `reports_to_id` chain). On other managers' claims they see the same masked view an adjuster sees on a non-assigned claim.
- An **auditor** sees unmasked standard PII across all claims (their function depends on it), but does *not* see decrypted special-care PII through ordinary read paths — special-care PII is only available via `GET /claims/:id/data-subject-export`, which is itself audited as an Article 28 disclosure event (ADR-002).
- An **`siu_referrer`** sees only claims that have been flagged for fraud investigation, and on those claims sees the same masked view as a non-assigned adjuster. The full Article 17 special-care PII never reaches them through any Track A path; the SIU module that justifies broader access is Track B.

Two properties matter for the design:

1. **The decision is per-field, not per-record.** A response object for `GET /claims/:id` carries roughly twenty fields, and each one has its own answer to "who sees this?" `claim.id`, `claim.status`, `claim.severity_initial`, `claim.loss_date` — everyone authorised to read the claim at all sees these. `claim.reporter_name` — assigned adjuster and the manager chain see cleartext; others see a redacted form. `claim.insured_government_id_ct` — nobody sees it through this path, ever. Mixing field-level decisions inside ad-hoc service code is how PII leaks happen.
2. **The decision must be evaluable from request context alone.** The masking function does not consult the database; it consults `(record, caller, ownership)` where `ownership` is a small derived structure ("is this caller the assigned adjuster?", "is the assigned adjuster a direct report of this caller?", "is this claim flagged for SIU?") prepared once by the service layer before the response is returned. This keeps the interceptor pure and unit-testable without Prisma fixtures.

The `brief.md` PII inventory gives the tier assignment; this ADR records the *response-layer machinery* that turns that inventory into actual redaction at the API boundary, and the conventions that keep the machinery from drifting as new fields are added.

## 2. Decision

A single response-layer interceptor — `MaskByAppiInterceptor`, wired globally in `app.module.ts` — is the **only path** that decides which fields appear in which form in HTTP responses. Services return full records; controllers return whatever the services give them; the interceptor walks the response object on its way out and applies the masking function declared in `src/common/pii-mask.util.ts`.

The design has four parts.

### 2.1 A typed tier map — the single source of truth

`src/common/pii-mask.util.ts` exports a typed map keyed by `(entity, field)` and valued by an APPI tier. The tier vocabulary is closed:

- **`public`** — claim id, status, severity, timestamps, incident_type, channel, prefecture (when the caller is permitted to see the claim at all). Always returned verbatim.
- **`standard`** — reporter name, reporter phone (cleartext column), reporter email (cleartext column), full postal address, policy number, assigned adjuster display name. Cleartext at rest (ADR-001); response-layer masked based on caller role + ownership.
- **`special_care`** — the `*_ct` columns: `reporter_phone_ct`, `reporter_email_ct`, `insured_government_id_ct`, `bank_account_for_payout_ct`, `injury_details_ct`, `witness_phone_ct`. Encrypted at rest (ADR-001); never decrypted on the ordinary read path. The interceptor strips them from any response that is not the data-subject-export route.

Note the deliberate split between `reporter_phone` (standard, masked at the response layer) and `reporter_phone_ct` (special-care, never returned through ordinary reads). The brief's PII inventory lists `reporter_phone` as standard PII, but the schema stores it in a `_ct` column because the operational team chose to encrypt-at-rest by default for any field that could become a social-engineering vector. The tier map records this nuance: `reporter_phone` (the *logical* field, decrypted into the response object for authorised callers) is `standard`; `reporter_phone_ct` (the raw ciphertext column) is `special_care` and is never serialised. The service layer's responsibility is to decrypt `reporter_phone_ct` into a `reporter_phone` property on the response object *only when the caller is authorised to see cleartext at all*; the interceptor then applies the final standard-tier masking decision based on ownership.

The map is exhaustive. Adding a new field requires adding an entry, and a unit-test in `test/claims-workbench.e2e.spec.ts` asserts that every property name appearing in any claim response object has a corresponding entry — an unmapped field is a test failure, not a silent default-allow.

### 2.2 A pure masking function — `maskByAppiTier`

The interceptor delegates the actual decision to `maskByAppiTier(record, caller, ownership)`, a pure function exported from `src/common/pii-mask.util.ts`. The function:

- Takes a record (a plain JS object as it comes off the service), the authenticated caller (`{ id, role, is_claims_director, reports_to_id }`), and a small ownership descriptor (`{ is_assigned_adjuster, is_in_manager_chain, is_flagged_for_siu, is_own_intake_within_24h }`).
- Walks the record's keys. For each key, consults the tier map. If the field is `public`, copies it verbatim. If `standard`, applies the standard-tier rule for the caller's role. If `special_care`, omits the field unless the route-level metadata explicitly opts in (only `GET /claims/:id/data-subject-export` opts in, and only for `auditor` and `manager` roles).
- For `standard` tier, the rules are:
  - `auditor` — always cleartext (their function requires it; their reads are themselves audited).
  - `adjuster` — cleartext when `is_assigned_adjuster=true`; redacted otherwise.
  - `manager` — cleartext when `is_in_manager_chain=true`; redacted otherwise.
  - `agent` — cleartext when `is_own_intake_within_24h=true`; otherwise the agent should not have received the record at all (the service layer's `findOne` would have 404'd), and reaching this branch with `agent` is a defensive 500.
  - `siu_referrer` — always redacted; their access is scoped to the existence of the claim, not its contents.
- Recurses into nested arrays and objects (`notes[]`, `evidence[]`, `witness_statements[]`, `reserves[]`) applying the same per-field rule with the same `ownership` descriptor.

The function is synchronous, has no external dependencies, and is unit-tested with a matrix of `role × ownership × field` combinations. A reviewer can read it in five minutes and know the entire response-layer disclosure policy.

### 2.3 Redaction shapes — what "masked" actually looks like on the wire

Masking is not deletion. A client that expects a `reporter_phone` field must still receive *something* of that shape, otherwise the workbench UI's column rendering breaks and the absence of the field accidentally signals "this claim has no reporter phone" — which is itself information leakage. The redaction shapes:

- `reporter_name` → `"***"` (three asterisks; presence preserved, content hidden).
- `reporter_phone` → `"***-****-NNNN"` where `NNNN` is the last four digits. The last-four pattern matches how Japanese carriers display masked phone numbers in agent UIs and is sufficient for an adjuster to confirm "is this the same caller as before?" without exposing the full number.
- `reporter_email` → `"f***@d***.jp"` (first letter of local part, first letter of domain, top-level domain preserved). Same rationale as phone.
- `policy_number` → last four characters with `***` prefix.
- `loss_location_postal_code`, `loss_location_detail` → omitted; `loss_location_prefecture` is `public` tier and remains.
- Special-care `*_ct` fields → omitted entirely from the response object. They are never serialised, not even as null, on the ordinary read path. Their absence is unambiguous because the data-subject-export route is the only place they ever appear.

The redaction shapes are named constants in `pii-mask.util.ts` so that a change to the masking format is a one-line edit reviewable in isolation.

### 2.4 Route-level opt-in for special-care disclosure

The `GET /claims/:id/data-subject-export` route is the single exception that returns decrypted special-care PII. The route's controller method is annotated with `@DisclosesSpecialCarePii()` — a decorator from `pii-mask.util.ts` that the interceptor checks before applying the default "strip all special_care fields" rule. The decorator is applied to exactly one route in Track A. The grep test (`test/claims-workbench.e2e.spec.ts`'s setup) asserts that the decorator appears at exactly one call site; an attempted second use is a test failure that requires explicit ADR amendment.

The decorator's presence is itself audited: the route is also annotated with `@Audit({ action: 'appi.data_subject_export' })` (ADR-002), so every Article 28 disclosure produces an audit row. The two decorators are paired by convention and the grep test cross-checks that `@DisclosesSpecialCarePii` and `@Audit({ action: 'appi.data_subject_export' })` co-occur.

## 3. The interceptor's place in the request lifecycle

From `ARCHITECTURE.md` §4, the response-side ordering is:

1. Controller returns the service's full record.
2. `AuditInterceptor` writes the audit row (the audit envelope sees the full record, because the audit log records *what actually happened*, not the redacted view).
3. `MaskByAppiInterceptor` walks the response object and applies `maskByAppiTier`.
4. `GlobalExceptionFilter` is the catch-all (only relevant if the interceptor itself throws).

The ordering matters. The audit row must be written against the unredacted record because an auditor investigating an incident needs to know what the service produced, not what the requester saw. The masking happens *after* the audit write, on the egress path only. A reviewer who wants to know "did this caller see this field?" reads the masking function; a reviewer who wants to know "what did the service produce?" reads the audit log.

The interceptor is wired globally rather than per-controller because the default must be safe. A new controller added without thinking about masking still has its responses walked by the interceptor; an unmapped field surfaces as a test failure (§2.1) rather than as a silent leak.

## 4. Ownership computation — how the service layer prepares the descriptor

The interceptor cannot run a database query. Ownership is therefore computed by the service layer before the response is returned, and attached to the response object via a non-enumerable property the interceptor knows to read and then strip. The properties on the descriptor:

- `is_assigned_adjuster` — `caller.role === 'adjuster' && claim.assigned_adjuster_id === caller.id`.
- `is_in_manager_chain` — `caller.role === 'manager' && (claim.assigned_adjuster.reports_to_id === caller.id || claim.assigned_adjuster.reports_to.reports_to_id === caller.id)`. The two-level walk covers the realistic carrier hierarchy (adjuster → team lead → claims manager); deeper chains are Track B.
- `is_flagged_for_siu` — `caller.role === 'siu_referrer' && claim.siu_flagged === true`. The flag is a Track B feature; in Track A the property is always `false` for non-SIU callers and the field on the claim is `false` by default.
- `is_own_intake_within_24h` — `caller.role === 'agent' && claim.created_by_agent_id === caller.id && (now - claim.created_at) < 24h`.

The descriptor is computed exactly once per request, by the service method that produces the response. Helper functions in `claims.service.ts` (`computeOwnership(claim, caller)`) encapsulate the logic so the same rules apply to `GET /claims/:id`, `GET /claims` (list), and the nested ownership decisions inside `notes[]` / `evidence[]` / `reserves[]`.

For list endpoints, the service computes ownership per claim and the interceptor applies masking per element. This is O(n) in the list size, which is acceptable for the Track A volumes (a typical adjuster queue is < 100 claims); a future optimisation that batches the ownership computation is tracked in §7.

## 5. The five-by-three matrix — what each role sees, by tier

The canonical matrix that the masking function implements. Rows are caller roles; columns are field tiers. "Conditional" cells depend on ownership and are resolved by the per-tier rules in §2.2.

| Role × Tier | `public` | `standard` | `special_care` |
|---|---|---|---|
| `agent` | cleartext | cleartext on own intake within 24h; otherwise the claim is unreachable | omitted |
| `adjuster` | cleartext | cleartext when assigned; redacted otherwise | omitted |
| `manager` | cleartext | cleartext when in manager chain; redacted otherwise | omitted on ordinary reads; cleartext only via `@DisclosesSpecialCarePii` route |
| `auditor` | cleartext | cleartext always | omitted on ordinary reads; cleartext only via `@DisclosesSpecialCarePii` route |
| `siu_referrer` | cleartext (flagged claims only) | redacted always | omitted |

The asymmetry between `auditor` and `manager` on `special_care` is deliberate: both can invoke the data-subject-export route, but only the auditor sees the full picture across all claims; the manager's view is bounded by the manager-chain ownership check, so a manager invoking the route on a claim outside their chain receives a 403 before the interceptor ever runs.

## 6. Consequences

### Positive

- **Acceptance criterion #7 is mechanically met.** `GET /claims/:id` with an adjuster JWT returns `reporter_phone` cleartext only when the adjuster is the assigned one; in every other case the masking function applies the standard-tier redaction shape. The test in `test/claims-workbench.e2e.spec.ts` enumerates the role × ownership matrix.
- **A single file (`pii-mask.util.ts`) owns the disclosure policy.** Reviewers read one ~200-line file and know the entire response-layer surface. Adding a new sensitive field is one entry in the tier map, one redaction-shape constant if a new shape is needed, and one row in the test matrix.
- **Default-deny by construction.** An unmapped field is a test failure; the interceptor cannot accidentally pass through a new sensitive field that was added to the schema without thought. This is the property that makes the convention survive long-lived development.
- **Separation from the audit log.** The audit log records the unredacted truth (ADR-002); the masking interceptor controls only egress. A reviewer investigating an incident has both views — what the service produced, and what the requester saw — without either being polluted by the other.
- **Symmetry with the encryption ADR.** ADR-001 controls what is stored encrypted; ADR-003 controls what is returned masked. Together they cover the two surfaces APPI cares about (at rest and on the wire) with one mechanical convention each (`_ct` suffix for storage, tier-map entry for response).
- **Workbench UI shape is preserved.** Masking preserves field presence and approximate shape (last-four digits, asterisk redactions), so a column rendering "reporter phone" still has a value to display when the caller is not authorised. The UI does not need its own role-aware rendering logic.

### Negative / accepted costs

- **The interceptor walks every response object on every request.** For Track A volumes this is negligible; for high-RPS list endpoints, the per-element ownership computation is the limiting factor and is tracked for Track B optimisation (§7).
- **The ownership descriptor must be computed by the service.** A controller author who returns a record directly from Prisma without routing through the service's ownership helper produces a response with no descriptor attached, and the interceptor falls back to the most restrictive view. This is the safe failure mode, but it can be confusing during development; the test suite catches it because the response shape changes.
- **The two-level manager chain is hardcoded.** A carrier with a four-level claims hierarchy needs to extend `computeOwnership`. This is intentional: a configurable depth would be over-engineering for Track A, and the realistic Japanese P&C carrier structure rarely exceeds three levels.
- **Last-four-digits phone masking still leaks information.** Two different reporters with the same last four digits become distinguishable to an adjuster who sees both masked records. The alternative (full redaction) breaks the legitimate use case of "is this the same caller as on the previous claim?". The trade-off is consistent with how Japanese carriers' existing agent UIs render masked phone numbers; it is a deliberate accepted leak, not an oversight.
- **The grep-test enforcement on `@DisclosesSpecialCarePii` is crude.** A future engineer who wants to apply it to a second route must edit the test config, which is reviewable, but the convention relies on social enforcement at the boundary. Track B's ABAC framework (§7) replaces the decorator with a policy DSL that does not rely on grep.

## 7. Track B follow-up

The items deferred to Track B that this ADR explicitly does not address:

- **Attribute-based access control (ABAC) as a policy DSL.** The tier map plus the ownership descriptor is effectively a hand-rolled ABAC engine. Track B replaces it with a declarative policy file (Cedar, OPA, or a domain-specific DSL) that an external auditor can review without reading TypeScript. The masking function becomes a policy evaluator.
- **Field-level access logging.** Today the audit log records the action (`appi.data_subject_export`) but not which specific fields were materialised. Track B adds per-field access counters so that a Article 28 disclosure can be answered with "these specific fields were read on these dates by these actors".
- **Configurable manager-chain depth.** Replace the hardcoded two-level walk with a recursive query bounded by a configured maximum depth, plus a unit test that exercises the boundary.
- **Batched ownership computation for list endpoints.** Today the service computes ownership per element; for a queue of 1000+ claims the per-element database joins become the limiting factor. Track B introduces a batched ownership query that loads the relevant `reports_to_id` chain once per request and resolves ownership in memory.
- **SIU role expansion.** The `siu_referrer` role currently sees only the existence of flagged claims. Track B's SIU module justifies broader access — including decrypted special-care PII for fraud investigation — and that access requires its own audited disclosure route paralleling `data-subject-export`.
- **Per-field redaction format configuration.** Some downstream consumers (e.g. a reinsurer reviewing aggregated claim data) want a different redaction shape (hash-based pseudonym rather than asterisks). Track B parameterises the redaction shape per consumer; Track A's single shape is sufficient for the workbench.
- **Negative testing via property-based fuzzing.** The current matrix test enumerates known role × field combinations. Track B adds property-based tests that generate random claim shapes and assert the masking function never emits a value typed as `special_care` outside the `@DisclosesSpecialCarePii` route, regardless of input.
- **Postgres column-level grants as defence in depth.** Even with response-layer masking, restricting which DB roles can `SELECT` the cleartext PII columns adds protection against compromised API hosts. Tracked alongside the RLS work in ADR-002 §7 and the column-level grants in ADR-001 §7.

## 8. References

- `brief.md` — PII inventory (the tier assignments), role matrix (the five-by-three view), acceptance criterion #7 (the assigned-adjuster masking test).
- `design.md` §1 — `*_ct` columns, cleartext PII columns, `assigned_adjuster_id` relation.
- `design.md` §2 — the API contract, including the `data-subject-export` route as the single special-care disclosure surface.
- `design.md` §3 — `common/pii-mask.util.ts` as the canonical location, `common/audit.interceptor.ts` as the sibling interceptor.
- `ARCHITECTURE.md` §4 — the request lifecycle, including the response-side interceptor ordering.
- `ARCHITECTURE.md` §6.1 — APPI tiering as one of the four cross-cutting policies.
- ADR-001 — PII encryption (the at-rest complement: what is stored encrypted vs cleartext).
- ADR-002 — audit immutability (the auditor role's asymmetric access; the `@Audit` decorator paired with `@DisclosesSpecialCarePii`).
- ADR-004 — claim status FSM (status is `public` tier; transitions are never masked).
- ADR-005 — reserve approval tiers (proposer / approver identities follow the same manager-chain ownership rule).
- 個人情報の保護に関する法律 (APPI) — Article 17 (special-care personal information) and Article 28 (disclosure right; the single route that opts into special-care disclosure).
- JFSA Supervisory Guidelines for Insurance Companies — expectations around role-based access to claim-holder personal information.