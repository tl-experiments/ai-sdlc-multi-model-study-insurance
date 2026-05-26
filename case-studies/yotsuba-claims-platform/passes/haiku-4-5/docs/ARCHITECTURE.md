# Architecture — Yotsuba Insurance Claims Processing Platform (Track A)

> One-page reference architecture for the first-notice-of-loss-to-settlement claims lifecycle. Produced from `brief.md` and `design.md`. This document is the visual and narrative companion to the locked specification.

## System Context

The Yotsuba Claims Platform sits between upstream policy/fraud systems and downstream treasury/reinsurance systems. It is the **claims spine**: intake, triage, investigation, reserves, and settlement for personal & commercial P&C claims at a Japanese insurance carrier.

```
┌─────────────────────────────────────────────────────────────────────┐
│                    External Systems (Stubs)                         │
├─────────────────────────────────────────────────────────────────────┤
│  Policy Service (lookup)  │  Fraud/SIU (Track B)  │  Treasury/Reins │
└────────────┬──────────────────────────────────────────────┬─────────┘
             │                                              │
             ▼                                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  Yotsuba Claims Platform (Track A)                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  FNOL Intake (4 channels)                                    │  │
│  │  • Agent (call centre)  • Mobile app  • Broker  • Email      │  │
│  │  → Unified Claim record + severity classification            │  │
│  │  → APPI consent capture                                      │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                           │                                         │
│                           ▼                                         │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Adjuster Workbench                                          │  │
│  │  • Claim assignment & reassignment                           │  │
│  │  • Notes (immutable append-only)                             │  │
│  │  • Evidence (photo, document, audio, video)                  │  │
│  │  • Witness statements (with inkan_seal_hash)                 │  │
│  │  • Status workflow (FSM-guarded state machine)               │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                           │                                         │
│                           ▼                                         │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Reserves Management                                         │  │
│  │  • Propose reserve (loss_paid, loss_unpaid, alae, ulae)      │  │
│  │  • Approval tiers: ≤¥1M auto, ¥1M–¥10M manager, >¥10M dir.   │  │
│  │  • JFSA threshold notification (¥100M crossing)              │  │
│  │  • IFRS17 export (period aggregates)                         │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                           │                                         │
│                           ▼                                         │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Audit Log (immutable append-only)                           │  │
│  │  • Every write → AuditEvent (actor, action, payload_hash)    │  │
│  │  • request_id + correlation_id for traceability              │  │
│  │  • Auditor-only read access                                  │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                           │                                         │
│                           ▼                                         │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  APPI Compliance                                             │  │
│  │  • Data-subject export (Article 28)                          │  │
│  │  • PII encryption (special-care: gov ID, medical, bank)      │  │
│  │  • Role-based masking (standard PII in API responses)        │  │
│  │  • Anonymisation (Track B)                                   │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
             │                                              │
             ▼                                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    PostgreSQL 16 (Prisma ORM)                       │
├─────────────────────────────────────────────────────────────────────┤
│  User  │  Claim  │  ClaimNote  │  Evidence  │  WitnessStatement    │
│  Reserve  │  AuditEvent  │  NotificationToRegulator                 │
└─────────────────────────────────────────────────────────────────────┘
```

## Request Flow — FNOL to Settlement

