# ADR-005: Reserve Approval Tiers

**Status:** Accepted  
**Date:** 2024-01-01  
**Deciders:** Platform Architecture Team  
**Regulated under:** JFSA (金融庁) / IFRS 17  
**Track:** A (enforced) — Track B adds claims-director delegation and multi-currency reserve support

---

## Context

Reserves are the financial liabilities an insurer sets aside against expected claims payouts. In a JFSA-regulated P&C insurance carrier, the adequacy of reserves is a regulated matter: under-reserving inflates reported profit and understates liability; over-reserving depresses it. Both attract regulatory scrutiny. The JFSA expects that reserve changes above material thresholds are reviewed and approved by personnel with appropriate authority before being booked.

Beyond regulatory expectation, reserve adequacy directly affects the carrier's IFRS 17 disclosures and its reinsurance ceding calculations. A reserve approved by an insufficiently senior person — or approved without documented justification — exposes the carrier to audit findings, restatement risk, and potential JFSA action.

Three distinct concerns drive the tiered approval requirement:

### 1. JFSA Financial Controls

The Financial Services Agency (金融庁) expects that material financial decisions within a regulated insurer are subject to documented multi-person review. A single adjuster proposing and self-approving a ¥50M reserve change with no manager involvement does not meet that standard. The JFSA examines approval chains during routine inspections; the absence of documented approval for large reserves is a finding.

### 2. IFRS 17 Reserve Walk-Forward Integrity

Under IFRS 17, the carrier must disclose movements in insurance contract liabilities by category (`loss_paid`, `loss_unpaid`, `alae`, `ulae`). Each movement must be traceable to an approved reserve change with a documented justification. An unapproved or improperly approved reserve change that enters the IFRS 17 export undermines the walk-forward and may require restatement. The approval workflow is the control that prevents unapproved reserves from reaching the actuarial pipeline.

### 3. Internal Financial Authority Matrix

Every insurer maintains a delegation of authority (権限委譲表) — a matrix specifying which personnel may approve financial commitments up to which amounts. The reserve approval tiers encode the relevant slice of that matrix for claims reserves. Exceeding your delegated authority is an internal control failure regardless of whether the reserve is ultimately correct.

### Problem Statement

Without a formally specified and centrally enforced approval tier structure, several failure modes emerge:

1. **Authority exceeded silently.** A manager approves a ¥15M reserve without claims-director sign-off. The reserve is booked, the JFSA inspection finds the missing approval, and the carrier faces a remediation finding.
2. **Threshold magic numbers are scattered.** ¥1M and ¥10M thresholds appear in multiple controller guards, service checks, and test fixtures. When the delegation of authority matrix is updated, every occurrence must be found and changed consistently.
3. **Approval state is ambiguous.** Without an explicit approval state machine (`pending` → `approved` / `rejected`), a reserve could be treated as approved by some code paths and pending by others.
4. **JFSA notification threshold is not linked to approval logic.** The ¥100M JFSA notification threshold (a separate but related control) must fire consistently with the approval chain, not independently.

We need a design that:

1. Encodes all approval thresholds as named constants in a single location.
2. Enforces the correct approver level before any `approved` state write occurs.
3. Prevents a manager from approving a reserve that requires claims-director sign-off.
4. Is a pure policy function, independently testable without database fixtures.
5. Produces structured 403 / 422 rejections with actionable reasons when authority is exceeded.

---

## Decision

### Approval tiers as named policy constants

All reserve approval thresholds are defined as named constants in `src/reserves/reserves.service.ts` (or a co-located policy module). No numeric literal appears in any guard, controller, or test that is not derived from these constants:

```typescript
// Reserve approval delegation of authority (権限委譲表)
export const RESERVE_APPROVAL_POLICY = {
  /** Up to this amount: no separate approval required; adjuster proposal is self-authorising */
  SELF_APPROVE_THRESHOLD_YEN: 1_000_000n,            // ¥1,000,000
  /** Up to this amount: manager approval required */
  MANAGER_APPROVE_THRESHOLD_YEN: 10_000_000n,         // ¥10,000,000
  /** Above manager threshold: claims director approval required in addition to manager */
  DIRECTOR_APPROVE_THRESHOLD_YEN: 10_000_000n,        // >¥10,000,000 requires director
  /** JFSA notification threshold: any single change crossing this triggers a notification record */
  JFSA_NOTIFICATION_THRESHOLD_YEN: 100_000_000n,      // ¥100,000,000
} as const;
```

