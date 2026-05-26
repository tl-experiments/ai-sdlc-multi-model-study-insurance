# Yotsuba Insurance Holdings · Claims Processing Platform

> **Naming note.** *Yotsuba Insurance Holdings* is a fictional placeholder for a top-tier Japanese P&C insurance carrier. The domain shape, regulatory hooks, and operational patterns reflect what a real JFSA-regulated insurer would recognise; the fictional naming protects an in-flight commercial conversation and is replaced 1-for-1 when permission is granted.

A backend-plus-workbench platform that handles the first-notice-of-loss-to-settlement lifecycle for **personal & commercial P&C claims** — auto, fire/property, marine, casualty, and personal accident — with the regulatory hooks, audit immutability, and reinsurance signaling a JFSA-regulated insurer needs.

This is **Track A**: three core modules — FNOL intake, Adjuster Workbench, and Reserves Management — plus a React workbench UI. Track B (subrogation, SIU referral, reinsurance ceding, compliance reporting) is explicitly out of scope.

---

## Table of contents

1. [What this repository contains](#what-this-repository-contains)
2. [Architecture at a glance](#architecture-at-a-glance)
3. [Prerequisites](#prerequisites)
4. [Quick start](#quick-start)
5. [Environment variables](#environment-variables)
6. [Database — Prisma + Postgres](#database--prisma--postgres)
7. [Seed data](#seed-data)
8. [Running the API](#running-the-api)
9. [Running the Adjuster Workbench](#running-the-adjuster-workbench)
10. [Tests, linting, and verification](#tests-linting-and-verification)
11. [API surface — three-module curl tour](#api-surface--three-module-curl-tour)
12. [Role matrix and PII handling](#role-matrix-and-pii-handling)
13. [Regulatory hooks — APPI · JFSA · IFRS17](#regulatory-hooks--appi--jfsa--ifrs17)
14. [Audit immutability](#audit-immutability)
15. [Architecture Decision Records](#architecture-decision-records)
16. [What is out of scope (Track A)](#what-is-out-of-scope-track-a)
17. [Project layout](#project-layout)

---

## What this repository contains

| Layer | Tech | Location |
| --- | --- | --- |
| API | NestJS 10 + TypeScript (strict) | `src/` |
| Persistence | Prisma 5 + PostgreSQL 16 | `prisma/` |
| Tests | Jest 29 + Supertest (e2e against Postgres) | `test/` |
| Workbench UI | React 18 + Vite 6 + TailwindCSS | `web/` |
| Architecture docs | One-pager + six ADRs | `docs/` |

The three modules in scope:

- **FNOL intake** — four channel-specific normalisers (`agent`, `mobile`, `broker`, `email`) deposit into one `Claim` shape, with prefecture validation, APPI consent capture, and severity classification.
- **Adjuster Workbench** — assign / reassign, immutable notes, evidence with content-hash, witness statements with `inkan_seal_hash`, and a guarded claim-status finite-state machine.
- **Reserves Management** — IFRS17-category reserves in `Decimal(15,0)` JPY, tiered approval (≤¥1M self / ≤¥10M manager / >¥10M claims-director), JFSA threshold notification at ¥100M, and an IFRS17-ready export.

## Architecture at a glance

```
┌──────────────────┐    ┌──────────────────────────────────────┐    ┌──────────────────┐
│  Workbench (Vite)│───▶│  NestJS API (this repo)              │───▶│  PostgreSQL 16   │
│  React + Tailwind│    │  ┌────────┬────────┬────────┬──────┐ │    │  Prisma schema   │
└──────────────────┘    │  │ Auth   │ Claims │Reserves│ Audit│ │    └──────────────────┘
         │              │  ├────────┴────────┴────────┴──────┤ │
         │              │  │ APPI · FSM · PII-mask · Encrypt │ │
         │              │  └─────────────────────────────────┘ │
         │              │  Helmet · Throttler · Pino · Swagger │
         └─────────────▶│  /docs   /auth   /claims   /reserves │
                        └──────────────────────────────────────┘
```

See `docs/ARCHITECTURE.md` for the full one-page narrative and `docs/adr/` for the six decision records.

## Prerequisites

- **Node.js 20+** (the API uses ESM-style Nest 10; the workbench uses Vite 6).
- **PostgreSQL 16** — local install, Docker, or any managed equivalent. SQLite is *not* supported (the schema uses Postgres-only types: `Decimal`, `Bytea`).
- **npm 10+** (bundled with Node 20).

A local Postgres for development can be brought up with:

```bash
docker run --name yotsuba-pg -e POSTGRES_PASSWORD=yotsuba \
  -e POSTGRES_DB=yotsuba_claims -p 5432:5432 -d postgres:16
```

## Quick start

```bash
# 1. install dependencies
npm install

# 2. configure environment
cp .env.example .env
# edit .env — set DATABASE_URL, JWT_SECRET, PII_KEK

# 3. generate Prisma client + run migrations
npx prisma generate
npx prisma migrate deploy

# 4. seed reference data + 20 sample claims
npm run seed

# 5. start the API (port 3000)
npm run start:dev

# 6. in a second terminal, start the workbench (port 5173)
cd web && npm install && npm run dev
```

Open:

- API docs (Swagger): <http://localhost:3000/docs>
- Workbench UI: <http://localhost:5173>
- Default credentials (from `prisma/seed.ts`): `manager.tanaka` / `Password123!` (manager + claims-director), `adjuster.sato` / `Password123!`, `auditor.yamada` / `Password123!`.

## Environment variables

Every variable is documented in `.env.example`. The required set:

| Variable | Required | Example | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | ✓ | `postgresql://postgres:yotsuba@localhost:5432/yotsuba_claims?schema=public` | Prisma connection string |
| `JWT_SECRET` | ✓ | 64-byte random hex | HS256 signing key for `/auth/login` tokens |
| `JWT_TTL_SECONDS` | — | `3600` | Token lifetime (default 1h) |
| `PII_KEK` | ✓ | 32-byte base64 (AES-256 key) | Envelope KEK for special-care PII (APPI Article 17) — government IDs, bank accounts, injury details, phones |
| `PORT` | — | `3000` | API listen port |
| `CORS_ORIGIN` | — (prod) | `https://workbench.example.com` | Comma-separated allow-list in production; permissive in dev |
| `PRISMA_LOG_QUERIES` | — | `false` | Set to `true` for query-level logs; off by default to avoid logging PII |
| `NODE_ENV` | — | `development` | Standard |

Generate a `PII_KEK` quickly with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**Do not rotate `PII_KEK` without re-encrypting** the `*_ct` columns — there is no key-versioning header in Track A (tracked in Track B alongside real KMS integration).

## Database — Prisma + Postgres

The schema is the single source of truth at `prisma/schema.prisma`. The shape captures the domain rigour a Japanese P&C reviewer would expect:

- **Currency is `Decimal(15,0)`** — no `number` for yen anywhere in the stack.
- **Special-care PII (APPI Article 17)** is stored encrypted in `Bytes` columns suffixed `_ct` (government ID, bank account, injury details, phones). Standard PII (name, email, postal) is cleartext and role-masked at the response layer.
- **`inkan_seal_hash`** on `WitnessStatement` is the digital seal — sha-256 over the canonical statement body + timestamp.
- **`AuditEvent`** is append-only by code convention (ADR-002); no UPDATE/DELETE pathway exists. Production hardening (Postgres row-level security + a trigger raising on mutation) is Track B.

Common commands:

```bash
npx prisma generate          # regenerate the client after a schema edit
npx prisma migrate dev       # author a new migration in development
npx prisma migrate deploy    # apply migrations in CI / production
npx prisma studio            # introspect the database in a browser
```

## Seed data

`prisma/seed.ts` populates a deterministic dataset for development, demos, and integration tests:

- 1 admin (`admin`)
- 2 managers (one of them `is_claims_director=true`)
- 3 additional managers eligible for the claims-director gate
- 5 adjusters
- 1 auditor
- 1 SIU referrer
- 20 sample claims spanning every `incident_type` value and every workflow state, with mixed channels, severities, attached notes, evidence, witness statements, and reserves at every approval tier

Run it with:

```bash
npm run seed
```

The script is idempotent — it upserts on `username` and skips existing claim IDs — so it is safe to re-run during development.

## Running the API

```bash
npm run start:dev       # watch mode, Pino pretty logs
npm run build           # tsc to dist/
npm run start:prod      # node dist/main.js (uses NODE_ENV=production)
```

The service exposes:

- `GET /docs` — Swagger UI with persistent bearer-token authorisation
- `GET /docs-json` — raw OpenAPI 3 spec
- All routes listed in `design.md §2`

Every response carries `X-Request-Id` and `X-Correlation-Id` headers; the correlation id is propagated into every `AuditEvent` row so the chain *agent intake → adjuster note → reserve proposal → manager approval* is reconstructible end-to-end.

## Running the Adjuster Workbench

```bash
cd web
npm install
npm run dev             # Vite dev server on :5173, proxies /api → :3000
npm run build           # static build to web/dist/
npm run preview         # serve the build locally
```

The UI is English-only by design (Track A explicitly does not ship Japanese localisation), but Japanese canonical terms appear where they are the industry word: `inkan_seal_hash`, prefecture (`都道府県`), `本人/家族/代理店/事故相手方` relation labels.

Four pages:

- `/login` — JWT issuance
- `/queue` — filterable claim queue (status, severity, channel, age)
- `/claims/:id` — timeline, notes, evidence gallery, witness statements, reserve breakdown, quick actions
- `/approvals` — reserve approval workflow for managers
- `/audit` — auditor view

## Tests, linting, and verification

```bash
npm test                # full Jest suite (unit + e2e against Postgres)
npm run test:watch      # watch mode
npm run test:cov        # coverage report
npm run lint            # eslint . — zero errors expected
npm run typecheck       # tsc --noEmit
```

The e2e suites in `test/` require a running Postgres reachable at `DATABASE_URL`. They use a dedicated schema namespace and roll the database back between files via Prisma's transactional cleanup helpers.

The orchestrator's release gate is:

```bash
node tools/verify.mjs --study=yotsuba-claims --pass=<pass-id>
```

Which runs `npm install`, `npm test`, `npm run lint`, and a smoke-curl over the three module endpoints.

## API surface — three-module curl tour

Every example assumes the API is on `localhost:3000` and you have a token from `/auth/login`:

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"adjuster.sato","password":"Password123!"}' \
  | jq -r .access_token)
```

### 1. FNOL — create a claim (agent channel)

```bash
curl -s -X POST http://localhost:3000/claims \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "policy_number": "AUT-2024-0001",
    "loss_date": "2024-09-12T03:14:00Z",
    "loss_location_prefecture": "東京都",
    "loss_location_postal_code": "100-0001",
    "loss_location_detail": "千代田区千代田1-1",
    "reported_by_channel": "agent",
    "reporter_name": "鈴木 一郎",
    "reporter_phone": "+81-90-1234-5678",
    "reporter_email": "suzuki@example.jp",
    "reporter_relation_to_insured": "本人",
    "incident_type": "auto_collision",
    "initial_description": "信号待ちで追突された。怪我なし。",
    "injury_reported": false,
    "third_party_involved": true,
    "appi_consent_version": "2024-04-01",
    "appi_consent_at": "2024-09-12T03:15:00Z"
  }' | jq
```

Returns the created claim with `severity_initial` classified and an `AuditEvent` written under `action="claim.created"`.

### 2. Adjuster Workbench — append a note and transition status

```bash
CLAIM_ID=clxxxxxxxxxxxxxxxxxxxxxxx   # from the FNOL response

curl -s -X POST http://localhost:3000/claims/$CLAIM_ID/notes \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"body":"現場写真と警察報告書を確認済み。"}' | jq

curl -s -X PATCH http://localhost:3000/claims/$CLAIM_ID/status \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"to":"under_investigation","reason":"Evidence in hand; opening investigation."}' | jq
```

The FSM (`src/claims/claims-status.fsm.ts`) rejects illegal transitions with HTTP 422 and a human-readable reason.

### 3. Reserves — propose, approve, and export

```bash
# Propose a ¥15,000,000 reserve (over the ¥10M ceiling — requires claims-director).
RESERVE=$(curl -s -X POST http://localhost:3000/claims/$CLAIM_ID/reserves \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "category": "loss_unpaid",
    "proposed_yen": "15000000",
    "justification": "Estimated third-party bodily injury exposure based on prelim medical assessment and prior loss patterns for similar collisions."
  }')
RESERVE_ID=$(echo $RESERVE | jq -r .id)

# Switch to a manager who is also claims-director.
DIRECTOR_TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"manager.tanaka","password":"Password123!"}' | jq -r .access_token)

# Manager-tier approval is *not enough* at ¥15M; it must be director-approved.
curl -s -X POST http://localhost:3000/reserves/$RESERVE_ID/director-approve \
  -H "Authorization: Bearer $DIRECTOR_TOKEN" | jq

# IFRS17-ready export for the actuarial pipeline.
AUDITOR_TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"auditor.yamada","password":"Password123!"}' | jq -r .access_token)

curl -s "http://localhost:3000/reserves/export?period=2024-09" \
  -H "Authorization: Bearer $AUDITOR_TOKEN" | jq
```

## Role matrix and PII handling

Five roles, scoped by both ownership and APPI sensitivity tier. The detailed matrix lives in `brief.md`; the short version:

| Role | Reads | Writes |
| --- | --- | --- |
| `agent` | own intake (24h window) | FNOL create only |
| `adjuster` | assigned claims | notes, evidence, witness statements, status (assigned-only), reserves (propose) |
| `manager` | reports' claims | assign / reassign, status (reports' only), reserves (approve ≤¥10M; director-approve if `is_claims_director`) |
| `auditor` | all claims (masked) + audit log + data-subject exports | none |
| `siu_referrer` | flagged claims | fraud flag (Track B expands this) |

PII masking is centralised in `src/common/pii-mask.util.ts` and applied at the response layer by `MaskByAppiInterceptor`. **Standard PII** (name, email, phone, postal address) is stored cleartext and masked in responses by role + ownership. **Special-care PII** (government ID, bank account, injury details) is encrypted at rest under `PII_KEK` and never returned by ordinary read paths — only by `GET /claims/:id/data-subject-export` to `auditor` or `manager` roles.

Demonstrable behaviour: `GET /claims/:id` with an adjuster JWT returns `reporter_phone` cleartext **only if that adjuster is the assigned one**; for any other adjuster it returns a masked form (`+81-90-****-5678`). Tests in `test/claims-workbench.e2e.spec.ts` enforce this.

## Regulatory hooks — APPI · JFSA · IFRS17

Three regulator-shaped surfaces, captured as policy rather than scattered magic numbers:

- **APPI (個人情報保護法).** Consent captured at FNOL (`appi_consent_version`, `appi_consent_at`); special-care PII (Article 17) encrypted with `PII_KEK`; Article 28 disclosure right served by `GET /claims/:id/data-subject-export` returning everything the system holds about an identified individual, across every claim they appear in.
- **JFSA threshold notification.** Any single reserve change crossing **¥100M** writes a `NotificationToRegulator` row (`kind="jfsa_reserve_threshold"`, `sent_at=null`) earmarked for the daily JFSA batch. The POC captures the *event shape* — the wire format is Track B. Pending rows surface at `GET /notifications/jfsa-pending` for auditors.
- **IFRS17 export hook.** `GET /reserves/export?period=YYYY-MM` returns reserve aggregates by category (`loss_paid`, `loss_unpaid`, `alae`, `ulae`) suitable for downstream IFRS17 calculation. No IFRS17 maths happens here — only the data export shape — but the categories and walk-forward structure are correct.

All three thresholds (`¥1M`, `¥10M`, `¥100M`) and the IFRS17 categories live as named constants; see `src/reserves/reserves.service.ts` and ADR-005.

## Audit immutability

Every write — claim create, note, evidence, witness statement, reserve proposal, approval, rejection, status transition, assignment — emits an `AuditEvent` row via the global `AuditInterceptor`. The row carries:

- `actor_id`, `actor_role`
- `action` (e.g. `claim.created`, `reserve.approved`)
- `claim_id`, `target_id`
- `payload_hash` — sha-256 over the normalised request payload, giving content-binding
- `request_id` and `correlation_id` — propagated by `RequestIdMiddleware` + `CorrelationIdMiddleware`
- `ts` — server-side timestamp

The `AuditEvent` table has **no UPDATE or DELETE pathway** in code (ADR-002). The interceptor is the only writer. Auditors read via `GET /audit?from=&to=&actor=&claim_id=&action=`. Production hardening (Postgres RLS + trigger-on-mutation) is tracked for Track B.

## Architecture Decision Records

Six ADRs in `docs/adr/`:

1. **ADR-001** — PII encryption: AES-256-GCM under env KEK, APPI-tier-aware
2. **ADR-002** — Audit log immutability (code convention; prod-tightened in Track B)
3. **ADR-003** — Role masking by APPI tier
4. **ADR-004** — Claim status finite-state machine
5. **ADR-005** — Reserve approval tiers (¥1M / ¥10M / claims-director)
6. **ADR-006** — JFSA notification pattern (event-driven, daily flush)

Plus `docs/ARCHITECTURE.md` for the one-page diagram + flow narrative.

## What is out of scope (Track A)

Deliberately deferred — every item below is Track B and is not stubbed misleadingly:

- Subrogation / recovery
- Fraud / SIU referral workflow (the `siu_referrer` role exists; the module does not)
- Reinsurance ceding signaling
- Compliance reporting (JFSA submission packets, IFRS17 disclosure preparation)
- Real-time treasury payout integration
- Actual blob storage for evidence (we record content-hash + `blob_ref` only)
- SSO / OAuth / SAML (local JWT only)
- Multi-tenancy
- Production deployment artifacts (Dockerfile, k8s manifests)
- Real KMS (env-supplied KEK is acceptable for POC)
- Full Japanese UI localisation (canonical terms only)

## Project layout

```
.
├── README.md                          # this file
├── package.json
├── tsconfig.json
├── .env.example
├── prisma/
│   ├── schema.prisma
│   └── seed.ts
├── src/
│   ├── main.ts                        # bootstrap (Helmet, ValidationPipe, Swagger, shutdown hooks)
│   ├── app.module.ts                  # composition root
│   ├── prisma.service.ts              # singleton Prisma client
│   ├── common/                        # encryption, guards, mask util, audit interceptor, ID middlewares, error filter
│   ├── auth/                          # /auth/login, JWT issuance, /auth/me
│   ├── claims/                        # FNOL channels, workbench actions, status FSM
│   ├── reserves/                      # proposals, approval tiers, JFSA emitter, IFRS17 export
│   ├── audit/                         # auditor read endpoints
│   └── appi/                          # data-subject-export, anonymise
├── test/                              # e2e suites (Postgres-backed)
├── web/                               # Adjuster Workbench (React + Vite + Tailwind)
└── docs/
    ├── ARCHITECTURE.md
    └── adr/                           # six ADRs
```

---

**Licence & confidentiality.** Internal POC; not for distribution. *Yotsuba Insurance Holdings* is a fictional placeholder pending commercial permission to use the real carrier name.