```
1. FNOL Intake
   Agent/Mobile/Broker/Email
        │
        ▼
   POST /claims
        │
        ├─ Validate policy_number (Policy Service stub)
        ├─ Validate loss_date (within policy window)
        ├─ Validate loss_location (prefecture)
        ├─ Classify severity (simple/complex/catastrophic)
        ├─ Capture APPI consent
        └─ Emit AuditEvent(claim.created)
        │
        ▼
2. Assignment
   Manager
        │
        ▼
   POST /claims/:id/assign
        │
        ├─ Assign adjuster
        └─ Emit AuditEvent(claim.assigned)
        │
        ▼
3. Investigation
   Adjuster
        │
        ├─ POST /claims/:id/notes (immutable)
        ├─ POST /claims/:id/evidence (photo/document/audio/video)
        ├─ POST /claims/:id/witness-statement (inkan_seal_hash)
        ├─ PATCH /claims/:id/status (FSM-guarded)
        └─ Emit AuditEvent(note.added, evidence.added, status.changed)
        │
        ▼
4. Reserve Proposal
   Adjuster
        │
        ▼
   POST /claims/:id/reserves
        │
        ├─ Propose reserve (category, proposed_yen, justification)
        ├─ Check approval tier (¥1M, ¥10M thresholds)
        ├─ If ¥100M crossing: emit NotificationToRegulator
        └─ Emit AuditEvent(reserve.proposed)
        │
        ▼
5. Reserve Approval
   Manager / Claims Director
        │
        ├─ ≤¥1M: auto-approved
        ├─ ¥1M–¥10M: POST /reserves/:id/approve (manager)
        ├─ >¥10M: POST /reserves/:id/director-approve (claims-director)
        └─ Emit AuditEvent(reserve.approved)
        │
        ▼
6. Settlement
   Adjuster → PATCH /claims/:id/status → closed_paid | closed_denied
        │
        └─ Emit AuditEvent(claim.closed)

7. Audit Trail
   Auditor → GET /audit (query all events by claim_id, actor, action, ts)
```

## Module Dependencies

```
common/
  ├─ encryption.ts (AES-256-GCM, APPI-tier-aware)
  ├─ jwt-auth.guard.ts
  ├─ roles.guard.ts
  ├─ pii-mask.util.ts (response-time masking)
  ├─ audit.interceptor.ts (writes AuditEvent)
  ├─ error.filter.ts (standardised error envelope)
  ├─ request-id.middleware.ts
  └─ correlation-id.middleware.ts
       │
       ▼
  auth/
    ├─ auth.controller.ts (POST /auth/login, GET /auth/me)
    ├─ auth.service.ts (JWT signing, password hashing)
    └─ dto/login.dto.ts
       │
       ▼
  claims/
    ├─ claims.controller.ts (8 routes: FNOL, assign, notes, evidence, witness, status)
    ├─ claims.service.ts (severity classifier, status FSM)
    ├─ claims-channel.service.ts (4 channel normalisers)
    ├─ claims-status.fsm.ts (pure state machine)
    └─ dto/ (create, assign, note, evidence, witness, status)
       │
       ▼
  reserves/
    ├─ reserves.controller.ts (propose, approve, director-approve, reject, export)
    ├─ reserves.service.ts (approval rules, JFSA threshold)
    ├─ reserves-jfsa.service.ts (NotificationToRegulator producer)
    ├─ reserves-export.service.ts (IFRS17 aggregator)
    └─ dto/ (propose, reject)
       │
       ▼
  audit/
    ├─ audit.controller.ts (GET /audit with filters)
    ├─ audit.service.ts (query AuditEvent)
    └─ (no DTOs; read-only)
       │
       ▼
  appi/
    ├─ appi.service.ts (data-subject-export, anonymise)
    ├─ appi.controller.ts (GET /claims/:id/data-subject-export, POST anonymise)
    └─ dto/ (anonymise-request)
```

## Role Matrix

| Resource × Action | `agent` | `adjuster` | `manager` | `auditor` | `siu_referrer` |
|---|---|---|---|---|---|
| FNOL — create | ✓ (own) | — | — | — | — |
| Claim — read | own (24h) | assigned | reports' | all (masked) | flagged |
| Claim — note add | — | assigned | reports' | — | — |
| Claim — evidence add | — | assigned | — | — | — |
| Claim — status transition | — | assigned | reports' | — | — |
| Claim — assign | — | — | reports' pool | — | — |
| Reserve — propose | — | assigned | reports' | — | — |
| Reserve — approve (≤¥10M) | — | — | reports' | — | — |
| Reserve — director-approve (>¥10M) | — | — | claims-director only | — | — |
| Audit log — read | — | — | — | ✓ (all) | — |
| Data-subject export | — | — | reports' | ✓ | — |

## PII Protection (APPI Tiers)

### Standard PII (cleartext + role-based masking)
- `reporter_name` — stored cleartext; masked for non-assigned adjusters
- `reporter_phone` — encrypted at rest; masked in API for non-assigned adjusters
- `reporter_email` — encrypted at rest; masked in API for non-assigned adjusters
- `loss_location_detail` — stored cleartext; masked at prefecture-only granularity for non-adjuster roles

