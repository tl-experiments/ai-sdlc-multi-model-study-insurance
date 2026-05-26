# Yotsuba Insurance Claims Processing Platform — Backend API

> **Track A Delivery** — First-notice-of-loss-to-settlement lifecycle for P&C claims at a Japanese insurance carrier. FNOL intake, adjuster workbench, and reserves management with APPI compliance, audit immutability, and JFSA regulatory hooks.

## Quick start

### Prerequisites

- **Node.js 20+**
- **PostgreSQL 16+**
- **npm 10+**

### Installation

```bash
# Clone the repository
git clone <repo-url>
cd yotsuba-claims

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your database URL and secrets
# DATABASE_URL=postgresql://user:password@localhost:5432/yotsuba_claims
# JWT_SECRET=<generate-a-random-string>
# ENCRYPTION_KEK=<base64-encoded-32-byte-key>

# Run database migrations
npx prisma migrate dev

# Seed the database with sample data
npx prisma db seed

# Start the development server
npm run start:dev
```

The API will be available at `http://localhost:3000`.
Swagger documentation is available at `http://localhost:3000/docs`.

## Architecture

The platform is organized into five core modules:

### 1. **Auth** (`src/auth/`)

JWT-based authentication. All protected routes require a valid bearer token.

**Endpoints:**
- `POST /auth/login` — authenticate with username/password; returns JWT access token
- `GET /auth/me` — get current authenticated user

**Roles:**
- `agent` — FNOL intake only; read-only on own claims for 24 hours
- `adjuster` — assigned claim investigation; notes, evidence, witness statements
- `manager` — assign/reassign adjusters; approve reserves up to ¥10M; view reports
- `auditor` — read-only across all claims; full audit log access
- `siu_referrer` — flag claims as fraud-suspicious (Track B)

### 2. **Claims** (`src/claims/`)

FNOL intake, claim lifecycle, and adjuster workbench.

**FNOL Intake Channels:**
- `POST /claims` — generic intake (agent, adjuster)
- `POST /claims/mobile` — mobile app channel normaliser
- `POST /claims/broker` — broker/dealer portal normaliser
- `POST /claims/email-parse` — email parser (idempotent on Message-Id)

**Claim Lifecycle:**
- `GET /claims` — role-scoped list with filters (status, severity, channel, assignee)
- `GET /claims/:id` — full claim detail (role-masked PII)
- `POST /claims/:id/assign` — assign/reassign adjuster (manager-only)
- `PATCH /claims/:id/status` — workflow state transition (guarded FSM)
- `POST /claims/:id/notes` — append immutable note
- `POST /claims/:id/evidence` — attach evidence (photo, document, audio, video)
- `POST /claims/:id/witness-statement` — structured witness intake with `inkan_seal_hash`

**Claim Status Workflow:**
```
intake → under_investigation → awaiting_reserve_approval → settlement_offered → closed_paid
                                                                              ↓
                                                                         closed_denied
                                                                              ↓
                                                                           reopened
```

**Initial Classification:**
Claims are automatically classified as `simple`, `complex`, or `catastrophic` based on:
- Declared loss amount
- Incident type
- Injury reported

### 3. **Reserves** (`src/reserves/`)

Reserve management, approval workflows, and IFRS17 export.

**Reserve Categories:**
- `loss_paid` — amounts already paid
- `loss_unpaid` — estimated future payouts
- `alae` — allocated loss adjustment expense
- `ulae` — unallocated loss adjustment expense

**Approval Tiers:**
- ≤ ¥1M — self-approving (adjuster proposes, auto-approved)
- ¥1M–¥10M — manager approval required
- \> ¥10M — manager + claims-director approval required

**Endpoints:**
- `POST /claims/:id/reserves` — propose reserve change
- `GET /claims/:id/reserves` — reserve history for a claim
- `POST /reserves/:id/approve` — manager approves (up to ¥10M)
- `POST /reserves/:id/director-approve` — claims-director approves (>¥10M)
- `POST /reserves/:id/reject` — reject with reason
- `GET /reserves/export?period=YYYY-MM` — IFRS17-ready aggregates

**JFSA Notification:**
Any reserve change crossing ¥100M triggers a `NotificationToRegulator` record. The POC captures the event shape; actual JFSA wire format is Track B.

### 4. **Audit** (`src/audit/`)

Immutable audit log (auditor-only read access).

**Endpoints:**
- `GET /audit` — query audit events with filters (from, to, actor, claim_id, action)

