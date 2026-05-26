# Architecture — Yotsuba Insurance Holdings · Claims Processing Platform (Track A)

> **Version:** 1.0.0-yotsuba-track-a  
> **Scope:** Track A — FNOL Intake, Adjuster Workbench, Reserves Management  
> **Regulated under:** JFSA (金融庁) / APPI (個人情報保護法) / IFRS17

---

## 1. System Context

The Claims Processing Platform is the **spine** between the Policy Administration System (PAS) and downstream reinsurance / treasury systems. It is not a PAS replacement; it receives validated policy references and emits settlement signals.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Yotsuba Insurance Holdings                        │
│                                                                          │
│  Intake Channels          Claims Platform (Track A)      Downstream      │
│  ───────────────          ────────────────────────       ─────────────  │
│                                                                          │
│  Agent (Call Centre) ──►                              ► Treasury (stub) │
│  Customer Mobile App ──► ┌──────────────────────────┐                   │
│  Broker / Dealer    ──►  │  FNOL Intake             │ ► Reinsurance     │
│  Email Parse        ──►  │  Adjuster Workbench      │   (Track B)       │
│                          │  Reserves Management     │                   │
│  Upstream Systems        └──────────┬───────────────┘ ► JFSA Daily      │
│  ───────────────                    │                    Notification    │
│  Policy Service (stub) ─────────────┘                   (event only)    │
│  Fraud / SIU (Track B)              │                                   │
│                          ┌──────────▼───────────────┐                   │
│                          │  PostgreSQL 16            │                   │
│                          │  (Prisma 5 ORM)           │                   │
│                          └──────────────────────────┘                   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Request Flow

Every HTTP request traverses the following pipeline before reaching a controller:

```
HTTP Request
    │
    ▼
[RequestIdMiddleware]        — assigns req.requestId from X-Request-Id header
    │                          or generates UUID v4
    ▼
[CorrelationIdMiddleware]    — assigns req.correlationId from X-Correlation-Id
    │                          header, or inherits requestId, or generates UUID
    ▼
[Helmet]                    — security headers (CSP, HSTS, X-Frame-Options…)
    ▼
[ThrottlerGuard]            — 100 req/min/IP global; 5 req/min/IP on /auth/login
    ▼
[JwtAuthGuard]              — validates Bearer JWT; populates req.user
    ▼
[RolesGuard]                — checks @Roles() decorator against req.user.role
    ▼
[AuditInterceptor]          — on annotated routes: writes AuditEvent AFTER
    │                          successful controller execution; carries
    │                          request_id + correlation_id in every row
    ▼
[Controller Method]         — validates DTO via ValidationPipe; calls Service
    ▼
[Service]                   — business logic; Prisma ORM; PII encryption
    ▼
[GlobalExceptionFilter]     — catches all exceptions; strips stack traces;
    │                          returns standardised error envelope
    ▼
HTTP Response
```

---

## 3. Module Decomposition

Build order follows design.md §5 (each layer depends only on layers above it):