> **Note on numeric types:** Reserve amounts are stored as `Decimal @db.Decimal(15,0)` in Postgres and as `Prisma.Decimal` in TypeScript. Threshold comparisons use `Prisma.Decimal` comparison methods (`gte`, `gt`, `lte`) to avoid floating-point precision issues. The `BigInt` literals above are for documentation clarity; the implementation uses `new Prisma.Decimal('10000000')` for comparisons.

### Three-tier approval model

| Tier | Amount range | Required approver | How it works |
|---|---|---|---|
| **Tier 0 — Self-authorising** | `proposed_yen ≤ ¥1M` | None — adjuster proposal is effective immediately | Reserve is created with `approval_status = approved`; no separate approval step required |
| **Tier 1 — Manager approval** | `¥1M < proposed_yen ≤ ¥10M` | `manager` role (in claims pool) | Reserve is created with `approval_status = pending`; `POST /reserves/:id/approve` required |
| **Tier 2 — Director approval** | `proposed_yen > ¥10M` | `manager` approval + `is_claims_director = true` approval | Reserve is created with `approval_status = pending`; both `POST /reserves/:id/approve` and `POST /reserves/:id/director-approve` required; neither alone is sufficient |

The `approval_status` field reflects the aggregate state:
- `pending` — proposal submitted; awaiting required approvals
- `approved` — all required approvals obtained
- `rejected` — rejected by any required approver; no further approval possible

For Tier 2, a manager may call `POST /reserves/:id/approve` first, but the reserve remains `pending` until a claims director also calls `POST /reserves/:id/director-approve`. The reverse order (director first, manager second) is also valid. The reserve transitions to `approved` only when both approvals are recorded.

### Pure policy function: `requiresApproval()`

The approval tier determination is implemented as a pure function in `reserves.service.ts`:

```typescript
export function getRequiredApprovalTier(
  proposedYen: Prisma.Decimal,
): 'self' | 'manager' | 'director' {
  if (proposedYen.lte(new Prisma.Decimal(RESERVE_APPROVAL_POLICY.SELF_APPROVE_THRESHOLD_YEN.toString()))) {
    return 'self';
  }
  if (proposedYen.lte(new Prisma.Decimal(RESERVE_APPROVAL_POLICY.MANAGER_APPROVE_THRESHOLD_YEN.toString()))) {
    return 'manager';
  }
  return 'director';
}
```

No side effects, no NestJS imports, no Prisma queries. The function is tested independently of the HTTP layer.

### Approval guard: `assertCanApprove()`

Before writing any approval state, `reserves.service.ts` calls an approval guard:

```typescript
function assertCanApprove(
  reserve: Reserve,
  actor: { role: UserRole; is_claims_director: boolean },
  action: 'approve' | 'director-approve',
): void
```

The guard throws `ForbiddenException` with a structured reason string if the actor does not have the required authority for the reserve's tier and the requested action:

| Scenario | Exception message |
|---|---|
| Non-manager calls `approve` | `"Reserve approval requires manager role. Caller has role: <role>."` |
| Manager calls `approve` on a Tier 2 reserve before director approval | `approve` is accepted; reserve remains `pending` until director also approves |
| Non-claims-director manager calls `director-approve` | `"Director approval requires is_claims_director flag. Caller is not a claims director."` |
| Claims director calls `director-approve` on a Tier 0 or Tier 1 reserve | `"Director approval is not required for reserves ≤ ¥10M. Use POST /reserves/:id/approve."` |
| Either approver acts on an already-`approved` or `rejected` reserve | `"Reserve is already in terminal state: <status>. No further approval actions are permitted."` |

### Integration with the request flow

