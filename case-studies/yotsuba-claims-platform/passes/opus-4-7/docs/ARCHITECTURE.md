# Architecture — Yotsuba Insurance Holdings · Claims Processing Platform

> **Naming note.** *Yotsuba Insurance Holdings* is a fictional placeholder for a top-tier Japanese P&C insurance carrier. The domain shape, regulatory hooks, and operational patterns reflect what a real JFSA-regulated insurer would recognise; the fictional naming protects an in-flight commercial conversation and is replaced 1-for-1 when permission is granted.

This document is the one-page architectural narrative for Track A. It sits alongside `brief.md` (the locked product specification) and `design.md` (the locked technical specification) and is the reference a reviewer should read first. Implementation details belong in the code; this file explains *why* the code is shaped the way it is.

---

## 1. Context — what this system is, and what it is not

The target customer is a top-tier Japanese P&C insurance carrier with ~¥3T+ in net premiums, lines across **auto, fire/property, marine, casualty, and personal accident**, and a five-year programme to modernise off legacy mainframe and onto cloud. Claims processing is the single largest internal IT line-item — both because volume is enormous (millions of claims per year) and because every adjuster's productive minute is measurable money.

This system is the **claims platform spine**: not a full PAS (policy admin) replacement, but the layer that sits between policy lookup and reinsurance ceding. It handles intake, triage, assignment, investigation, reserves, and settlement, with hooks into upstream (policy, fraud) and downstream (treasury, reinsurance) systems.

Track A in this repository delivers **three core modules** plus a thin workbench UI:

1. **FNOL intake** — four channel-specific normalisers depositing into one `Claim` shape.
2. **Adjuster Workbench** — the day-to-day tool for an assigned adjuster.
3. **Reserves Management** — IFRS17-category reserves, tiered approval, JFSA threshold notification.

Everything else — subrogation, SIU referral, reinsurance ceding, JFSA submission packets, IFRS17 disclosure preparation, real treasury integration — is Track B and is deliberately *not stubbed misleadingly*. The `siu_referrer` role exists in the RBAC matrix; the SIU module does not.

---

## 2. One-page diagram