```
Layer 0 — Foundation
├── prisma.service.ts          PrismaClient wrapper + cleanDatabase()
└── common/
    ├── encryption.ts           AES-256-GCM; per-record DEK + env KEK
    ├── pii-mask.util.ts        maskByAppiTier() — APPI-tier-aware response masking
    ├── jwt-auth.guard.ts       JWT validation; populates CurrentUser
    ├── roles.guard.ts          Role enforcement via @Roles() decorator
    ├── roles.decorator.ts
    ├── current-user.decorator.ts
    ├── audit.interceptor.ts    Appends AuditEvent after annotated writes
    ├── audit.decorator.ts      @Audit({action: '...'})
    ├── error.filter.ts         GlobalExceptionFilter — no stack traces in API
    ├── request-id.middleware.ts
    └── correlation-id.middleware.ts

Layer 1 — Auth
└── auth/
    ├── auth.module.ts
    ├── auth.controller.ts      POST /auth/login, GET /auth/me
    ├── auth.service.ts         bcrypt verify + JWT sign
    └── dto/login.dto.ts

Layer 2 — Audit
└── audit/
    ├── audit.module.ts
    ├── audit.controller.ts     GET /audit (auditor only)
    └── audit.service.ts        writeEvent(), query()

Layer 3 — Claims (spine)
└── claims/
    ├── claims.module.ts
    ├── claims.controller.ts    8 routes; role guards; @Audit annotations
    ├── claims.service.ts       severity classifier; status machine; PII encrypt
    ├── claims-channel.service.ts  channel normalisers (agent/mobile/broker/email)
    ├── claims-status.fsm.ts    pure function (from, to, claim, actor) → {ok, reason}
    └── dto/                    create-claim, update-status, assign, note, evidence,
                                witness-statement

Layer 4 — Reserves
└── reserves/
    ├── reserves.module.ts
    ├── reserves.controller.ts  propose, approve, director-approve, reject, export
    ├── reserves.service.ts     approval tiers; threshold logic
    ├── reserves-jfsa.service.ts   NotificationToRegulator producer (≥¥100M)
    ├── reserves-export.service.ts IFRS17 aggregation for GET /reserves/export
    └── dto/                    propose-reserve, reject-reserve

Layer 5 — APPI
└── appi/
    ├── appi.module.ts
    ├── appi.service.ts         data-subject-export aggregator; anonymise()
    └── dto/anonymise-request.dto.ts
```

---

## 4. Data Model Overview

Full Prisma schema in `prisma/schema.prisma`. Key relationships:

```
User ──────────────────────────────────────────────────────────────┐
  │ (assigned_adjuster_id)                                         │
  ▼                                                                │
Claim ──────────────────────────────────────────────────────────  │
  │  ├── ClaimNote[]            append-only; never updated         │
  │  ├── Evidence[]             content_hash; blob_ref (stub)      │
  │  ├── WitnessStatement[]     inkan_seal_hash; witness_phone_ct  │
  │  ├── Reserve[]              Decimal(15,0); approval workflow   │
  │  └── AuditEvent[]           append-only; payload_hash          │
  │                                                                │
Reserve                                                            │
  ├── proposed_by  → User ─────────────────────────────────────────┘
  ├── approved_by  → User
  └── director_approved_by → User (is_claims_director = true)

NotificationToRegulator     written when Reserve.proposed_yen ≥ ¥100M
  ├── claim_id  → Claim
  └── reserve_id → Reserve

AuditEvent                  written by AuditInterceptor; NO UPDATE / DELETE path
  ├── actor_id  → User
  └── claim_id  → Claim?
```

### Currency precision

All yen amounts use `Decimal @db.Decimal(15,0)` (Postgres `NUMERIC(15,0)`). No `Float` or JavaScript `number` for money anywhere in the stack. This satisfies JFSA regulatory reporting and IFRS17 calculation pipeline requirements.

### APPI PII storage tiers

| Tier | Fields | Storage | API behaviour |
|------|--------|---------|---------------|
| Standard PII | `reporter_name`, `reporter_phone`, `reporter_email`, `loss_location_detail` | Cleartext | Masked at response time by `pii-mask.util.ts` based on caller role |
| Special-care PII (APPI Art. 17) | `reporter_phone_ct`, `reporter_email_ct`, `witness_phone_ct`, `insured_government_id_ct`, `bank_account_for_payout_ct`, `injury_details_ct` | AES-256-GCM encrypted blob (`Bytes`) | Never returned in normal API responses; only via `/data-subject-export` |

---

## 5. Claim Status Finite-State Machine

Defined in `src/claims/claims-status.fsm.ts` as a pure function. The controller rejects illegal transitions with HTTP 422 and the FSM's reason string.