### Sensitive PII (cleartext + role-based masking)
- `policy_number` — stored cleartext; masked for non-manager/auditor roles

### Special-Care PII (AES-256-GCM encrypted, never in API)
- `insured_government_id_ct` — APPI Article 17; only via `GET /claims/:id/data-subject-export`
- `bank_account_for_payout_ct` — APPI Article 17; only via data-subject-export
- `injury_details_ct` — medical info; only via data-subject-export
- `reporter_phone_ct` — encrypted blob (dual storage with cleartext for masking)
- `reporter_email_ct` — encrypted blob (dual storage with cleartext for masking)
- `witness_phone_ct` — encrypted blob

**Masking function:** `maskByAppiTier(record, caller.role, claim.assigned_adjuster_id)` is the single source of truth. Applied at controller layer before response serialization.

## Claim Status Finite-State Machine

```
                    ┌─────────────────────────────────────┐
                    │         intake (initial)            │
                    └────────────────┬────────────────────┘
                                     │
                                     ▼
                    ┌─────────────────────────────────────┐
                    │     under_investigation             │
                    └────────────────┬────────────────────┘
                                     │
                                     ▼
                    ┌─────────────────────────────────────┐
                    │   awaiting_reserve_approval         │
                    └────────────────┬────────────────────┘
                                     │
                                     ▼
                    ┌─────────────────────────────────────┐
                    │      settlement_offered             │
                    └────────────────┬────────────────────┘
                                     │
                    ┌────────────────┴────────────────┐
                    │                                 │
                    ▼                                 ▼
        ┌──────────────────────┐        ┌──────────────────────┐
        │    closed_paid       │        │   closed_denied      │
        └──────────────────────┘        └──────────────────────┘
                    │                                 │
                    └────────────────┬────────────────┘
                                     │
                                     ▼
                    ┌─────────────────────────────────────┐
                    │         reopened (optional)         │
                    └─────────────────────────────────────┘

Guards:
  • intake → under_investigation: adjuster assigned
  • under_investigation → awaiting_reserve_approval: reserve proposed
  • awaiting_reserve_approval → settlement_offered: reserve approved
  • settlement_offered → closed_paid | closed_denied: adjuster decision
  • closed_* → reopened: manager decision (Track B)

Illegal transitions return 422 with FSM reason.
```

## Reserve Approval Tiers

```
Proposed Amount          Approval Path                  Auto-Approve?
─────────────────────────────────────────────────────────────────────
≤ ¥1,000,000            Adjuster proposes              Yes (immediate)

¥1,000,001–¥10,000,000  Adjuster proposes              No
                        Manager approves
                        (POST /reserves/:id/approve)

> ¥10,000,000           Adjuster proposes              No
                        Manager approves
                        Claims-director approves
                        (POST /reserves/:id/director-approve)

JFSA Threshold:
  Any reserve change crossing ¥100,000,000
  → Emit NotificationToRegulator (event shape captured; wire format Track B)
```

## Audit Event Envelope

Every write operation emits an immutable `AuditEvent`:

```typescript
interface AuditEvent {
  id: string;                    // cuid()
  actor_id: string;              // User.id
  actor_role: UserRole;          // agent | adjuster | manager | auditor | siu_referrer
  action: string;                // e.g., "claim.created", "reserve.approved"
  claim_id?: string;             // associated claim (if applicable)
  target_id?: string;            // e.g., reserve_id, note_id
  payload_hash: string;          // SHA-256 of normalized event payload
  request_id: string;            // unique per HTTP request
  correlation_id: string;        // propagated across service boundaries
  ts: DateTime;                  // timestamp
}
```

**Immutability guarantee:** No UPDATE or DELETE path in code. Documented in ADR-002. Production hardening (Postgres RLS + trigger) in Track B.

## APPI Data-Subject Export

`GET /claims/:id/data-subject-export` (manager or auditor only) returns:

