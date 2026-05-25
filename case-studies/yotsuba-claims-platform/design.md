# Design — Yotsuba Insurance · Claims Processing Platform (Track A)

> This is the **reference architecture** produced from `brief.md`. It's authored once by Pass 1 (Opus) and becomes the shared spec every other pass regenerates against. Equivalent-to-Phase-1 role: this is the file the orchestrator hands to Gemini Pro / Flash / Sonnet / Haiku as the source-of-truth specification.

## 1. Data model (Prisma — Postgres)

```prisma
generator client { provider = "prisma-client-js" }
datasource db   { provider = "postgresql"; url = env("DATABASE_URL") }

// ─── identity / RBAC ─────────────────────────────────────────────
model User {
  id                String   @id @default(cuid())
  username          String   @unique
  password_hash     String
  role              UserRole
  display_name      String
  email             String   @unique
  reports_to_id     String?
  reports_to        User?    @relation("Reports", fields: [reports_to_id], references: [id])
  reports           User[]   @relation("Reports")
  is_claims_director Boolean @default(false)
  created_at        DateTime @default(now())
  updated_at        DateTime @updatedAt
  deleted_at        DateTime?
}

enum UserRole { agent  adjuster  manager  auditor  siu_referrer }

// ─── claims ──────────────────────────────────────────────────────
model Claim {
  id                          String      @id @default(cuid())
  policy_number               String
  loss_date                   DateTime
  loss_location_prefecture    String      // 都道府県
  loss_location_postal_code   String
  loss_location_detail        String
  reported_by_channel         IntakeChannel
  reporter_name               String
  reporter_phone_ct           Bytes?      // APPI special-care; encrypted blob
  reporter_email_ct           Bytes?
  reporter_relation_to_insured String     // 本人/家族/代理店/事故相手方 etc.
  incident_type               IncidentType
  initial_description         String
  injury_reported             Boolean     @default(false)
  third_party_involved        Boolean     @default(false)
  police_report_number        String?
  severity_initial            ClaimSeverity
  status                      ClaimStatus @default(intake)
  appi_consent_version        String
  appi_consent_at             DateTime
  assigned_adjuster_id        String?
  assigned_adjuster           User?       @relation(name: "Assignee", fields: [assigned_adjuster_id], references: [id])
  insured_government_id_ct    Bytes?      // APPI Article 17 special-care
  bank_account_for_payout_ct  Bytes?
  injury_details_ct           Bytes?
  created_at                  DateTime    @default(now())
  updated_at                  DateTime    @updatedAt

  notes             ClaimNote[]
  evidence          Evidence[]
  witness_statements WitnessStatement[]
  reserves          Reserve[]
  audit_events      AuditEvent[]

  @@index([assigned_adjuster_id, status])
  @@index([incident_type, status])
  @@index([loss_date])
}

enum IntakeChannel { agent  mobile  broker  email }
enum IncidentType  {
  auto_collision  auto_property_damage
  fire_residential  fire_commercial
  marine_cargo  liability_premises  personal_accident
}
enum ClaimSeverity { simple  complex  catastrophic }
enum ClaimStatus   {
  intake  under_investigation  awaiting_reserve_approval
  settlement_offered  closed_paid  closed_denied  reopened
}

// ─── notes / evidence / witnesses (immutable append-only) ────────
model ClaimNote {
  id          String   @id @default(cuid())
  claim_id    String
  claim       Claim    @relation(fields: [claim_id], references: [id])
  author_id   String
  body        String
  created_at  DateTime @default(now())
  @@index([claim_id, created_at])
}

model Evidence {
  id              String   @id @default(cuid())
  claim_id        String
  claim           Claim    @relation(fields: [claim_id], references: [id])
  kind            EvidenceKind
  content_hash    String   // sha-256 of the blob; blob storage stubbed
  blob_ref        String   // s3://stub/...
  uploaded_by_id  String
  uploaded_at     DateTime @default(now())
}
enum EvidenceKind { photo  document  audio  video  witness_statement_attachment }

model WitnessStatement {
  id              String   @id @default(cuid())
  claim_id        String
  claim           Claim    @relation(fields: [claim_id], references: [id])
  witness_name    String
  witness_phone_ct Bytes?
  statement_body  String
  inkan_seal_hash String   // digital seal — sha-256 of canonical statement+timestamp
  recorded_by_id  String
  recorded_at     DateTime @default(now())
}

// ─── reserves ────────────────────────────────────────────────────
model Reserve {
  id                String          @id @default(cuid())
  claim_id          String
  claim             Claim           @relation(fields: [claim_id], references: [id])
  category          ReserveCategory
  proposed_yen      Decimal         @db.Decimal(15,0)
  prior_yen         Decimal?        @db.Decimal(15,0)
  justification     String
  proposed_by_id    String
  proposed_at       DateTime        @default(now())
  approval_status   ApprovalStatus  @default(pending)
  approved_by_id    String?
  approved_at       DateTime?
  director_approved_by_id String?
  director_approved_at    DateTime?
  reason_for_rejection    String?

  @@index([claim_id, proposed_at])
  @@index([approval_status])
}
enum ReserveCategory { loss_paid  loss_unpaid  alae  ulae }
enum ApprovalStatus  { pending  approved  rejected }

// ─── notifications (JFSA threshold) ──────────────────────────────
model NotificationToRegulator {
  id          String   @id @default(cuid())
  kind        String   // "jfsa_reserve_threshold"
  claim_id    String
  reserve_id  String
  amount_yen  Decimal  @db.Decimal(15,0)
  triggered_at DateTime @default(now())
  sent_at     DateTime?  // null until daily batch flushes
}

// ─── audit (append-only) ─────────────────────────────────────────
model AuditEvent {
  id              String   @id @default(cuid())
  actor_id        String
  actor_role      UserRole
  action          String   // e.g. "claim.created", "reserve.approved", "evidence.added"
  claim_id        String?
  claim           Claim?   @relation(fields: [claim_id], references: [id])
  target_id       String?
  payload_hash    String   // sha-256 of normalized event payload
  request_id      String
  correlation_id  String
  ts              DateTime @default(now())

  @@index([actor_id, ts])
  @@index([claim_id, ts])
  @@index([action, ts])
}
```