**Audit Events:**
Every write operation (claim creation, note addition, evidence upload, reserve approval, status change) emits an immutable `AuditEvent` with:
- `actor_id` — user who performed the action
- `actor_role` — role of the actor
- `action` — e.g., `claim.created`, `reserve.approved`, `evidence.added`
- `claim_id` — associated claim (if applicable)
- `payload_hash` — SHA-256 of normalized event payload (tamper detection)
- `request_id` — unique per HTTP request
- `correlation_id` — propagated across service boundaries
- `ts` — timestamp

### 5. **APPI** (`src/appi/`)

APPI (Act on Protection of Personal Information) compliance.

**Endpoints:**
- `GET /claims/:id/data-subject-export` — APPI Article 28 disclosure right; returns all PII held about an identified individual across all claims
- `POST /claims/:id/personal-data-anonymise` — redact PII while preserving audit trail (manager-only, Track B)

**PII Tiers:**

| Field | Sensitivity | Protection |
|---|---|---|
| `reporter_name` | Standard PII | Stored cleartext; role-masked in API |
| `reporter_phone` | Standard PII | Encrypted at rest; role-masked |
| `reporter_email` | Standard PII | Encrypted at rest; role-masked |
| `policy_number` | Sensitive | Role-masked; auditor sees full |
| `insured_government_id` | Special-care (Article 17) | AES-256-GCM encrypted; never in API; only via data-subject-export |
| `bank_account_for_payout` | Special-care | AES-256-GCM encrypted; never in API |
| `injury_details` | Special-care (medical) | AES-256-GCM encrypted; never in API |
| `loss_location` | Standard PII | Stored cleartext; role-masked at prefecture-only granularity for non-adjuster roles |

**Role-Based Masking:**
- `agent` — read-only on own intake claims for 24 hours; no PII in list view
- `adjuster` — full cleartext on assigned claims; masked on non-assigned claims
- `manager` — full cleartext on reports' claims; masked on others
- `auditor` — full cleartext on all claims (audit context)
- `siu_referrer` — masked PII on flagged claims only

## API Examples

### 1. Login

```bash
curl -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{
    "username": "adjuster1",
    "password": "password123"
  }'
```

**Response:**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "role": "adjuster"
}
```

### 2. Create a claim (FNOL intake)

```bash
curl -X POST http://localhost:3000/claims \
  -H 'Authorization: Bearer <access_token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "policy_number": "POL-2024-001234",
    "loss_date": "2024-01-15T10:30:00Z",
    "loss_location_prefecture": "東京都",
    "loss_location_postal_code": "100-0001",
    "loss_location_detail": "Chiyoda Ward, Tokyo",
    "reported_by_channel": "agent",
    "reporter_name": "田中太郎",
    "reporter_phone": "09012345678",
    "reporter_email": "tanaka@example.com",
    "reporter_relation_to_insured": "本人",
    "incident_type": "auto_collision",
    "initial_description": "Collision with another vehicle at intersection",
    "injury_reported": false,
    "third_party_involved": true,
    "police_report_number": "2024-12345",
    "appi_consent_version": "1.0",
    "appi_consent_at": "2024-01-15T10:30:00Z"
  }'
```

**Response:**
```json
{
  "id": "clm_abc123def456",
  "policy_number": "POL-2024-001234",
  "loss_date": "2024-01-15T10:30:00Z",
  "loss_location_prefecture": "東京都",
  "incident_type": "auto_collision",
  "severity_initial": "simple",
  "status": "intake",
  "created_at": "2024-01-15T10:35:00Z"
}
```

### 3. Assign a claim

```bash
curl -X POST http://localhost:3000/claims/clm_abc123def456/assign \
  -H 'Authorization: Bearer <manager_token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "adjuster_id": "usr_adjuster1",
    "reason_for_reassignment": "Initial assignment"
  }'
```

### 4. Add a note

```bash
curl -X POST http://localhost:3000/claims/clm_abc123def456/notes \
  -H 'Authorization: Bearer <adjuster_token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "body": "Contacted claimant; injury assessment scheduled for 2024-01-20"
  }'
```

### 5. Propose a reserve

```bash
curl -X POST http://localhost:3000/claims/clm_abc123def456/reserves \
  -H 'Authorization: Bearer <adjuster_token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "category": "loss_unpaid",
    "proposed_yen": "500000",
    "justification": "Vehicle repair estimate received; parts on order"
  }'
```

### 6. Approve a reserve

```bash
curl -X POST http://localhost:3000/reserves/res_xyz789/approve \
  -H 'Authorization: Bearer <manager_token>' \
  -H 'Content-Type: application/json' \
  -d '{}'
```

### 7. Query audit log

```bash
curl -X GET 'http://localhost:3000/audit?claim_id=clm_abc123def456&action=reserve.approved' \
  -H 'Authorization: Bearer <auditor_token>'