```json
{
  "subject_identifier": "reporter_name=田中太郎",
  "export_generated_at": "2024-01-15T11:00:00Z",
  "claims": [
    {
      "claim_id": "clm_abc123",
      "policy_number": "POL-2024-001234",
      "reporter_name": "田中太郎",
      "reporter_phone": "09012345678",
      "reporter_email": "tanaka@example.com",
      "insured_government_id": "1234567890123",
      "bank_account_for_payout": "1234567890",
      "injury_details": "...",
      "loss_location_detail": "Chiyoda Ward, Tokyo",
      "incident_type": "auto_collision",
      "initial_description": "...",
      "created_at": "2024-01-15T10:35:00Z"
    }
  ]
}
```

All special-care PII is decrypted and included (APPI Article 28 disclosure right). Auditor-only in production; manager-only for own reports in POC.

## IFRS17 Export

`GET /reserves/export?period=YYYY-MM` (auditor only) returns:

```json
{
  "period": "2024-01",
  "aggregates": [
    {
      "category": "loss_paid",
      "total_yen": "12500000",
      "count": 5,
      "average_yen": "2500000"
    },
    {
      "category": "loss_unpaid",
      "total_yen": "45000000",
      "count": 12,
      "average_yen": "3750000"
    },
    {
      "category": "alae",
      "total_yen": "2000000",
      "count": 8,
      "average_yen": "250000"
    },
    {
      "category": "ulae",
      "total_yen": "1500000",
      "count": 1,
      "average_yen": "1500000"
    }
  ]
}
```

No actual IFRS17 calculation; data shape is suitable for downstream actuarial pipeline.

## Tech Stack

- **Backend:** NestJS 10 + TypeScript (strict mode) + Prisma 5 + PostgreSQL 16
- **Authentication:** JWT (local, no SSO)
- **Encryption:** AES-256-GCM (per-record DEK + env KEK)
- **Logging:** Pino (structured, request_id + correlation_id)
- **Security:** Helmet + @nestjs/throttler (5 req/min on /auth/login)
- **Testing:** Jest 29 + Supertest (e2e against Postgres test DB)
- **Linting:** ESLint (strict)
- **API Docs:** Swagger/OpenAPI at /docs
- **Frontend:** React 18 + Vite 6 + TailwindCSS (Adjuster Workbench)
- **Node:** 20+

## Key Design Decisions (ADRs)

1. **ADR-001: PII Encryption** — AES-256-GCM for special-care PII (gov ID, medical, bank); standard PII uses cleartext + role-based masking.
2. **ADR-002: Audit Immutability** — No UPDATE/DELETE in code; append-only by design. Postgres RLS in Track B.
3. **ADR-003: Role Masking by APPI Tier** — Single function `maskByAppiTier()` is source of truth; applied at controller layer.
4. **ADR-004: Claim Status FSM** — Pure function `(from, to, claim, actor) → {ok, reason}`; illegal transitions return 422.
5. **ADR-005: Reserve Approval Tiers** — ¥1M, ¥10M thresholds encoded as policy; pure function.
6. **ADR-006: JFSA Notification Pattern** — Event-driven (NotificationToRegulator rows); daily flush in Track B.

## Regulatory Compliance Hooks

- **APPI (Act on Protection of Personal Information):** Consent capture, data-subject export, special-care encryption, role-based masking.
- **JFSA (Financial Services Agency):** Reserve threshold notification (¥100M), audit immutability, correlation IDs for traceability.
- **IFRS17 (International Financial Reporting Standard 17):** Reserve categories, export endpoint, full history per claim.

## What's Deliberately Unique to Yotsuba

1. **Domain-specific schema fields:** `inkan_seal_hash`, `appi_consent_version`, `case_reserve_yen` with `Decimal @db.Decimal(15,0)` (no float currency), prefecture validation.
2. **Regulatory thresholds as policy:** Every JFSA/IFRS17/APPI rule is a named constant; not magic numbers.
3. **Actual FSM for claim status:** Reasoned rejections; not a free-form string.
4. **Decimal-typed currency end-to-end:** No `number` for yen anywhere.
5. **Correlation IDs across services:** Full request chain reconstructible via `correlation_id` in every audit event.

Each of these is a thing a Japanese P&C regulator would expect and a generic CRUD POC would miss.