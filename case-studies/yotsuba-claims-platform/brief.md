# Project Brief — Yotsuba Insurance Holdings · Claims Processing Platform

> **Note on naming.** *Yotsuba Insurance Holdings* is a fictional placeholder. The domain shape, regulatory hooks, and operational patterns reflect what a real Japanese P&C insurance conglomerate would recognise; the fictional naming protects an in-flight commercial conversation and is replaced 1-for-1 when permission is granted. The study's conclusions hold regardless of name.

## One-line summary
A backend-plus-workbench platform that handles the first-notice-of-loss-to-settlement lifecycle for **personal & commercial P&C claims** at a Japanese insurance carrier, with the regulatory hooks, audit immutability, and reinsurance signaling a JFSA-regulated insurer needs.

## Business context

The target customer is a top-tier Japanese P&C insurance carrier with ~¥3T+ in net premiums, lines across **auto, fire/property, marine, casualty, and personal accident**, and a five-year programme to modernise off legacy mainframe and onto cloud. Claims processing is the single largest internal IT line-item — both because volume is enormous (millions of claims per year) and because every adjuster's productive minute is measurable money.

The system being built here is the **claims platform spine**: not a full PAS (policy admin) replacement, but the layer that sits between policy lookup and reinsurance ceding. It handles intake, triage, assignment, investigation, reserves, and settlement, with hooks into upstream (policy, fraud) and downstream (treasury, reinsurance) systems.

This is a **Track A** delivery: three core modules (FNOL intake, Adjuster Workbench, Reserves), sized so a single pass at the Opus tier consumes roughly $25–35 of API spend. Track B will expand to subrogation, fraud / SIU referral, compliance reporting, and regulatory reporting modules.

## Scope — Track A (three modules)

### 1. FNOL — First Notice of Loss intake

The entry point. Claims arrive through four channels — agent (call centre), customer mobile app, broker / dealer portal, and direct email parse — and all of them deposit a `Claim` record with a unified shape.

- `POST /claims` — create a new claim. Body includes:
  - `policy_number` (validated against an external Policy Service stub)
  - `loss_date` (must fall within policy effective window)
  - `loss_location` (Japanese-format postal address; prefecture validated)
  - `reported_by_channel` ∈ `agent` | `mobile` | `broker` | `email`
  - `reporter_name`, `reporter_phone`, `reporter_email`, `reporter_relation_to_insured` (e.g. *本人/家族/代理店/事故相手方*)
  - `incident_type` ∈ `auto_collision` | `auto_property_damage` | `fire_residential` | `fire_commercial` | `marine_cargo` | `liability_premises` | `personal_accident`
  - `initial_description` (free text; UI in Japanese for the agent, stored as UTF-8)
  - `injury_reported`, `third_party_involved`, `police_report_number?`, `attachments?[]`
- **Validation** — `class-validator` DTOs; reject if `loss_date` < `policy_effective_date` or > `policy_expiry_date`.
- **Channel-specific intake stubs** — each of the four channels has its own controller method that normalises into the common `Claim` shape.
- **Initial classification** — assign `severity_initial` ∈ `simple` | `complex` | `catastrophic` based on declared loss amount + incident_type + injury_reported. (A pure function, no ML.)
- **Audit** — every FNOL emits an immutable `AuditEvent` (`actor`, `action='claim.created'`, `request_id`, `correlation_id`, `claim_id`, `payload_hash`).
- **APPI consent capture** — at intake, store `appi_consent_version` and `appi_consent_at`. Reject intake if consent is missing for non-agent channels.

### 2. Adjuster Workbench

The day-to-day tool the assigned adjuster lives in. Backend + a React + Tailwind workbench UI.

- `GET /claims/:id` — full claim view (sanitised based on caller role).
- `POST /claims/:id/assign` — assign / re-assign adjuster (manager-only). Records `assigned_at`, `assigned_by`, `reason_for_reassignment?`.
- `POST /claims/:id/notes` — append a timestamped, immutable note. Notes are searchable but never editable; corrections add a new note rather than mutate.
- `POST /claims/:id/evidence` — attach evidence (photo, document, witness statement). Stores in an S3-compatible blob stub; record content-hash for tamper detection.
- `POST /claims/:id/witness-statement` — structured witness intake. Includes `inkan_seal_hash` field — the digital equivalent of a Japanese seal acknowledgement.
- `PATCH /claims/:id/status` — workflow state machine: `intake` → `under_investigation` → `awaiting_reserve_approval` → `settlement_offered` → `closed_paid` | `closed_denied` | `reopened`. State transitions guarded; illegal transitions return 422 with explanation.
- **Role matrix:**
  - `agent` — read-only on own intake claims, no notes after submission.
  - `adjuster` — full CRUD on assigned claims; cannot reassign.
  - `manager` — assign / reassign; review and approve reserves.
  - `auditor` — read-only across all claims + full audit-log access; no writes ever.
  - `siu_referrer` — can flag a claim as fraud-suspicious (Track B will add SIU module).