## 2. API contract

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | /auth/login | none | `{username, password}` → `{access_token, role}` |
| GET  | /auth/me | jwt | current user |
| POST | /claims | jwt(agent\|adjuster) | FNOL intake; channel-specific normalisation |
| POST | /claims/mobile | jwt(agent) | Mobile-app channel normaliser |
| POST | /claims/broker | jwt(agent) | Broker channel normaliser |
| POST | /claims/email-parse | jwt(agent) | Email-parser channel; idempotent on `Message-Id` |
| GET  | /claims | jwt(any) | Role-scoped list with filters: status, severity, channel, assignee |
| GET  | /claims/:id | jwt(any) | Role-masked detail |
| POST | /claims/:id/assign | jwt(manager) | Body: `{adjuster_id, reason_for_reassignment?}` |
| POST | /claims/:id/notes | jwt(adjuster\|manager) | Append-only note |
| POST | /claims/:id/evidence | jwt(adjuster) | Body: `{kind, content_hash, blob_ref}` |
| POST | /claims/:id/witness-statement | jwt(adjuster) | Body: `{witness_name, witness_phone?, statement_body, inkan_seal_hash}` |
| PATCH | /claims/:id/status | jwt(adjuster\|manager) | Body: `{to: ClaimStatus, reason}` — state-machine-guarded |
| GET  | /claims/:id/data-subject-export | jwt(auditor\|manager) | APPI Article 28 |
| POST | /claims/:id/reserves | jwt(adjuster) | Body: `{category, proposed_yen, justification}` |
| GET  | /claims/:id/reserves | jwt(any) | History |
| POST | /reserves/:id/approve | jwt(manager) | Manager approves up to ¥10M |
| POST | /reserves/:id/director-approve | jwt(manager + is_claims_director) | Required for >¥10M |
| POST | /reserves/:id/reject | jwt(manager) | Body: `{reason_for_rejection}` |
| GET  | /reserves/export | jwt(auditor) | Query: `?period=YYYY-MM` — IFRS17-ready aggregates |
| GET  | /audit | jwt(auditor) | Query: `?from=&to=&actor=&claim_id=&action=` |
| GET  | /notifications/jfsa-pending | jwt(auditor) | Pending JFSA threshold notifications |

## 3. Module structure