```
  ┌────────────────────────────────────────────────────────────────────────────┐
  │                              CLIENTS                                       │
  │                                                                            │
  │   Call-centre agent      Mobile app       Broker portal     Email parser   │
  │        (web UI)          (REST)             (REST)          (REST/batch)   │
  │           │                  │                 │                 │         │
  │           ▼                  ▼                 ▼                 ▼         │
  │      POST /claims     POST /claims/mobile  POST /claims/broker POST /claims/│
  │                                                                email-parse │
  └────────────────────────────────────┬───────────────────────────────────────┘
                                       │  (JWT bearer + X-Correlation-Id)
                                       ▼
  ┌────────────────────────────────────────────────────────────────────────────┐
  │                          NestJS API  (this repo)                           │
  │                                                                            │
  │  ┌──────────────────────────────────────────────────────────────────────┐  │
  │  │  Edge   : Helmet · CORS · ValidationPipe · GlobalExceptionFilter     │  │
  │  │  Per-req: RequestIdMiddleware → CorrelationIdMiddleware              │  │
  │  │  Guards : ThrottlerGuard · JwtAuthGuard · RolesGuard                 │  │
  │  │  Cross  : AuditInterceptor (writes AuditEvent on @Audit-marked rts)  │  │
  │  │           MaskByAppiInterceptor (role-masks PII on responses)        │  │
  │  └──────────────────────────────────────────────────────────────────────┘  │
  │                                                                            │
  │  ┌──────────┬──────────┬──────────────┬────────────┬─────────────────┐    │
  │  │  auth/   │ claims/  │  reserves/   │  audit/    │     appi/       │    │
  │  │          │          │              │            │                 │    │
  │  │ /auth/   │ /claims  │ /reserves    │ /audit     │ /claims/:id/    │    │
  │  │  login   │ + 4 chan │ + approve    │ (auditor   │   data-subject- │    │
  │  │ /auth/me │ + notes  │ + director-  │  read-only)│   export        │    │
  │  │          │ + evidnc │   approve    │            │ + anonymise     │    │
  │  │          │ + status │ + reject     │            │                 │    │
  │  │          │   FSM    │ + IFRS17 exp │            │                 │    │
  │  │          │ + assign │ + JFSA emit  │            │                 │    │
  │  └──────────┴──────────┴──────────────┴────────────┴─────────────────┘    │
  │                                                                            │
  │  ┌──────────────────────────────────────────────────────────────────────┐  │
  │  │ common/ : encryption (AES-256-GCM + KEK) · pii-mask · roles guard    │  │
  │  │          claim-status FSM · request/correlation IDs · error filter   │  │
  │  └──────────────────────────────────────────────────────────────────────┘  │
  │                                                                            │
  │                       PrismaService (singleton, one pool)                  │
  └────────────────────────────────────┬───────────────────────────────────────┘
                                       │
                                       ▼
  ┌────────────────────────────────────────────────────────────────────────────┐
  │                          PostgreSQL 16                                     │
  │                                                                            │
  │  User · Claim · ClaimNote · Evidence · WitnessStatement                    │
  │  Reserve · NotificationToRegulator · AuditEvent (append-only by code)      │
  │                                                                            │
  │  Currency : Decimal(15,0) JPY            Special-care PII : Bytea (_ct)    │
  └────────────────────────────────────────────────────────────────────────────┘

  ┌────────────────────────────────────────────────────────────────────────────┐
  │   Adjuster Workbench  (React 18 + Vite 6 + Tailwind, served separately)    │
  │   /login  ·  /queue  ·  /claims/:id  ·  /approvals  ·  /audit              │
  └────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Module map and dependency order

The dependency order below is also the orchestrator's build order. Each module depends only on those above it.

| # | Module | Owns | Depends on |
|---|--------|------|------------|
| 1 | `common/` | encryption, guards, decorators, PII masking, audit interceptor, ID middlewares, error filter, claim-status FSM | — |
| 2 | `prisma.service.ts` | the singleton Prisma client + shutdown hooks | `common/` |
| 3 | `auth/` | `/auth/login`, `/auth/me`, JWT issuance, password hashing | `common/`, Prisma |
| 4 | `audit/` | `/audit` reads; `AuditService` used by the interceptor as the only writer | `common/`, Prisma |
| 5 | `claims/` | FNOL channel normalisers, workbench actions, status FSM application | `common/`, `audit/`, Prisma |
| 6 | `reserves/` | proposals, tiered approval, JFSA emitter, IFRS17 export | `claims/`, `audit/`, Prisma |
| 7 | `appi/` | data-subject-export aggregator, anonymisation | every other module + Prisma |
| 8 | tests | per-module e2e suites against a real Postgres | the API |
| 9 | `web/` | Adjuster Workbench (React + Vite + Tailwind) | the API being stable |
| 10 | `docs/` | this file + six ADRs + curl tour | — |

---

## 4. Request lifecycle — one round trip

A single inbound HTTP request — say, `POST /claims/:id/notes` — flows through the stack in a fixed order. Knowing this order is the fastest way to debug.

1. **TLS / reverse proxy** (out of repo). Strips TLS, forwards `X-Request-Id` and `X-Correlation-Id` if present.
2. **Helmet** stamps security headers on the outbound response.
3. **CORS** validates origin against `CORS_ORIGIN` (prod) or allows all (non-prod).
4. **`RequestIdMiddleware`** stamps `request.request_id` — uses the inbound header if it looks well-formed, otherwise mints a fresh one. The response carries `X-Request-Id`.
5. **`CorrelationIdMiddleware`** stamps `request.correlation_id` — uses the inbound header if present, otherwise falls back to `request.request_id`. This is why the request-id middleware must run first.
6. **`ThrottlerGuard`** rate-limits per IP. The default ceiling is generous (120/min); `/auth/login` overrides to 5/min via `@Throttle`.
7. **`ValidationPipe`** runs class-validator on the DTO. `whitelist + forbidNonWhitelisted` strips and rejects unknown fields so attackers cannot smuggle extra columns.
8. **`JwtAuthGuard`** validates the bearer token and attaches the resolved `User` to the request.
9. **`RolesGuard`** consults `@Roles(...)` metadata and rejects 403 if the caller's role is not on the allowlist.
10. **Controller method** runs. For writes, the service performs the domain operation in a single Prisma transaction *and* lets the audit interceptor handle audit emission — the service does not write to `AuditEvent` itself.
11. **`AuditInterceptor`** inspects `@Audit({ action })` metadata. If present, it computes `payload_hash` (sha-256 over the normalised request body), then writes an `AuditEvent` row with `actor_id`, `actor_role`, `action`, `claim_id`, `target_id`, `payload_hash`, `request_id`, `correlation_id`, and the server-side timestamp.
12. **`MaskByAppiInterceptor`** walks the response object and redacts PII fields based on `caller.role`, ownership of the record, and each field's APPI tier (see ADR-003).
13. **`GlobalExceptionFilter`** is the catch-all. Any thrown exception is converted into a standardised JSON envelope `{ error: { code, message, request_id, correlation_id } }` with no stack trace on the wire.

Every downstream side-effect carries the same `correlation_id`, so the chain *agent intake → adjuster note → reserve proposal → manager approval → director approval → JFSA notification* is reconstructible end-to-end from the audit table with a single `WHERE correlation_id = …` query.

---

## 5. Data model — the shape that distinguishes this from a generic CRUD app

The full Prisma schema lives at `prisma/schema.prisma`. The shape choices that matter:

- **Currency is `Decimal(15,0)`** end-to-end. No `number` for yen anywhere — not in DTOs, not in services, not in DB. JavaScript's IEEE-754 float is unsafe for monetary values and IFRS17 walk-forwards demand exact arithmetic.
- **Special-care PII (APPI Article 17)** is stored in `Bytes` columns suffixed `_ct`: `reporter_phone_ct`, `reporter_email_ct`, `insured_government_id_ct`, `bank_account_for_payout_ct`, `injury_details_ct`, `witness_phone_ct`. These are AES-256-GCM ciphertexts under an envelope DEK protected by `PII_KEK`. They are *never* returned by ordinary read paths — only by `GET /claims/:id/data-subject-export`.
- **Standard PII** (name, postal address, prefecture) is stored cleartext and masked at the response layer. The single source of truth for what gets masked is `src/common/pii-mask.util.ts` (ADR-003).
- **`inkan_seal_hash`** on `WitnessStatement` is a sha-256 over the canonical statement body + timestamp — the digital equivalent of a Japanese seal acknowledgement. It is the closest thing in code to a domain word a generic CRUD POC would never produce.
- **`appi_consent_version` + `appi_consent_at`** are captured at FNOL. Intake from non-agent channels is rejected when consent is missing.
- **`ClaimStatus`** is a Prisma enum and is the only allowed values for the status field. Transitions between values are governed by a pure FSM (ADR-004), not by anyone-can-PATCH semantics.
- **`AuditEvent`** is append-only by code convention (ADR-002). No service writes to it directly; only the `AuditInterceptor` does. There is no UPDATE or DELETE pathway anywhere in the codebase. Production hardening (Postgres row-level security + a trigger raising on mutation) is Track B.
- **`NotificationToRegulator`** captures JFSA threshold events. The `sent_at` field is null until a (future) daily batch flushes the queue. The POC captures the *event shape*; the regulatory wire format is Track B (ADR-006).

---

## 6. The four cross-cutting policies

Four policy modules account for the regulatory rigour that distinguishes this study from a generic claims-CRUD POC. Each is a small, named, testable surface — *not* magic numbers scattered through services.

### 6.1 APPI tiering — `src/common/pii-mask.util.ts`

Fields are tagged with one of three APPI tiers:

- **`standard`** — name, email, phone, postal address. Cleartext at rest; masked in responses based on caller role + record ownership.
- **`special_care`** — government ID, bank account, injury details. Encrypted at rest under `PII_KEK`; never returned by ordinary read paths.
- **`public`** — claim id, status, severity, timestamps. Always returned.

The masking function takes `(record, caller, ownership)` and returns the response shape. Adding a new sensitive field is a one-line edit; the tests in `test/claims-workbench.e2e.spec.ts` cover every role × every field.

### 6.2 Claim status FSM — `src/claims/claims-status.fsm.ts`

A pure function `transition(from, to, claim, actor) → { ok, reason }`. The legal transitions are:

```
intake ──▶ under_investigation ──▶ awaiting_reserve_approval ──▶ settlement_offered
                                                                       │
                                                                       ├──▶ closed_paid
                                                                       └──▶ closed_denied