```
POST /claims/:id/reserves
        │
        ▼
  reserves.controller.ts     — extracts caller, body: { category, proposed_yen, justification }
        │
        ▼
  reserves.service.ts
  #proposeReserve(claimId, dto, caller)
        │
        ▼
  ① Validate justification.length >= 50
        │
        ▼
  ② getRequiredApprovalTier(proposed_yen)
     → 'self'      ──► create Reserve with approval_status='approved'
     → 'manager'   ──►  create Reserve with approval_status='pending'
     → 'director'  ──►  create Reserve with approval_status='pending'
        │
        ▼
  ③ checkJfsaThreshold(proposed_yen, claimId, reserveId)
     if proposed_yen >= ¥100M:
       reserves-jfsa.service.ts#createNotification()
        │
        ▼
  ④ AuditInterceptor emits AuditEvent
     action = 'reserve.proposed'
     payload includes { proposed_yen, tier, approval_status }


POST /reserves/:id/approve
        │
        ▼
  reserves.controller.ts
        │
        ▼
  reserves.service.ts
  #approveReserve(reserveId, caller)
        │
        ▼
  ① fetch Reserve; assertNotTerminal(reserve)
        │
        ▼
  ② assertCanApprove(reserve, caller, 'approve')
     throws ForbiddenException if role != manager
        │
        ▼
  ③ getRequiredApprovalTier(reserve.proposed_yen)
     → 'self'     ──► ForbiddenException (use director-approve for tier mismatch, or redundant)
     → 'manager'  ──► set approved_by_id, approved_at; set approval_status='approved'
     → 'director' ──► set approved_by_id, approved_at; approval_status remains 'pending'
                       (director approval still required)
        │
        ▼
  ④ AuditInterceptor emits AuditEvent
     action = 'reserve.approved'


POST /reserves/:id/director-approve
        │
        ▼
  reserves.service.ts
  #directorApproveReserve(reserveId, caller)
        │
        ▼
  ① fetch Reserve; assertNotTerminal(reserve)
        │
        ▼
  ② assertCanApprove(reserve, caller, 'director-approve')
     throws ForbiddenException if role != manager || !is_claims_director
     throws ForbiddenException if tier != 'director'
        │
        ▼
  ③ set director_approved_by_id, director_approved_at
     if approved_by_id already set: set approval_status='approved'
     else: approval_status remains 'pending'
        │
        ▼
  ④ AuditInterceptor emits AuditEvent
     action = 'reserve.director_approved'
```

### Justification length requirement

All reserve proposals must carry a `justification` of at least 50 characters, validated by `class-validator` in `propose-reserve.dto.ts`:

```typescript
@IsString()
@MinLength(50, { message: 'Justification must be at least 50 characters to satisfy JFSA documentation requirements.' })
justification: string;
```

This is a regulatory documentation control. A one-line justification does not meet the JFSA expectation that reserve changes are substantiated. The 50-character floor is a minimum; adjusters and managers are trained to provide substantive justifications.

### Immutable reserve history

Every reserve proposal creates a new `Reserve` row. Reserve changes are never applied by updating an existing row's `proposed_yen`. Instead:

1. The most recent `Reserve` row for a claim with `approval_status = 'approved'` is the current operative reserve.
2. Each prior `Reserve` row (with its `proposed_yen`, `prior_yen`, `justification`, `proposed_by_id`, `proposed_at`, and approval metadata) constitutes the immutable history.
3. `GET /claims/:id/reserves` returns the full history ordered by `proposed_at`.

This immutability is essential for IFRS 17 walk-forwards: the actuary needs to see every reserve movement — what it was before, what it became, who proposed it, who approved it, and when — not merely the current balance.

### JFSA notification threshold

The ¥100M threshold is a separate control from the approval tiers, but is evaluated in the same service call. When a proposed reserve crosses ¥100M, `reserves-jfsa.service.ts#createNotification()` synchronously writes a `NotificationToRegulator` row. This happens regardless of approval status — the notification records the *proposal*, not the approval. The daily JFSA reporting batch (Track B) flushes `sent_at = null` rows.

The JFSA notification is an asynchronous regulatory reporting obligation, not a blocking approval gate. A ¥150M reserve proposal is still subject to the Tier 2 director approval workflow; the JFSA notification is generated at proposal time, before any approval occurs.

### IFRS 17 export hook

`GET /reserves/export?period=YYYY-MM` calls `reserves-export.service.ts#aggregateByPeriod()`, which:

1. Queries all `Reserve` rows with `approval_status = 'approved'` and `proposed_at` within the requested period.
2. Groups by `category` (`loss_paid`, `loss_unpaid`, `alae`, `ulae`).
3. Returns a tabular JSON structure:

```json
{
  "period": "2024-03",
  "exported_at": "2024-04-01T00:00:00Z",
  "categories": [
    { "category": "loss_paid",    "count": 142, "total_yen": "1234567890", "currency": "JPY" },
    { "category": "loss_unpaid",  "count":  87, "total_yen":  "987654321", "currency": "JPY" },
    { "category": "alae",         "count":  56, "total_yen":  "123456789", "currency": "JPY" },
    { "category": "ulae",         "count":  23, "total_yen":   "45678901", "currency": "JPY" }
  ]
}
```

Only `approved` reserves enter the export. `pending` and `rejected` reserves are excluded. This is the primary control ensuring the actuarial pipeline receives only authorised reserve movements.

---

## Consequences

### Positive

- **JFSA authority matrix enforced in code.** The delegation of authority (権限委譲表) for claims reserves is implemented as a pure function and named constants. A JFSA examiner reviewing the codebase can confirm that the ¥10M manager ceiling and the claims-director requirement above that ceiling are structurally enforced, not merely documented as policy.
- **Single source of truth for thresholds.** `RESERVE_APPROVAL_POLICY` is the only place where ¥1M, ¥10M, and ¥100M appear as numbers. Updating the delegation matrix requires a one-line change with a test that immediately surfaces any inconsistency.
- **Acceptance criterion §9 satisfied.** A ¥15M proposal cannot reach `approved` state without both a manager `approve` call and a claims-director `director-approve` call. The test suite verifies that calling only `POST /reserves/:id/approve` on a ¥15M reserve leaves `approval_status = 'pending'`.
- **IFRS 17 export integrity.** The export queries only `approved` reserves. The approval gate is the single control preventing unapproved reserves from entering the actuarial pipeline. No separate filtering or manual curation is required.
- **Full immutable history.** Every reserve change — proposed amount, prior amount, justification, proposer, approver(s), timestamps — is preserved as an immutable append-only history. IFRS 17 walk-forward audits and JFSA examinations can reconstruct the full reserve movement history per claim.
- **Structured rejections.** Authority violations return HTTP 403 with a machine-readable and human-readable reason. Adjusters and managers receive actionable messages, not opaque server errors.

### Negative / Accepted trade-offs

- **Two-step approval for Tier 2 is not atomic.** A ¥15M reserve may have manager approval recorded without director approval (and vice versa). The reserve remains `pending` in this intermediate state. This is operationally correct — the two approvals may happen hours or days apart — but introduces a window where the reserve is partially approved. The `approval_status` field correctly reflects `pending` throughout, so downstream systems (IFRS 17 export, settlement workflow) correctly exclude it.
- **No time-to-approve SLA enforcement in Track A.** The approval workflow does not enforce that a pending reserve is approved within a JFSA-mandated timeframe. Unapproved reserves simply accumulate as `pending`. Track B will add scheduled escalation.
- **Self-approving tier requires careful calibration.** The Tier 0 (≤¥1M self-approving) threshold was set based on the carrier's delegation of authority. If the threshold is set too high, material reserves bypass manager review. The named constant and its business justification must be reviewed annually against the carrier's delegation of authority matrix.
- **No multi-currency support in Track A.** All reserves are `currency='JPY'`. The `Decimal(15,0)` type and the yen-denominated thresholds are JPY-specific. Marine cargo claims may involve USD or EUR reserves; multi-currency is a Track B concern.
- **Partial director approval not tracked separately.** The `approval_status` enum has three values: `pending`, `approved`, `rejected`. There is no `manager_approved_pending_director` intermediate value. The `approved_by_id` and `director_approved_by_id` fields encode the partial state, but the `approval_status` field does not distinguish Tier 2 partial approval from Tier 1 awaiting approval. This is a simplification acceptable for Track A; Track B may add a `partially_approved` status.

---

## Alternatives Considered

### Option 1: Single approval threshold (manager-only for all non-trivial reserves)

Rejected. A flat manager-only approval model does not satisfy the delegation of authority matrix for a carrier with ¥3T+ in net premiums. Reserve changes in the tens or hundreds of millions of yen require senior sign-off beyond a field manager. The JFSA would find a flat manager approval model insufficient for material reserves.

### Option 2: Configurable thresholds stored in the database

Considered. Storing the ¥1M and ¥10M thresholds in a configuration table would allow them to be updated without a deployment. However:

- Threshold changes are infrequent (annual review of the delegation of authority matrix) and high-stakes. A deployment gate with code review is a feature, not a bug.
- Database-stored thresholds require an audit trail of their own to satisfy JFSA evidentiary requirements. The complexity is disproportionate to the benefit.
- Named constants in code are visible in version control history; a database row change may not be.

Database-stored thresholds are a Track B option if the carrier's operational model requires frequent threshold adjustments without deployment.

### Option 3: Four-tier approval (adding an executive tier above claims director)

Considered. Some carriers have a four-tier model with a Chief Claims Officer tier above the claims director for reserves >¥1B. This is out of scope for Track A, which handles claims up to the Tier 2 ceiling. A Track B extension adds the executive tier by adding one entry to `RESERVE_APPROVAL_POLICY` and one new endpoint.

### Option 4: Approval encoded as a NestJS guard on the route

Rejected. A `@Guard` on `POST /reserves/:id/approve` could check `caller.role === 'manager'`, but it cannot check the reserve amount (which requires fetching the reserve from the database). The approval tier determination requires the reserve to be fetched, which happens in the service. The guard approach would either double-fetch the reserve or move business logic into the guard. The service-layer approach keeps all approval business logic in one place.

### Option 5: Approval workflow via a separate approval request entity

Considered. Rather than storing approval state in the `Reserve` row, a separate `ReserveApprovalRequest` entity could model the approval workflow with its own lifecycle. This would be cleaner for Tier 2 (two separate `ReserveApprovalRequest` rows, one per approver) but adds a join for the common case and makes the IFRS 17 export query more complex. The `approved_by_id` / `director_approved_by_id` pattern on the `Reserve` row is sufficient for Track A's two-tier approval model.

---

## Test Matrix

The following combinations are covered by `test/reserves.e2e.spec.ts`:

| Scenario | Expected result |
|---|---|
| Adjuster proposes ¥500,000 reserve | Created with `approval_status = 'approved'` immediately (Tier 0) |
| Adjuster proposes ¥5M reserve | Created with `approval_status = 'pending'` (Tier 1) |
| Adjuster proposes ¥15M reserve | Created with `approval_status = 'pending'` (Tier 2) |
| Manager calls `approve` on ¥5M reserve | `approval_status` transitions to `'approved'`; `approved_by_id` set |
| Manager calls `approve` on ¥15M reserve | `approved_by_id` set; `approval_status` remains `'pending'` |
| Claims director calls `director-approve` on ¥15M reserve (after manager approve) | `approval_status` transitions to `'approved'`; `director_approved_by_id` set |
| Claims director calls `director-approve` on ¥15M reserve (before manager approve) | `director_approved_by_id` set; `approval_status` remains `'pending'` |
| Manager (non-director) calls `director-approve` | HTTP 403 — not a claims director |
| Adjuster calls `approve` | HTTP 403 — role violation |
| Manager calls `approve` on already-`approved` reserve | HTTP 422 — terminal state |
| Reserve proposed with `justification.length < 50` | HTTP 400 — validation failure |
| ¥150M reserve proposed | `NotificationToRegulator` row created; JFSA notification pending |
| ¥15M reserve approved by manager alone (acceptance criterion §9) | `approval_status = 'pending'`; HTTP 422 if settlement attempted |
| `GET /reserves/export?period=2024-03` | Only `approved` reserves in response; `pending` excluded |
| `GET /claims/:id/reserves` | Full history including `pending` and `rejected` entries |
| Non-auditor calls `GET /reserves/export` | HTTP 403 |

---

## Compliance Traceability

| Requirement | How this ADR satisfies it |
|---|---|
| JFSA — delegation of authority for reserve changes | Named constants in `RESERVE_APPROVAL_POLICY`; enforced by `assertCanApprove()` before every approval write |
| JFSA — documentary evidence of approval | `approved_by_id`, `approved_at`, `director_approved_by_id`, `director_approved_at` fields on every Reserve row; immutable history |
| JFSA — ¥100M threshold notification | `reserves-jfsa.service.ts` emits `NotificationToRegulator` synchronously at proposal time; daily batch flushes (Track B) |
| IFRS 17 — reserve movement by category | `GET /reserves/export` aggregates approved reserves by `category`; only approved reserves included |
| IFRS 17 — walk-forward auditability | Every Reserve row preserves `prior_yen` and `proposed_yen`; full immutable history queryable per claim |
| Internal delegation of authority matrix | Tier 0/1/2 thresholds map directly to the carrier's delegation table; `RESERVE_APPROVAL_POLICY` is the single-file implementation |
| Acceptance criterion §9 | Tested: ¥15M reserve cannot reach `approved` via `POST /reserves/:id/approve` alone |