- **Workbench UI** (React + Vite + Tailwind):
  - Claim queue with filter chips (status, severity, channel, age).
  - Claim detail with timeline, notes, evidence gallery, witness statements, reserve breakdown.
  - Quick actions (assign, transition state, attach evidence, add note).
- **Audit** — every write emits an `AuditEvent` with the standard envelope.

### 3. Reserves Management

The core actuarial-touching layer. Reserves are money set aside against expected payout; reserve adequacy is regulated and reported.

- `Reserve` entity per claim: `case_reserve_yen`, `ibnr_signal_yen` (separate field per IFRS17 expectation), `currency='JPY'`, `set_by`, `set_at`, `prior_reserve_yen`, `reason_for_change`, `approval_status` ∈ `pending` | `approved` | `rejected`.
- `POST /claims/:id/reserves` — propose reserve change. Includes `proposed_yen`, `category` ∈ `loss_paid` | `loss_unpaid` | `alae` (allocated loss adjustment expense) | `ulae` (unallocated), and `justification` (>= 50 chars).
- **Approval workflow** — reserve changes >¥1M require manager approval; >¥10M require manager + claims-director approval. Pure rule, encoded in policy.
- `POST /reserves/:id/approve` / `POST /reserves/:id/reject` — guarded; emits audit event.
- **IFRS17 export hook** — `GET /reserves/export?period=YYYY-MM` returns reserve aggregates by category for the actuarial pipeline. Format: tabular JSON suitable for downstream IFRS17 calculation. (No actual IFRS17 calculation; just the data export shape.)
- **JFSA threshold notification** — any single reserve change crossing ¥100M triggers an asynchronous notification record (`NotificationToRegulator`) earmarked for daily JFSA reporting. Captured as an event; not actually sent in POC.
- **Reserve history** — full immutable history of every reserve change, queryable per claim. Critical for audit and IFRS17 walk-forwards.

## Non-functional requirements

- All Jest tests pass on a clean clone (`npm test`).
- ESLint clean.
- Pino structured logging with `request_id` + `correlation_id` correlation across services.
- Helmet enabled; rate-limit on `/auth/login` (5 req/min/IP).
- Global exception filter — no stack traces in API responses; standardised error envelope.
- Config from `.env`; `.env.example` provided.
- **Postgres** as the primary database (not SQLite). Prisma schema reflects Postgres-only types (e.g. `Decimal` for `case_reserve_yen`, `Bytea` for content hashes).
- **OpenAPI / Swagger** at `/docs`.
- **Audit immutability** — the `audit_log` table has no UPDATE or DELETE pathway in code; documented in an ADR and reinforced by Postgres row-level security in a follow-up (Track B).
- **APPI compliance hooks** — consent capture at FNOL; `GET /claims/:id/data-subject-export` returns the full data the system holds about an identified individual (APPI Article 28 disclosure right); `DELETE /claims/:id/personal-data-anonymise` redacts PII while preserving the audit trail.

## PII inventory (APPI-graded)

| Field | Sensitivity | Protection |
|---|---|---|
| `reporter_name` | Standard PII | Stored cleartext; role-masked in API responses |
| `reporter_phone` / `reporter_email` | Standard PII | Same |
| `policy_number` | Sensitive (links to financial product) | Role-masked; auditor sees full |
| `insured_government_id` | Special-care PII (APPI Article 17) | Encrypted at rest (AES-256-GCM via env-supplied KEK, same pattern as Phase 1); never returned in API; only available via explicit `data-subject-export` |
| `bank_account_for_payout` | Special-care PII | Same as above |
| `injury_details` | Special-care PII (medical info) | Same as above |
| `loss_location` | Standard PII | Stored cleartext; role-masked at prefecture-only granularity for non-adjuster roles |