closed_paid / closed_denied ──▶ reopened ──▶ under_investigation
```

Illegal transitions return HTTP 422 with the FSM's own human-readable reason — not a generic "invalid state". The controller is a thin wrapper; all workflow logic lives in this one file (ADR-004).

### 6.3 Reserve approval tiers — `src/reserves/reserves.service.ts`

Three thresholds, named constants:

- **≤ ¥1,000,000** — self-approving (proposer's manager rubber-stamps as part of the workflow but no separate gate).
- **¥1,000,001 — ¥10,000,000** — requires manager approval.
- **> ¥10,000,000** — requires manager approval *and* a `claims_director`-flagged manager's director-approval.

A `¥15M` proposal cannot be approved by a non-director manager. The test in `test/reserves.e2e.spec.ts` enforces this (acceptance criterion #9). Threshold changes are one-line edits with tests (ADR-005).

### 6.4 JFSA threshold notification — `src/reserves/reserves-jfsa.service.ts`

When a reserve change crosses **¥100,000,000**, the reserves service synchronously writes a `NotificationToRegulator` row with `kind="jfsa_reserve_threshold"`, `sent_at=null`, and the amount. Auditors can list pending rows at `GET /notifications/jfsa-pending`. The actual daily batch that aggregates and dispatches to JFSA is Track B; the POC captures the *event shape* so reviewers can see that thresholds are detected without us claiming wire-format compliance we don't have (ADR-006).

---

## 7. RBAC matrix — five roles, two axes of scope

The five roles defined in `UserRole` are scoped along two axes: **resource ownership** (own intake / assigned / reports' / all / flagged) and **action class** (read / write / approve / read-audit).

| Role | Reads | Writes | Notes |
|------|-------|--------|-------|
| `agent` | own intake within 24h | FNOL create only | Call-centre channel; cannot edit after submission |
| `adjuster` | assigned claims only | notes, evidence, witness statements, status (assigned-only), reserve proposals | Cannot reassign |
| `manager` | reports' claims | assign / reassign, status (reports' only), reserve approve ≤¥10M, director-approve if `is_claims_director=true` | Claims-director flag is a property on `User`, not a separate role |
| `auditor` | all claims (PII-masked) + full audit log + data-subject exports | none | Read-only by construction; no write routes accept this role |
| `siu_referrer` | flagged claims | fraud flag (Track B expands this) | Role exists; SIU module is Track B |

Ownership rules are enforced in the service layer (a manager can only act on claims whose `assigned_adjuster.reports_to_id` matches their id); the `RolesGuard` only gates by role. Both must pass.

---

## 8. Observability and operability

The operational hooks needed for an SRE to debug a production incident:

- **Structured logs** — Pino with `request_id` and `correlation_id` on every line. Query-level logs are *off by default* (`PRISMA_LOG_QUERIES=false`) to avoid logging PII; turn them on selectively for debugging.
- **Request/correlation IDs** — propagated end-to-end as response headers and into every `AuditEvent` row. The correlation id is the join key for cross-service tracing.
- **OpenAPI** — Swagger UI at `/docs`, raw JSON at `/docs-json`. Persistent bearer-token authorisation in the UI for interactive debugging.
- **Standardised error envelope** — `{ error: { code, message, request_id, correlation_id } }`. No stack traces on the wire (NFR in `brief.md`). The same envelope shape is returned for 400, 401, 403, 404, 422, and 500.
- **Shutdown hooks** — Prisma's `beforeExit` bound to Nest's `app.close()` so SIGTERM / SIGINT drain the connection pool cleanly.
- **Throttling** — `ThrottlerGuard` global at 120/min/IP, with `/auth/login` tightened to 5/min/IP per the brief.
- **Audit-as-trace** — for any claim-level investigation, `SELECT * FROM "AuditEvent" WHERE claim_id = $1 ORDER BY ts` is the complete chronological story.

---

## 9. What this architecture deliberately does not do

A reviewer should be able to tell at a glance what is *not* in the box, so that nothing looks accidentally undeliverable:

- **No real PAS integration.** Policy validation is stubbed; the brief calls for a Policy Service stub.
- **No real KMS.** `PII_KEK` is env-supplied; key versioning and rotation are Track B alongside KMS integration.
- **No real blob storage.** Evidence records carry `content_hash` and a `blob_ref` (`s3://stub/...`); the actual blob upload is out of scope.
- **No actual IFRS17 calculation.** The export endpoint returns aggregates in the *shape* IFRS17 wants; the calculation lives downstream in the actuarial pipeline.
- **No actual JFSA submission.** Threshold-crossing events are captured as `NotificationToRegulator` rows; the daily wire-format flush is Track B.
- **No SSO / OAuth / SAML.** Local JWT auth, same pattern as Phase 1.
- **No multi-tenancy.** Single-carrier deployment model.
- **No Japanese UI localisation.** The Workbench is English-only; Japanese terms appear only where they are the canonical industry word (`inkan_seal_hash`, prefecture labels, `本人/家族/代理店/事故相手方` relation strings).
- **No production deployment artifacts.** No Dockerfile, no k8s manifests, no CI workflow. These are Track B.

Everything in the list above is named and tracked rather than silently stubbed — a stubbed integration that *looks* real is worse than a missing one.

---

## 10. Pointers — where to read next

- `brief.md` — the locked product brief; reads as the customer-facing spec.
- `design.md` — the locked technical spec; reads as the engineer-facing contract.
- `prisma/schema.prisma` — the single source of truth for the data model.
- `docs/adr/001-encryption.md` through `006-jfsa-notification-pattern.md` — the six decision records that capture *why* the architecture looks the way it does.
- `README.md` — operator-facing quickstart with the three-module curl tour.
- `test/` — the executable specification; if the docs and the tests disagree, the tests win.