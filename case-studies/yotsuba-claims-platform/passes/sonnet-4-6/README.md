# Yotsuba Insurance Holdings — Claims Processing Platform

> **Note on naming.** *Yotsuba Insurance Holdings* is a fictional placeholder protecting an in-flight commercial conversation. The domain shape, regulatory hooks, and operational patterns reflect what a real Japanese P&C insurance conglomerate would recognise.

## Overview

A backend-plus-workbench platform handling the **first-notice-of-loss-to-settlement lifecycle** for personal and commercial P&C claims at a JFSA-regulated Japanese insurance carrier. Implements FNOL intake, Adjuster Workbench, and Reserves Management — the three Track A modules.

```
Agent / Mobile / Broker / Email
          │
          ▼
    ┌─────────────┐    APPI consent     ┌──────────────┐
    │  FNOL Intake │ ─────────────────► │  Audit Log   │
    └──────┬──────┘                     │ (immutable)  │
           │ Claim created              └──────────────┘
           ▼
    ┌─────────────┐    Reserve proposals  ┌─────────────────┐
    │  Adjuster   │ ────────────────────► │    Reserves     │
    │  Workbench  │                       │  Management     │
    └──────┬──────┘                       └────────┬────────┘
           │                                        │
           │ Status FSM                             │ ≥ ¥100M
           ▼                                        ▼
    ┌─────────────┐                     ┌─────────────────────┐
    │  Settlement │                     │  JFSA Notification  │
    │  / Closure  │                     │  (daily flush)      │
    └─────────────┘                     └─────────────────────┘
```

---

## Prerequisites

| Tool | Minimum version |
|------|----------------|
| Node.js | 20.x |
| npm | 10.x |
| PostgreSQL | 16.x |
| Git | 2.x |

---

## Quick Start

### 1. Clone and install

```bash
git clone <repo-url> yotsuba-claims
cd yotsuba-claims
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env — at minimum set DATABASE_URL and JWT_SECRET
```