---

## Related ADRs

- **ADR-002** — Audit log immutability (`reserve.proposed`, `reserve.approved`, `reserve.director_approved`, `reserve.rejected` events are written by the same interceptor; approval amounts are content-bound in `payload_hash`)
- **ADR-004** — Claim status FSM (the transition `awaiting_reserve_approval` → `settlement_offered` is FSM-gated; an approved reserve at the required tier is the business precondition for that transition)
- **ADR-006** — JFSA notification pattern (the ¥100M threshold event is produced by the same `proposeReserve()` call that determines the approval tier; this ADR defines the approval logic; ADR-006 defines the notification shape)

---

## Implementation Reference

| File | Role |
|---|---|
| `src/reserves/reserves.service.ts` | `getRequiredApprovalTier()` — pure tier function; `assertCanApprove()` — approval guard; `proposeReserve()`, `approveReserve()`, `directorApproveReserve()`, `rejectReserve()` |
| `src/reserves/reserves-jfsa.service.ts` | `createNotification()` — writes `NotificationToRegulator` when ¥100M threshold crossed |
| `src/reserves/reserves-export.service.ts` | `aggregateByPeriod()` — IFRS 17 export; queries only `approved` reserves |
| `src/reserves/reserves.controller.ts` | `POST /claims/:id/reserves`, `POST /reserves/:id/approve`, `POST /reserves/:id/director-approve`, `POST /reserves/:id/reject`, `GET /reserves/export` |
| `src/reserves/dto/propose-reserve.dto.ts` | `justification: @MinLength(50)` validation |
| `src/reserves/dto/reject-reserve.dto.ts` | `reason_for_rejection: string` |
| `prisma/schema.prisma` | `Reserve` model — `Decimal(15,0)` for all yen fields; `ApprovalStatus` enum; `approved_by_id`, `director_approved_by_id` |
| `test/reserves.e2e.spec.ts` | Approval tier tests, threshold tests, IFRS 17 export shape, JFSA notification |
| `docs/adr/005-reserve-approval-tiers.md` | This document |

---

## Track B Follow-On Actions

1. **Executive tier (>¥1B)** — add a fourth approval tier for reserves exceeding ¥1B, requiring Chief Claims Officer sign-off. Requires a new `executive_approved_by_id` field on `Reserve`, a new `POST /reserves/:id/executive-approve` endpoint, and a new entry in `RESERVE_APPROVAL_POLICY`.
2. **Time-to-approve SLA escalation** — add a scheduled job that identifies `pending` reserves older than the JFSA-mandated review period (e.g. 5 business days) and escalates to the assigned manager's manager. The approval tier determines the escalation target.
3. **Multi-currency reserve support** — extend `Reserve` to carry a `currency` field (ISO 4217) and a `proposed_yen_equivalent` for threshold comparison. Marine cargo claims may be denominated in USD or EUR; the yen equivalent is computed at the prevailing BOJ reference rate at proposal time.
4. **Database-stored threshold configuration** — if the delegation of authority matrix changes more than annually, migrate `RESERVE_APPROVAL_POLICY` to a versioned configuration table with its own approval workflow and audit trail.
5. **`partially_approved` status** — add a `partially_approved` value to `ApprovalStatus` to distinguish Tier 2 reserves that have one of two required approvals from Tier 1 reserves awaiting their single required approval. Improves observability for managers monitoring the approval queue.
6. **IFRS 17 calculation integration** — connect `reserves-export.service.ts` to the carrier's actuarial calculation engine. Track A exports the data shape; Track B adds the authenticated push to the actuarial pipeline with reconciliation.
7. **Reserve adequacy alerting** — add a rule that flags claims where the approved reserve has not been updated within N days of the last investigation note, prompting the adjuster to review reserve adequacy. Particularly relevant for long-tail `liability_premises` and `personal_accident` claims.