```
                         ┌────────────────────────────────┐
                         │                                │
                         ▼                                │ (reopened)
                      intake                              │
                         │                          closed_paid
                         │ adjuster / manager        closed_denied
                         ▼
               under_investigation
                         │
                         │ adjuster / manager
                         ▼
           awaiting_reserve_approval
                         │
                         │ manager (after reserve approved)
                         ▼
              settlement_offered
                        / \
                       /   \
          adjuster /  /     \ manager
          manager     ▼       ▼
                closed_paid  closed_denied
                       \       /
                        ▼     ▼
                        reopened ─────────────────────────┘
```

All valid transitions:

| From | To | Permitted roles |
|------|----|-----------------|
| `intake` | `under_investigation` | adjuster (assigned), manager |
| `under_investigation` | `awaiting_reserve_approval` | adjuster (assigned), manager |
| `awaiting_reserve_approval` | `settlement_offered` | manager |
| `settlement_offered` | `closed_paid` | adjuster (assigned), manager |
| `settlement_offered` | `closed_denied` | adjuster (assigned), manager |
| `closed_paid` | `reopened` | manager |
| `closed_denied` | `reopened` | manager |
| `reopened` | `under_investigation` | adjuster (assigned), manager |

---

## 6. Reserve Approval Tiers

Encoded as named constants in `src/reserves/reserves.service.ts`. Pure policy — not database configuration.

```
proposed_yen ≤ ¥1,000,000
    └── Self-approving: status immediately set to 'approved'

¥1,000,001 ≤ proposed_yen ≤ ¥10,000,000
    └── Requires: POST /reserves/:id/approve  (manager)

proposed_yen > ¥10,000,000
    ├── Step 1: POST /reserves/:id/approve         (manager)
    └── Step 2: POST /reserves/:id/director-approve (manager + is_claims_director = true)

proposed_yen ≥ ¥100,000,000
    └── Above approval chain PLUS synchronous write to NotificationToRegulator
        for JFSA daily reporting batch (event captured; wire format is Track B)
```

---

## 7. APPI Compliance Flow

```
FNOL Intake
    │
    ├── appi_consent_version + appi_consent_at required in request body
    │   Non-agent channels: 422 if missing
    │
    ▼
Claim Created
    │
    ├── Standard PII stored cleartext
    │   Masked at response time by pii-mask.util.ts per caller role
    │
    ├── Special-care PII encrypted (AES-256-GCM, per-record DEK)
    │   _ct columns: Bytes in Postgres; never returned in standard API
    │
    ▼
GET /claims/:id/data-subject-export   [auditor | manager]
    │
    └── appi.service.ts aggregates ALL PII across ALL claims
        for the identified individual; decrypts _ct fields
        Returns: APPI Article 28 disclosure document

DELETE /claims/:id/personal-data-anonymise   [manager]
    │
    ├── Redacts cleartext PII fields (name → [ANONYMISED], phone → null…)
    ├── Overwrites _ct blobs with zero-bytes
    ├── Preserves AuditEvent rows intact (audit trail immutable)
    └── Emits AuditEvent with action='claim.pii.anonymised'
```

---

## 8. Audit Immutability

See ADR-002 for full rationale.

```
Write path (the ONLY path):
    AuditInterceptor
        └── audit.service.ts#writeEvent()
                └── prisma.auditEvent.create()   ← INSERT only

No UPDATE or DELETE path exists in any service or controller.
Enforced by:
  1. Code review convention (grep audit_events for update/delete — zero matches)
  2. payload_hash (SHA-256 of normalised payload) provides content-binding
  3. Track B: Postgres RLS policy + write-blocking trigger will enforce at DB layer

Read path:
    GET /audit   [auditor only]
        └── audit.service.ts#query()
                └── prisma.auditEvent.findMany()  ← SELECT only
```

Every `AuditEvent` row carries:
- `actor_id` + `actor_role` — who performed the action
- `action` — e.g. `claim.created`, `reserve.approved`, `evidence.added`
- `claim_id` — the affected claim (nullable for non-claim actions)
- `target_id` — the affected sub-resource (reserve ID, note ID, etc.)
- `payload_hash` — SHA-256 of the normalised event payload
- `request_id` — traces to the originating HTTP request
- `correlation_id` — traces across the full request chain (intake → adjuster → reserve → approval)
- `ts` — ISO timestamp