```

### 8. Data-subject export (APPI Article 28)

```bash
curl -X GET http://localhost:3000/claims/clm_abc123def456/data-subject-export \
  -H 'Authorization: Bearer <manager_token>'
```

**Response:**
```json
{
  "subject_identifier": "reporter_name=田中太郎",
  "export_generated_at": "2024-01-15T11:00:00Z",
  "claims": [
    {
      "claim_id": "clm_abc123def456",
      "policy_number": "POL-2024-001234",
      "reporter_name": "田中太郎",
      "reporter_phone": "09012345678",
      "reporter_email": "tanaka@example.com",
      "loss_location_detail": "Chiyoda Ward, Tokyo",
      "incident_type": "auto_collision",
      "initial_description": "Collision with another vehicle at intersection",
      "created_at": "2024-01-15T10:35:00Z"
    }
  ]
}
```

## Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:cov

# Run a specific test file
npm test -- auth.e2e.spec.ts
```

**Test coverage includes:**
- Authentication (login, JWT validation, role-based access)
- FNOL intake (all 4 channels, validation, APPI consent)
- Claim lifecycle (status FSM, illegal transitions)
- Adjuster workbench (assign, note, evidence, witness statements)
- Reserve management (approval tiers, JFSA threshold notification)
- Audit log (immutability, event accumulation)
- APPI compliance (data-subject-export, PII masking)
- Role-based access control (all 5 roles × all resources)

## Linting

```bash
# Check for linting errors
npm run lint

# Fix linting errors automatically
npm run lint:fix
```

## Database

### Migrations

```bash
# Create a new migration
npx prisma migrate dev --name <migration_name>

# Apply pending migrations
npx prisma migrate deploy

# Reset the database (development only)
npx prisma migrate reset
```

### Seeding

```bash
# Run the seed script
npx prisma db seed
```

The seed script populates:
- 1 admin user
- 2 managers
- 5 adjusters
- 1 auditor
- 1 SIU referrer
- 3 claims-director-capable managers
- 20 sample claims spanning all incident types and workflow states

### Schema

The Prisma schema is defined in `prisma/schema.prisma`. Key models:

- **User** — identity and RBAC
- **Claim** — core claim record with PII fields (some encrypted)
- **ClaimNote** — immutable append-only notes
- **Evidence** — attached evidence (photo, document, etc.)
- **WitnessStatement** — structured witness intake
- **Reserve** — reserve proposals and approval history
- **AuditEvent** — immutable audit log
- **NotificationToRegulator** — JFSA threshold notifications

## Environment Variables

Create a `.env` file in the project root:

```bash
# Server
NODE_ENV=development
PORT=3000

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/yotsuba_claims

# JWT
JWT_SECRET=your-secret-key-here-min-32-chars
JWT_EXPIRATION=3600

# Encryption (AES-256-GCM key encryption key)
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
ENCRYPTION_KEK=<base64-encoded-32-byte-key>

# Logging
LOG_LEVEL=debug
```

See `.env.example` for a complete template.

## Architecture Decision Records (ADRs)

Key design decisions are documented in `docs/adr/`:

- **ADR-001** — PII encryption (AES-256-GCM, APPI-tier-aware)
- **ADR-002** — Audit log immutability (no UPDATE/DELETE in code)
- **ADR-003** — Role masking by APPI tier (response-time filtering)
- **ADR-004** — Claim status finite-state machine (pure function)
- **ADR-005** — Reserve approval tiers (¥1M, ¥10M thresholds)
- **ADR-006** — JFSA notification pattern (event-driven, daily flush)

See `docs/ARCHITECTURE.md` for a one-page overview and flow narrative.

## Project Structure