```
src/
├── main.ts                                 # bootstrap
├── app.module.ts
├── prisma.service.ts
├── common/
│   ├── encryption.ts                       # AES-256-GCM via env KEK (Phase 1 carry-over)
│   ├── jwt-auth.guard.ts
│   ├── roles.guard.ts
│   ├── roles.decorator.ts
│   ├── current-user.decorator.ts
│   ├── pii-mask.util.ts                    # APPI-tier-aware masking
│   ├── audit.interceptor.ts                # writes AuditEvent on annotated routes
│   ├── audit.decorator.ts                  # @Audit({action: 'claim.note.add'})
│   ├── error.filter.ts
│   ├── request-id.middleware.ts
│   └── correlation-id.middleware.ts        # NEW — propagates correlation_id from headers
├── auth/
│   ├── auth.module.ts
│   ├── auth.controller.ts
│   ├── auth.service.ts
│   └── dto/login.dto.ts
├── claims/
│   ├── claims.module.ts
│   ├── claims.controller.ts                # all 8 routes for the claim resource
│   ├── claims.service.ts                   # incl. severity classifier, status-machine
│   ├── claims-channel.service.ts           # channel-specific intake normalisers
│   ├── claims-status.fsm.ts                # pure state-machine
│   └── dto/
│       ├── create-claim.dto.ts
│       ├── update-status.dto.ts
│       ├── assign-claim.dto.ts
│       ├── add-note.dto.ts
│       ├── add-evidence.dto.ts
│       └── add-witness-statement.dto.ts
├── reserves/
│   ├── reserves.module.ts
│   ├── reserves.controller.ts
│   ├── reserves.service.ts                 # approval rules, JFSA threshold emitter
│   ├── reserves-jfsa.service.ts            # NotificationToRegulator producer
│   ├── reserves-export.service.ts          # IFRS17 aggregator
│   └── dto/
│       ├── propose-reserve.dto.ts
│       └── reject-reserve.dto.ts
├── audit/
│   ├── audit.module.ts
│   ├── audit.controller.ts
│   └── audit.service.ts
└── appi/
    ├── appi.module.ts
    ├── appi.service.ts                     # data-subject-export aggregator, anonymise
    └── dto/anonymise-request.dto.ts

prisma/
├── schema.prisma
└── seed.ts                                  # admin, managers, adjusters, auditor, 20 sample claims

test/
├── auth.e2e.spec.ts
├── claims-fnol.e2e.spec.ts                 # all 4 channels + validation failures + APPI consent
├── claims-workbench.e2e.spec.ts            # assign, note, evidence, witness, status FSM, role-masking
├── reserves.e2e.spec.ts                    # approval thresholds, IFRS17 export shape, JFSA notification
└── appi.e2e.spec.ts                        # data-subject-export

web/                                         # Adjuster Workbench
├── package.json
├── vite.config.ts
├── tsconfig.json
├── tailwind.config.cjs
├── index.html
└── src/
    ├── main.tsx
    ├── App.tsx
    ├── styles.css
    ├── lib/
    │   ├── api.ts                          # fetch wrapper, JWT
    │   ├── auth.tsx
    │   └── format-yen.ts                   # ¥ formatter, prefecture lookups
    ├── components/
    │   ├── Layout.tsx
    │   ├── RoleBadge.tsx
    │   ├── ClaimStatusPill.tsx
    │   ├── SeverityPill.tsx
    │   └── EvidenceGallery.tsx
    └── pages/
        ├── Login.tsx
        ├── ClaimQueue.tsx                  # filterable claim list
        ├── ClaimDetail.tsx                 # timeline + notes + evidence + reserves
        ├── ReserveApprovals.tsx            # manager workflow
        └── AuditLog.tsx                    # auditor view

docs/
├── adr/
│   ├── 001-encryption.md                   # carry from Phase 1, restate with APPI framing
│   ├── 002-audit-immutability.md
│   ├── 003-role-masking-by-appi-tier.md    # NEW
│   ├── 004-claim-status-fsm.md             # NEW
│   ├── 005-reserve-approval-tiers.md       # NEW
│   └── 006-jfsa-notification-pattern.md    # NEW
└── ARCHITECTURE.md                         # one-page diagram + flow narrative
```

## 4. ADRs (capsule)