---

## 9. Security Architecture

| Control | Implementation |
|---------|---------------|
| Transport security | TLS (terminated at load balancer in production; HTTP in POC) |
| Security headers | Helmet (CSP, HSTS, X-Frame-Options, X-Content-Type-Options) |
| Authentication | Local JWT (HS256, 8h expiry); `@nestjs/passport` + `passport-jwt` |
| Authorisation | `RolesGuard` + `@Roles()` decorator; claim ownership checked in service layer |
| Rate limiting | `@nestjs/throttler`; 5 req/min/IP on `/auth/login`; 100 req/min/IP global |
| PII at rest | AES-256-GCM with per-record DEK + env-supplied KEK (`ENCRYPTION_KEK`) |
| PII in transit | Response-time masking via `pii-mask.util.ts`; `maskByAppiTier()` |
| PII in logs | Pino `redact` config removes `Authorization`, `Cookie`, `X-Api-Key` headers |
| Input validation | `class-validator` DTOs with `whitelist: true` + `forbidNonWhitelisted: true` |
| Error responses | `GlobalExceptionFilter` strips stack traces; returns standardised envelope |
| Audit trail | Append-only `AuditEvent` table; payload SHA-256 content-binding |

---

## 10. Adjuster Workbench UI

A full-screen React 18 + Vite 6 + TailwindCSS SPA served separately from the API.

```
web/src/
├── lib/
│   ├── api.ts            fetch wrapper; attaches JWT; handles 401 → redirect to login
│   ├── auth.tsx          AuthContext; useAuth() hook
│   └── format-yen.ts     Intl.NumberFormat for ¥ display; 47-prefecture lookup
├── components/
│   ├── Layout.tsx         nav + role badge + logout
│   ├── RoleBadge.tsx      colour-coded role chip
│   ├── ClaimStatusPill.tsx  FSM status with colour per state
│   ├── SeverityPill.tsx   simple / complex / catastrophic
│   └── EvidenceGallery.tsx  content-hash list with kind icons
└── pages/
    ├── Login.tsx           JWT login form
    ├── ClaimQueue.tsx      filterable list: status, severity, channel, age
    ├── ClaimDetail.tsx     timeline + notes + evidence gallery + witness statements
    │                       + reserve breakdown + quick actions
    ├── ReserveApprovals.tsx  manager approval queue; approve / reject actions
    └── AuditLog.tsx         auditor view; filter by actor, action, claim, date range
```

API proxy in development: Vite `server.proxy` forwards `/api` to `http://localhost:3000/api`, eliminating CORS friction during development.

---

## 11. Japan-Specific Domain Decisions

These features distinguish this system from a generic CRUD claims platform and reflect what a JFSA-regulated P&C insurer expects:

| Feature | Schema / Code Location | Regulatory / Business Basis |
|---------|------------------------|-----------------------------|
| `inkan_seal_hash` | `WitnessStatement.inkan_seal_hash` | Digital equivalent of 印鑑 (personal seal) acknowledgement; SHA-256 of canonical statement + timestamp |
| `appi_consent_version` + `appi_consent_at` | `Claim` | APPI 個人情報保護法 consent capture; non-agent channels rejected without it |
| Prefecture validation (47 都道府県) | `Claim.loss_location_prefecture`; validated in DTO | Japanese address structure; prefecture is the primary administrative unit |
| `Decimal @db.Decimal(15,0)` for all yen | `Reserve.proposed_yen`, `prior_yen`, `NotificationToRegulator.amount_yen` | No floating-point for currency; JFSA and IFRS17 require exact decimal arithmetic |
| JFSA threshold at ¥100,000,000 | `reserves-jfsa.service.ts` | 金融庁 reporting obligation for large reserve changes |
| IFRS17 reserve categories | `ReserveCategory` enum: `loss_paid`, `loss_unpaid`, `alae`, `ulae` | IFRS17 liability measurement groupings; downstream actuarial pipeline consumes these |
| `reporter_relation_to_insured` | `Claim` | Canonical values: 本人 / 家族 / 代理店 / 事故相手方 (policyholder / family / agent / third-party) |
| Special-care PII tier with `_ct` columns | `Claim.*_ct`, `WitnessStatement.witness_phone_ct` | APPI Article 17 — stricter treatment for medical information, government IDs, bank accounts |
| Correlation IDs on every `AuditEvent` | `AuditEvent.correlation_id` | Full chain agent intake → adjuster note → reserve proposal → approval reconstructible in log aggregator |
| IFRS17 export hook | `GET /reserves/export?period=YYYY-MM` | Tabular JSON for actuarial pipeline; no calculation performed (data export only) |