```
.
├── src/
│   ├── main.ts                          # Bootstrap
│   ├── app.module.ts                    # Root module
│   ├── prisma.service.ts                # Database service
│   ├── common/                          # Cross-cutting concerns
│   │   ├── encryption.ts                # AES-256-GCM
│   │   ├── jwt-auth.guard.ts            # JWT validation
│   │   ├── roles.guard.ts               # Role-based access
│   │   ├── roles.decorator.ts
│   │   ├── current-user.decorator.ts
│   │   ├── pii-mask.util.ts             # APPI-tier masking
│   │   ├── audit.interceptor.ts         # Audit event writer
│   │   ├── audit.decorator.ts
│   │   ├── error.filter.ts              # Global exception handler
│   │   ├── request-id.middleware.ts
│   │   └── correlation-id.middleware.ts
│   ├── auth/                            # Authentication
│   │   ├── auth.module.ts
│   │   ├── auth.controller.ts
│   │   ├── auth.service.ts
│   │   └── dto/
│   │       └── login.dto.ts
│   ├── claims/                          # FNOL & workbench
│   │   ├── claims.module.ts
│   │   ├── claims.controller.ts
│   │   ├── claims.service.ts
│   │   ├── claims-channel.service.ts
│   │   ├── claims-status.fsm.ts
│   │   └── dto/
│   │       ├── create-claim.dto.ts
│   │       ├── update-status.dto.ts
│   │       ├── assign-claim.dto.ts
│   │       ├── add-note.dto.ts
│   │       ├── add-evidence.dto.ts
│   │       └── add-witness-statement.dto.ts
│   ├── reserves/                        # Reserve management
│   │   ├── reserves.module.ts
│   │   ├── reserves.controller.ts
│   │   ├── reserves.service.ts
│   │   ├── reserves-jfsa.service.ts
│   │   ├── reserves-export.service.ts
│   │   └── dto/
│   │       ├── propose-reserve.dto.ts
│   │       └── reject-reserve.dto.ts
│   ├── audit/                           # Audit log
│   │   ├── audit.module.ts
│   │   ├── audit.controller.ts
│   │   └── audit.service.ts
│   └── appi/                            # APPI compliance
│       ├── appi.module.ts
│       ├── appi.service.ts
│       └── dto/
│           └── anonymise-request.dto.ts
├── prisma/
│   ├── schema.prisma
│   └── seed.ts
├── test/
│   ├── auth.e2e.spec.ts
│   ├── claims-fnol.e2e.spec.ts
│   ├── claims-workbench.e2e.spec.ts
│   ├── reserves.e2e.spec.ts
│   └── appi.e2e.spec.ts
├── web/                                 # Adjuster Workbench (React + Vite)
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── tailwind.config.cjs
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── styles.css
│       ├── lib/
│       │   ├── api.ts
│       │   ├── auth.tsx
│       │   └── format-yen.ts
│       ├── components/
│       │   ├── Layout.tsx
│       │   ├── RoleBadge.tsx
│       │   ├── ClaimStatusPill.tsx
│       │   ├── SeverityPill.tsx
│       │   └── EvidenceGallery.tsx
│       └── pages/
│           ├── Login.tsx
│           ├── ClaimQueue.tsx
│           ├── ClaimDetail.tsx
│           ├── ReserveApprovals.tsx
│           └── AuditLog.tsx
├── docs/
│   ├── adr/
│   │   ├── 001-encryption.md
│   │   ├── 002-audit-immutability.md
│   │   ├── 003-role-masking-by-appi-tier.md
│   │   ├── 004-claim-status-fsm.md
│   │   ├── 005-reserve-approval-tiers.md
│   │   └── 006-jfsa-notification-pattern.md
│   └── ARCHITECTURE.md
├── .env.example
├── .eslintrc.js
├── jest.config.js
├── tsconfig.json
├── package.json
└── README.md
```

## Workbench UI

The Adjuster Workbench is a React + Vite + TailwindCSS single-page application.

### Running the workbench

```bash
cd web
npm install
npm run dev
```

The workbench will be available at `http://localhost:5173`.

### Features

- **Claim Queue** — filterable list of assigned claims (status, severity, channel, age)
- **Claim Detail** — full claim view with timeline, notes, evidence gallery, witness statements, reserve breakdown
- **Quick Actions** — assign, transition state, attach evidence, add note
- **Reserve Approvals** — manager workflow for reserve approval (up to ¥10M)
- **Audit Log** — auditor-only view of all audit events

## Regulatory Compliance

### APPI (Act on Protection of Personal Information)

- **Consent capture** at FNOL intake (`appi_consent_version`, `appi_consent_at`)
- **Data-subject export** (Article 28) — `GET /claims/:id/data-subject-export`
- **PII anonymisation** (Article 17) — `POST /claims/:id/personal-data-anonymise` (Track B)
- **Encryption** of special-care PII (government ID, medical, bank account) at rest
- **Role-based masking** of standard PII in API responses

### JFSA (Financial Services Agency)

- **Reserve threshold notification** — ¥100M crossing triggers `NotificationToRegulator` record
- **Audit immutability** — all writes are append-only; no UPDATE/DELETE in code
- **Correlation IDs** — full request chain reconstructible via `correlation_id`

### IFRS17 (International Financial Reporting Standard 17)

- **Reserve categories** — `loss_paid`, `loss_unpaid`, `alae`, `ulae`
- **Export endpoint** — `GET /reserves/export?period=YYYY-MM` returns aggregates suitable for downstream IFRS17 calculation
- **Reserve history** — full immutable history per claim for walk-forwards

## Support

For issues, questions, or contributions, please refer to the project's issue tracker or contact the development team.

## License

This project is proprietary and confidential.