## Role matrix

| Resource × Action | `agent` | `adjuster` | `manager` | `auditor` | `siu_referrer` |
|---|---|---|---|---|---|
| FNOL — create | ✓ (one's own intake) | — | — | — | — |
| Claim — read | own intake (24h) | assigned only | reports' only | all (masked) | flagged only |
| Claim — note add | — | assigned only | reports' only | — | flagged only |
| Claim — evidence add | — | assigned only | — | — | — |
| Claim — status transition | — | assigned only | reports' only | — | — |
| Claim — assign | — | — | reports' pool | — | — |
| Reserve — propose | — | assigned only | reports' only | — | — |
| Reserve — approve | — | — | reports' only (≤ ¥10M) | — | — |
| Reserve — director-approve | — | — | claims-director role only | — | — |
| Audit log — read | — | — | — | ✓ (all) | — |
| Data-subject export | — | — | reports' only | ✓ | — |
| PII anonymise | — | — | — | — | — (manager-only via Track B) |

## Acceptance criteria

1. `npm install` succeeds without warnings.
2. `npm test` green: at least one happy path + one auth-denied + one validation-failure test per module.
3. `npm run start:dev` boots and serves the documented endpoints; Swagger at `/docs`.
4. Seed script populates: 1 admin, 2 managers, 5 adjusters, 1 auditor, 1 SIU referrer, 3 claims-director-able managers, plus 20 sample claims spanning all `incident_type` values and all workflow states.
5. `curl` example for each of the 3 modules returns plausible JSON.
6. `eslint .` returns zero errors.
7. **PII masking demonstrable**: `GET /claims/:id` with an adjuster JWT returns `reporter_phone` cleartext only if the adjuster is the assigned one; otherwise masked.
8. **Audit log accumulates** entries that match every claim/note/evidence/reserve write 1-to-1.
9. **Reserve approval threshold enforced**: a ¥15M proposal cannot be approved by a manager without claims-director approval; test enforces this.
10. **APPI data-subject export** returns all of an identified individual's PII across all claims they appear in, in a single JSON document.

## Tech stack (fixed)

- **NestJS 10** (TypeScript) + **Prisma 5** + **PostgreSQL 16**
- **Jest 29** for unit + integration tests
- **class-validator** for DTOs, **Pino** for logs, **Helmet** + `@nestjs/throttler` for security
- **React 18 + Vite 6 + TailwindCSS** for the Adjuster Workbench
- Node 20+

## Explicitly OUT of scope (Track A only — Track B expands these)

- Subrogation / recovery module.
- Fraud / SIU referral workflow.
- Reinsurance ceding signaling.
- Compliance reporting (JFSA submission packets, IFRS17 disclosure preparation).
- Real-time payout integration with treasury.
- File uploads (evidence is stored by content-hash; actual blob storage stubbed).
- SSO / OAuth / SAML — local JWT auth, same pattern as Phase 1.
- Multi-tenancy.
- Production deployment artifacts (Dockerfile, k8s manifests).
- Real KMS — env-supplied KEK is acceptable for POC, same as Phase 1.
- Full Japanese localisation of UI — UI is English-only, but field labels carry the Japanese term where it's the canonical industry word (e.g. `inkan_seal_hash`, prefecture validation).

## Pass-specific authoring expectations

- The orchestrator must respect the **Japan-specific decisions** captured here (APPI tiering, JFSA notification threshold, IFRS17 reserve categories, prefecture validation, `inkan_seal` pattern). These are the domain rigour that separates this study from a generic CRUD app.
- Reuse the Phase 1 encryption / RBAC / audit-interceptor patterns where they fit — no need to reinvent.
- The Workbench UI is full-screen agent-facing (no auth UI polish needed beyond reuse of Phase 1's Login.tsx pattern).
- All artifacts (backend + frontend + tests + docs + ADRs) must compile and pass tests as verified by `tools/verify.mjs --study=yotsuba-claims --pass=<id>`.

## Reproducibility stamp (filled at run time)

- `brief_sha256:` *(to be hashed at the start of each pass)*
- `policy_sha256:` *(to be hashed per-pass)*
- `git_tag:` *(e.g. v2.0.0-yotsuba-track-a)*
- `model_run_ids:` *(per-pass list of actual model IDs called, including substitutions)*