---

## 12. Non-Functional Targets (Track A POC)

| Concern | Target | Implementation |
|---------|--------|---------------|
| Structured logging | All log lines carry `request_id` + `correlation_id` | nestjs-pino; `customProps` in `app.module.ts` |
| API documentation | Swagger UI at `/docs` when `NODE_ENV !== production` | `@nestjs/swagger`; DocumentBuilder in `main.ts` |
| Input validation | Reject unknown fields; validate all DTO constraints | `ValidationPipe` with `whitelist: true`, `forbidNonWhitelisted: true` |
| Error surface | No stack traces; standardised envelope | `GlobalExceptionFilter` |
| Test coverage | ≥ 1 happy path + 1 auth-denied + 1 validation-failure per module | Jest 29 + Supertest; 5 e2e spec files |
| Database | PostgreSQL 16; Prisma 5 ORM | `Decimal` for money; `Bytes` for encrypted PII; indexes on hot query paths |
| Config | All secrets from `.env` / environment | `@nestjs/config`; `.env.example` provided |

---

## 13. Track B Extensions (Out of Scope — Documented for Continuity)

The following are deliberately excluded from Track A. Architecture decisions in Track A were made to accommodate them without rework:

| Track B Feature | Track A Hook |
|-----------------|-------------|
| Subrogation / recovery | `ClaimStatus.closed_paid` + `closed_denied` are natural trigger points |
| Fraud / SIU referral | `UserRole.siu_referrer` already in schema; `Claim` has no FK yet |
| Reinsurance ceding | `NotificationToRegulator` pattern is the template; ceding events are the same shape |
| JFSA submission wire format | `NotificationToRegulator.sent_at` is null until batch flushes |
| IFRS17 disclosure preparation | `GET /reserves/export` provides the raw aggregate shape |
| Postgres RLS for audit immutability | ADR-002 documents the intent; `AuditEvent` table ready |
| Real KMS | `ENCRYPTION_KEK` env var replaced 1-for-1 with KMS key reference |
| SSO / OAuth / SAML | `auth.service.ts` `validateUser()` is the seam to replace |

---

## 14. Key Files Quick Reference

| File | Purpose |
|------|---------|
| `prisma/schema.prisma` | Canonical data model; all enums, relations, indexes |
| `src/common/encryption.ts` | `encrypt(plaintext)` / `decrypt(ciphertext)` — AES-256-GCM |
| `src/common/pii-mask.util.ts` | `maskByAppiTier(claim, callerRole, isAssigned)` — single source of truth for field visibility |
| `src/claims/claims-status.fsm.ts` | `canTransition(from, to, claim, actor)` — pure FSM; all workflow logic |
| `src/reserves/reserves.service.ts` | `SELF_APPROVE_THRESHOLD`, `MANAGER_APPROVE_THRESHOLD`, `DIRECTOR_APPROVE_THRESHOLD`, `JFSA_NOTIFICATION_THRESHOLD` — named constants |
| `src/common/audit.interceptor.ts` | The only code path that writes `AuditEvent` rows |
| `prisma/seed.ts` | 1 admin, 2 managers (claims-director), 1 manager (non-director), 5 adjusters, 1 auditor, 1 SIU, 20 sample claims |
| `docs/adr/` | ADR-001 through ADR-006 — every non-obvious architectural choice justified |