### ADR-001: PII encryption — AES-256-GCM, APPI-tier-aware
- **Context:** APPI Article 17 specifies stricter handling for *special-care personal information* (government IDs, medical, bank). Standard PII (name, email) gets cleartext-with-masking; special-care gets encryption.
- **Decision:** Reuse the Phase 1 envelope (per-record DEK + env KEK + AES-256-GCM blob). All `_ct` fields are special-care PII; cleartext fields are standard PII and rely on response-time masking via `pii-mask.util.ts`.
- **Consequence:** Single function (`maskByAppiTier`) is the source of truth for what gets returned to whom.

### ADR-002: Audit log immutability (POC convention, prod-tightened)
- **Context:** Auditors must trust the audit log. Insurance regulators expect tamper-evident audit.
- **Decision:** No UPDATE/DELETE path in code for `AuditEvent` rows. Documented; tested by grep. Production hardening (Postgres RLS + trigger that raises on UPDATE/DELETE) tracked in Track B.
- **Consequence:** Audit interceptor is the single writer; payload_hash gives content-binding.

### ADR-003: Role masking by APPI tier
- **Context:** The same claim record must return different field sets to agent / adjuster / manager / auditor / SIU referrer.
- **Decision:** Service returns full record; controller-level `MaskByAppiInterceptor` strips/redacts based on `caller.role` + APPI tier of each field + claim ownership (assigned adjuster gets cleartext; other adjusters see masked).
- **Consequence:** Adding a new sensitive field = one line in `pii-mask.util.ts`. Tests cover each role × each field.

### ADR-004: Claim status finite-state machine
- **Context:** Workflow states have legal/illegal transitions. Without a pure FSM, business logic spreads everywhere.
- **Decision:** `claims-status.fsm.ts` is a pure function `(from, to, claim, actor) → {ok, reason}`. The controller refuses illegal transitions with 422 + the FSM's reason. Tests cover the matrix.
- **Consequence:** All workflow logic in one auditable file.

### ADR-005: Reserve approval tiers
- **Context:** Different reserve amounts require different approver levels (industry standard).
- **Decision:** Tiers are policy, not config: `≤¥1M` self-approving, `¥1M–¥10M` manager-approve, `>¥10M` requires `claims_director`. Encoded in `reserves.service.ts`. Pure function.
- **Consequence:** Threshold changes are one-line edits with tests.

### ADR-006: JFSA notification pattern (event-driven, daily flush)
- **Context:** JFSA expects daily notification of reserves crossing thresholds. We don't actually call JFSA in POC.
- **Decision:** Reserve service emits `NotificationToRegulator` rows synchronously when threshold crossed; a (future) daily job aggregates and flushes. The POC captures the *event shape* — the regulatory wire format is Track B.
- **Consequence:** Reviewable evidence that thresholds are detected; no false credibility about wire-format compliance.

## 5. Sequencing for the orchestrator

Build in this dependency order (each depends on prior):
1. `common/*` + `prisma.service` (foundation)
2. `auth/*`
3. `audit/*` (interceptor needs this)
4. `claims/*` — the spine
5. `reserves/*` (depends on claims)
6. `appi/*` (data-subject-export needs everything else)
7. Tests for each module as it lands
8. Workbench UI (depends on the API being stable)
9. ADRs + ARCHITECTURE.md
10. Seed data + curl examples in README

## 6. What's deliberately unique to Yotsuba (vs Phase 1's Workforce Ops)

- **Domain-specific schema fields** that exist nowhere in a generic CRUD app: `inkan_seal_hash`, `appi_consent_version`, `case_reserve_yen` with `Decimal @db.Decimal(15,0)` (no float currency), `prefecture` validated against a known list.
- **Regulatory thresholds encoded as policy**, not magic numbers — every JFSA / IFRS17 / APPI rule is a named constant in a single config module.
- **An actual FSM** for claim status with reasoned rejections; not a `string` status with anyone-can-set semantics.
- **Decimal-typed currency end-to-end** — no `number` for yen anywhere in the stack.
- **Correlation IDs across services** — every request has a `correlation_id` propagated through every audit event, so the full chain of "agent intake → adjuster note → reserve proposal → approval" is reconstructible.

Each of these is a thing a Japanese P&C reviewer would expect to see and a generic CRUD POC would miss.