See [Environment Variables](#environment-variables) for the full reference.

### 3. Prepare the database

```bash
# Create and migrate the database
npx prisma migrate dev --name init

# Seed with sample data (admin, managers, adjusters, auditor, 20 sample claims)
npx prisma db seed
```

### 4. Start the development server

```bash
npm run start:dev
```

The API is available at **http://localhost:3000/api** and Swagger UI at **http://localhost:3000/docs**.

### 5. Start the Adjuster Workbench UI

```bash
cd web
npm install
npm run dev
```

The workbench is available at **http://localhost:5173**.

---

## Environment Variables

Copy `.env.example` to `.env` and populate the values.

```dotenv
# .env.example

# ── Application ────────────────────────────────────────────────────────────
NODE_ENV=development
PORT=3000
CORS_ORIGIN=http://localhost:5173

# ── Database ───────────────────────────────────────────────────────────────
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/yotsuba_claims

# ── Auth (JWT) ─────────────────────────────────────────────────────────────
JWT_SECRET=change-me-to-a-long-random-secret-in-production
JWT_EXPIRES_IN=8h

# ── PII Encryption (AES-256-GCM) ──────────────────────────────────────────
# 32-byte hex-encoded Key Encryption Key for APPI special-care PII fields
# (_ct columns: reporter_phone_ct, insured_government_id_ct, etc.)
ENCRYPTION_KEK=0000000000000000000000000000000000000000000000000000000000000000

# ── Rate limiting ──────────────────────────────────────────────────────────
THROTTLE_TTL_SECONDS=60
THROTTLE_LIMIT=100
# Login endpoint is always 5 req/min/IP regardless of the above

# ── Test database ──────────────────────────────────────────────────────────
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/yotsuba_claims_test
```

> **Security note:** `ENCRYPTION_KEK` must be a cryptographically random 32-byte value in production. The placeholder above is zeros — it will fail FIPS checks and must not be used in a real environment. See [ADR-001](#adr-001-pii-encryption).

---

## Scripts

| Script | Description |
|--------|-------------|
| `npm run start:dev` | Start NestJS in watch mode (nodemon) |
| `npm run start:prod` | Start compiled production build |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm test` | Run all Jest unit + e2e tests |
| `npm run test:e2e` | Run e2e tests only |
| `npm run test:coverage` | Run tests with Istanbul coverage |
| `npm run lint` | Run ESLint across all source files |
| `npm run lint:fix` | Auto-fix lint errors where possible |
| `npx prisma migrate dev` | Apply pending migrations to dev DB |
| `npx prisma db seed` | Seed the database with sample data |
| `npx prisma studio` | Open Prisma Studio (DB browser) |
| `cd web && npm run dev` | Start the Adjuster Workbench (Vite) |
| `cd web && npm run build` | Build the Workbench for production |

---

## API Reference

Full interactive documentation is available at **http://localhost:3000/docs** (Swagger UI) when `NODE_ENV !== production`.

### Authentication

All protected endpoints require a Bearer JWT obtained from `POST /api/auth/login`.

```bash
curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username": "adjuster01", "password": "password"}' \
  | jq '{access_token, role}'
```

Pass the token in subsequent requests:

```bash
export TOKEN="<access_token from above>"
curl -H "Authorization: Bearer $TOKEN" ...
```

---

### Module 1 — FNOL Intake

#### Create a claim (agent channel)

```bash
curl -s -X POST http://localhost:3000/api/claims \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "policy_number": "POL-2024-000123",
    "loss_date": "2024-03-15T09:00:00Z",
    "loss_location_prefecture": "Tokyo",
    "loss_location_postal_code": "100-0001",
    "loss_location_detail": "Chiyoda-ku, Kasumigaseki 1-1",
    "reported_by_channel": "agent",
    "reporter_name": "山田太郎",
    "reporter_phone": "090-1234-5678",
    "reporter_email": "yamada@example.com",
    "reporter_relation_to_insured": "本人",
    "incident_type": "auto_collision",
    "initial_description": "交差点での追突事故。相手車両あり。",
    "injury_reported": false,
    "third_party_involved": true,
    "appi_consent_version": "2024-01",
    "appi_consent_at": "2024-03-15T09:00:00Z"
  }' | jq '{id, status, severity_initial}'
```

Expected response:

```json
{
  "id": "clx1abc2def3ghi4",
  "status": "intake",
  "severity_initial": "complex"
}
```

#### Mobile channel intake

```bash
curl -s -X POST http://localhost:3000/api/claims/mobile \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{...same shape as above, reported_by_channel forced to "mobile"...}'
```

#### Broker channel intake

```bash
curl -s -X POST http://localhost:3000/api/claims/broker \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{...reported_by_channel forced to "broker"...}'
```

#### Email-parse channel intake (idempotent on Message-Id)

```bash
curl -s -X POST http://localhost:3000/api/claims/email-parse \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'X-Message-Id: mail-2024-03-15-99887' \
  -d '{...reported_by_channel forced to "email"...}'
```

---

### Module 2 — Adjuster Workbench

#### List claims (role-scoped)

```bash
# Filter by status + severity + channel
curl -s "http://localhost:3000/api/claims?status=under_investigation&severity=complex&channel=agent" \
  -H "Authorization: Bearer $TOKEN" | jq '.data | length'
```

#### Get claim detail (role-masked PII)

```bash
curl -s "http://localhost:3000/api/claims/clx1abc2def3ghi4" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

An adjuster who is **not** the assigned adjuster receives masked phone/email:

```json
{
  "id": "clx1abc2def3ghi4",
  "reporter_name": "山田太郎",
  "reporter_phone": "***-****-****",
  "reporter_email": "***@***.***",
  "status": "under_investigation"
}
```

The **assigned** adjuster receives cleartext:

```json
{
  "reporter_phone": "090-1234-5678",
  "reporter_email": "yamada@example.com"
}
```

#### Assign a claim (manager only)

```bash
curl -s -X POST "http://localhost:3000/api/claims/clx1abc2def3ghi4/assign" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $MANAGER_TOKEN" \
  -d '{"adjuster_id": "adj01_cuid", "reason_for_reassignment": "Workload balancing"}' \
  | jq '{id, assigned_adjuster_id}'
```

#### Add a note (append-only)

```bash
curl -s -X POST "http://localhost:3000/api/claims/clx1abc2def3ghi4/notes" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"body": "現場確認完了。損傷範囲は前部バンパーのみ。"}' \
  | jq '{id, created_at}'
```

#### Attach evidence

```bash
curl -s -X POST "http://localhost:3000/api/claims/clx1abc2def3ghi4/evidence" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "kind": "photo",
    "content_hash": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "blob_ref": "s3://stub/claims/clx1abc2def3ghi4/evidence/photo-001.jpg"
  }' | jq '{id, content_hash}'
```

#### Submit a witness statement

```bash
curl -s -X POST "http://localhost:3000/api/claims/clx1abc2def3ghi4/witness-statement" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "witness_name": "佐藤花子",
    "witness_phone": "080-9876-5432",
    "statement_body": "信号が青の状態で直進中、相手車両が急に右折してきた。",
    "inkan_seal_hash": "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
  }' | jq '{id, inkan_seal_hash}'
```

#### Transition claim status (FSM-guarded)

```bash
curl -s -X PATCH "http://localhost:3000/api/claims/clx1abc2def3ghi4/status" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"to": "under_investigation", "reason": "Initial review complete, commencing investigation"}' \
  | jq '{id, status}'
```

Illegal transition returns **422**:

```json
{
  "statusCode": 422,
  "error": "Unprocessable Entity",
  "message": "Transition from 'intake' to 'closed_paid' is not permitted. Allowed next states: under_investigation."
}
```

---

### Module 3 — Reserves Management

#### Propose a reserve change

```bash
curl -s -X POST "http://localhost:3000/api/claims/clx1abc2def3ghi4/reserves" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADJUSTER_TOKEN" \
  -d '{
    "category": "loss_unpaid",
    "proposed_yen": "5000000",
    "justification": "修理見積もりに基づき準備金を設定。部品代および工賃を含む。追加費用が発生する可能性あり。"
  }' | jq '{id, approval_status, proposed_yen}'
```

#### Approve a reserve (manager, up to ¥10M)

```bash
curl -s -X POST "http://localhost:3000/api/reserves/res_cuid_here/approve" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $MANAGER_TOKEN" \
  -d '{}' | jq '{id, approval_status, approved_at}'
```

#### Director-approve a reserve (> ¥10M)

```bash
curl -s -X POST "http://localhost:3000/api/reserves/res_cuid_here/director-approve" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $DIRECTOR_TOKEN" \
  -d '{}' | jq '{id, approval_status, director_approved_at}'
```

Attempting manager-only approval on a >¥10M reserve returns **403**:

```json
{
  "statusCode": 403,
  "error": "Forbidden",
  "message": "Reserves exceeding ¥10,000,000 require claims-director approval via POST /reserves/:id/director-approve."
}
```

#### Reject a reserve

```bash
curl -s -X POST "http://localhost:3000/api/reserves/res_cuid_here/reject" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $MANAGER_TOKEN" \
  -d '{"reason_for_rejection": "見積根拠が不十分。詳細な修理明細書を提出のこと。"}' \
  | jq '{id, approval_status, reason_for_rejection}'
```

#### IFRS17 reserve export

```bash
curl -s "http://localhost:3000/api/reserves/export?period=2024-03" \
  -H "Authorization: Bearer $AUDITOR_TOKEN" | jq .
```

Expected response shape:

```json
{
  "period": "2024-03",
  "generated_at": "2024-04-01T00:00:00Z",
  "aggregates": [
    { "category": "loss_paid",   "total_yen": "12500000", "count": 4 },
    { "category": "loss_unpaid", "total_yen": "87300000", "count": 17 },
    { "category": "alae",        "total_yen": "3200000",  "count": 6 },
    { "category": "ulae",        "total_yen": "1100000",  "count": 3 }
  ]
}
```

---

### APPI Compliance Endpoints

#### Data-subject export (APPI Article 28)

Returns all PII the system holds about an identified individual across all claims.

```bash
curl -s "http://localhost:3000/api/claims/clx1abc2def3ghi4/data-subject-export" \
  -H "Authorization: Bearer $AUDITOR_TOKEN" | jq .
```

#### Anonymise personal data (preserves audit trail)

```bash
curl -s -X DELETE "http://localhost:3000/api/claims/clx1abc2def3ghi4/personal-data-anonymise" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $MANAGER_TOKEN" \
  -d '{"reason": "Data retention period expired per APPI Article 19"}'
```

---

### Audit Log

```bash
# Query audit log (auditor only)
curl -s "http://localhost:3000/api/audit?claim_id=clx1abc2def3ghi4&action=reserve.approved&from=2024-03-01&to=2024-03-31" \
  -H "Authorization: Bearer $AUDITOR_TOKEN" | jq '.data | map({action, actor_id, ts})'
```

---

### JFSA Notifications

```bash
# View pending JFSA threshold notifications (auditor only)
curl -s "http://localhost:3000/api/notifications/jfsa-pending" \
  -H "Authorization: Bearer $AUDITOR_TOKEN" | jq .
```

---

## Seed Data

After running `npx prisma db seed`, the following users are available:

| Username | Password | Role | Notes |
|----------|----------|------|-------|
| `admin` | `password` | `manager` | System admin, claims director |
| `manager01` | `password` | `manager` | Reports pool manager, claims director |
| `manager02` | `password` | `manager` | Reports pool manager, claims director |
| `manager03` | `password` | `manager` | Reports pool manager |
| `adjuster01` | `password` | `adjuster` | Assigned to auto claims |
| `adjuster02` | `password` | `adjuster` | Assigned to fire claims |
| `adjuster03` | `password` | `adjuster` | Assigned to marine claims |
| `adjuster04` | `password` | `adjuster` | Assigned to liability claims |
| `adjuster05` | `password` | `adjuster` | General adjuster |
| `auditor01` | `password` | `auditor` | Read-only audit access |
| `siu01` | `password` | `siu_referrer` | SIU fraud referral |

20 sample claims are created spanning all `incident_type` values and all `ClaimStatus` workflow states.

---

## Role Matrix

| Resource × Action | `agent` | `adjuster` | `manager` | `auditor` | `siu_referrer` |
|---|---|---|---|---|---|
| FNOL — create | ✓ | — | — | — | — |
| Claim — read | own (24h) | assigned | reports' | all | flagged |
| Claim — note add | — | assigned | reports' | — | flagged |
| Claim — evidence add | — | assigned | — | — | — |
| Claim — status transition | — | assigned | reports' | — | — |
| Claim — assign | — | — | reports' pool | — | — |
| Reserve — propose | — | assigned | reports' | — | — |
| Reserve — approve (≤ ¥10M) | — | — | ✓ | — | — |
| Reserve — director-approve (> ¥10M) | — | — | claims-director only | — | — |
| Audit log — read | — | — | — | ✓ | — |
| Data-subject export | — | — | reports' | ✓ | — |
| PII anonymise | — | — | ✓ | — | — |

---

## Claim Status FSM

The claim status follows a strict finite-state machine defined in `src/claims/claims-status.fsm.ts`.
Illegal transitions are rejected with HTTP 422 and a human-readable reason.

```
                  ┌──────────────────────────┐
                  │                          │
                  ▼                          │ (reopened)
              intake                         │
                  │                    closed_paid
                  ▼                    closed_denied
        under_investigation
                  │
                  ▼
    awaiting_reserve_approval
                  │
                  ▼
       settlement_offered
               /       \
              ▼         ▼
         closed_paid  closed_denied
              \         /
               ▼       ▼
              reopened
```

---

## Reserve Approval Tiers

Per ADR-005 — thresholds encoded as named constants in `reserves.service.ts`:

| Amount | Approval required |
|--------|------------------|
| ≤ ¥1,000,000 | Self-approving (adjuster proposal auto-approved) |
| ¥1,000,001 – ¥10,000,000 | Manager approval (`POST /reserves/:id/approve`) |
| > ¥10,000,000 | Manager **+** claims-director approval (`POST /reserves/:id/director-approve`) |
| ≥ ¥100,000,000 | Above + triggers async `NotificationToRegulator` for JFSA daily reporting |

---

## APPI PII Tiers

Per ADR-003 — masking behaviour by caller role:

| Field | APPI Tier | Storage | Adjuster (assigned) | Adjuster (other) | Manager | Auditor |
|-------|-----------|---------|--------------------|-----------------|---------|---------|
| `reporter_name` | Standard | Cleartext | ✓ Full | ✓ Full | ✓ Full | ✓ Full |
| `reporter_phone` | Standard | Cleartext | ✓ Full | Masked | ✓ Full | ✓ Full |
| `reporter_email` | Standard | Cleartext | ✓ Full | Masked | ✓ Full | ✓ Full |
| `loss_location_detail` | Standard | Cleartext | ✓ Full | Prefecture only | ✓ Full | ✓ Full |
| `insured_government_id` | Special-care (Art. 17) | AES-256-GCM `_ct` | — | — | — | export only |
| `bank_account_for_payout` | Special-care | AES-256-GCM `_ct` | — | — | — | export only |
| `injury_details` | Special-care (medical) | AES-256-GCM `_ct` | assigned only | — | — | export only |

---

## Running Tests

```bash
# Set up the test database first
export NODE_ENV=test
npx prisma migrate deploy  # or migrate dev

# All tests
npm test

# Specific module
npx jest test/claims-fnol.e2e.spec.ts --verbose
npx jest test/reserves.e2e.spec.ts --verbose
npx jest test/appi.e2e.spec.ts --verbose

# Coverage report
npm run test:coverage
```

Test suites:

| File | Description |
|------|-------------|
| `test/auth.e2e.spec.ts` | Login happy path, bad credentials, rate-limit enforcement |
| `test/claims-fnol.e2e.spec.ts` | All 4 channels, validation failures, APPI consent enforcement |
| `test/claims-workbench.e2e.spec.ts` | Assign, note, evidence, witness, FSM transitions, role-masking |
| `test/reserves.e2e.spec.ts` | Approval thresholds, IFRS17 export shape, JFSA notification trigger |
| `test/appi.e2e.spec.ts` | Data-subject export, anonymisation, PII masking per role |

Acceptance criteria per `brief.md §Acceptance criteria`:
- ✅ At least one happy path + one auth-denied + one validation-failure test per module
- ✅ PII masking demonstrable by role
- ✅ Audit log accumulates 1-to-1 with writes
- ✅ ¥15M proposal cannot be approved by manager without claims-director
- ✅ APPI data-subject export returns all PII in a single JSON document

---

## Architecture Decisions

Full ADRs are in `docs/adr/`. Capsule summaries:

### ADR-001: PII encryption — AES-256-GCM, APPI-tier-aware

APPI Article 17 *special-care personal information* (government IDs, medical information, bank accounts) is stored encrypted using AES-256-GCM with a per-record DEK wrapped by an environment-supplied KEK. Standard PII (name, phone, email) is stored cleartext and masked at response time by `pii-mask.util.ts`.

### ADR-002: Audit log immutability

No UPDATE or DELETE code path exists for `AuditEvent` rows. All writes go through the `AuditInterceptor`. Payload hash provides content-binding. Production hardening (Postgres RLS + write-blocking trigger) is Track B.

### ADR-003: Role masking by APPI tier

Service returns the full record; `MaskByAppiInterceptor` strips or redacts fields based on `caller.role` + APPI sensitivity tier + claim ownership. Adding a new sensitive field = one line in `pii-mask.util.ts`.

### ADR-004: Claim status FSM

`claims-status.fsm.ts` is a **pure function** `(from, to, claim, actor) → {ok, reason}`. All workflow logic lives in one auditable file. Illegal transitions return 422 with the FSM's reason string.

### ADR-005: Reserve approval tiers

Thresholds are named constants in `reserves.service.ts`, not magic numbers. `≤¥1M` self-approving, `¥1M–¥10M` manager-approve, `>¥10M` requires `is_claims_director=true`.

### ADR-006: JFSA notification pattern

When a reserve crosses ¥100M, a `NotificationToRegulator` row is written synchronously. A future daily batch job aggregates and flushes to JFSA. The POC captures the event shape only — wire-format compliance is Track B.

---

## Project Structure

```
yotsuba-claims/
├── src/
│   ├── main.ts                          # Bootstrap, Helmet, Pino, Swagger
│   ├── app.module.ts                    # Root module, middleware
│   ├── prisma.service.ts                # PrismaClient wrapper + cleanDatabase()
│   ├── common/
│   │   ├── encryption.ts                # AES-256-GCM (APPI special-care PII)
│   │   ├── jwt-auth.guard.ts
│   │   ├── roles.guard.ts
│   │   ├── roles.decorator.ts
│   │   ├── current-user.decorator.ts
│   │   ├── pii-mask.util.ts             # maskByAppiTier()
│   │   ├── audit.interceptor.ts         # Writes AuditEvent on annotated routes
│   │   ├── audit.decorator.ts           # @Audit({action: 'claim.note.add'})
│   │   ├── error.filter.ts              # GlobalExceptionFilter
│   │   ├── request-id.middleware.ts
│   │   └── correlation-id.middleware.ts
│   ├── auth/                            # JWT login + /auth/me
│   ├── claims/                          # FNOL, workbench, FSM
│   │   ├── claims-status.fsm.ts         # Pure FSM
│   │   ├── claims-channel.service.ts    # Channel normalisers
│   │   └── dto/
│   ├── reserves/                        # Proposals, approvals, JFSA, IFRS17
│   │   ├── reserves-jfsa.service.ts
│   │   └── reserves-export.service.ts
│   ├── audit/                           # Audit log queries
│   └── appi/                            # Data-subject export + anonymise
├── prisma/
│   ├── schema.prisma                    # Postgres 16 schema (Decimal currency)
│   └── seed.ts                          # 11 users + 20 sample claims
├── test/
│   ├── auth.e2e.spec.ts
│   ├── claims-fnol.e2e.spec.ts
│   ├── claims-workbench.e2e.spec.ts
│   ├── reserves.e2e.spec.ts
│   └── appi.e2e.spec.ts
├── web/                                 # Adjuster Workbench (React + Vite + Tailwind)
│   └── src/
│       ├── pages/
│       │   ├── Login.tsx
│       │   ├── ClaimQueue.tsx           # Filter chips: status, severity, channel, age
│       │   ├── ClaimDetail.tsx          # Timeline + notes + evidence + reserves
│       │   ├── ReserveApprovals.tsx     # Manager approval workflow
│       │   └── AuditLog.tsx             # Auditor view
│       └── components/
│           ├── ClaimStatusPill.tsx
│           ├── SeverityPill.tsx
│           └── EvidenceGallery.tsx
└── docs/
    ├── adr/
    │   ├── 001-encryption.md
    │   ├── 002-audit-immutability.md
    │   ├── 003-role-masking-by-appi-tier.md
    │   ├── 004-claim-status-fsm.md
    │   ├── 005-reserve-approval-tiers.md
    │   └── 006-jfsa-notification-pattern.md
    └── ARCHITECTURE.md
```

---

## Japan-Specific Domain Decisions

These are the features that distinguish this system from a generic CRUD app:

| Feature | Location | Why it matters |
|---------|----------|----------------|
| `inkan_seal_hash` | `WitnessStatement` | Digital equivalent of Japanese personal seal (印鑑) acknowledgement on witness statements |
| `appi_consent_version` + `appi_consent_at` | `Claim` | APPI (個人情報保護法) consent capture; non-agent channels rejected without it |
| Prefecture validation | `loss_location_prefecture` | Japan has 47 prefectures (都道府県); validated against the canonical list |
| `Decimal @db.Decimal(15,0)` | All yen fields | No floating-point for currency; IFRS17 and JFSA expect exact decimal arithmetic |
| JFSA threshold at ¥100M | `reserves.service.ts` | Financial Services Agency reporting obligation |
| IFRS17 reserve categories | `ReserveCategory` enum | `loss_paid`, `loss_unpaid`, `alae`, `ulae` per IFRS17 liability grouping |
| `reporter_relation_to_insured` | `Claim` | Canonical values: 本人/家族/代理店/事故相手方 (policyholder/family/agent/third-party) |
| Special-care PII tier | `_ct` fields | APPI Article 17 stricter treatment for medical info, government IDs, bank accounts |
| Correlation IDs | Every `AuditEvent` | Full chain `agent intake → adjuster note → reserve proposal → approval` reconstructible |

---

## Track B (Out of Scope)

The following are explicitly **not** implemented in Track A:

- Subrogation / recovery module
- Fraud / SIU referral workflow
- Reinsurance ceding signalling
- JFSA submission wire-format (event captured, not transmitted)
- IFRS17 disclosure preparation (export shape only)
- Real-time treasury payout integration
- Actual file/blob storage (content-hash stubbed)
- SSO / OAuth / SAML
- Postgres row-level security for audit immutability
- Full Japanese UI localisation
- Production deployment artifacts

---

## Reproducibility

```
brief_sha256:  (hashed at run time)
policy_sha256: (hashed at run time)
git_tag:       v1.0.0-yotsuba-track-a
```

---

## Licence

Proper commercial licence to be applied when the fictional placeholder name is replaced with the production entity name. All domain logic, regulatory patterns, and architectural decisions are the intellectual property of the commissioning party.