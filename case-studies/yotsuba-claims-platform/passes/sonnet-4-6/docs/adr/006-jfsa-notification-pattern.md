# ADR-006: JFSA Notification Pattern

**Status:** Accepted  
**Date:** 2024-01-01  
**Deciders:** Platform Architecture Team  
**Regulated under:** JFSA (金融庁) / Insurance Business Act (保険業法)  
**Track:** A (event capture) — Track B adds wire-format compliance and daily batch flush

---

## Context

The Financial Services Agency (金融庁) requires JFSA-regulated insurers to report material financial events within prescribed timeframes. For claims reserves, any single reserve change crossing a material threshold must be captured for regulatory reporting. The carrier's internal compliance framework, aligned with JFSA supervisory guidelines (監督指針), mandates that such events are:

1. **Detected automatically** — the system, not a human reviewer, identifies when a threshold is crossed.
2. **Recorded immediately** — the notification record is created synchronously with the reserve change that triggered it, not as a deferred batch scan.
3. **Reported on a daily cadence** — captured events are aggregated and submitted to the JFSA via the carrier's regulatory reporting channel on a daily basis.
4. **Traceable to source** — the notification record must link back to the specific reserve change, claim, and proposing adjuster.

### The ¥100M Threshold

The ¥100,000,000 (¥100M) threshold is the material reserve change threshold defined in `RESERVE_APPROVAL_POLICY.JFSA_NOTIFICATION_THRESHOLD_YEN` (see ADR-005). Any single reserve proposal where `proposed_yen >= ¥100M` triggers a `NotificationToRegulator` event, regardless of the reserve's approval status at the time of proposal.

This is a deliberately conservative design: the JFSA notification captures the *intent* (the proposal) rather than the *authorisation* (the approval). A ¥150M reserve proposal that is later rejected still generates a notification record, because the carrier's exposure was temporarily assessed at that level and that assessment must be documented.

### Regulatory context: JFSA daily reporting cadence

Under JFSA supervisory guidelines for P&C insurers, material claims developments must be reportable within one business day of occurrence. The carrier's existing JFSA reporting channel (operated by the compliance team) consumes a daily feed of flagged events. This platform's responsibility is to populate that feed reliably; the actual regulatory submission is the compliance team's responsibility and is out of scope for Track A.

### Problem Statement

Without a formally specified notification pattern, several failure modes emerge:

1. **Threshold crossing goes undetected.** A ¥150M reserve is proposed, approved, and booked. The compliance team's daily report does not include it because no notification record was generated.
2. **Notification is created at approval time, not proposal time.** A reserve may take days to receive director approval. Capturing the notification only at approval time means the JFSA daily report lags behind the actual event by an indeterminate period — potentially violating the one-business-day reporting SLA.
3. **The JFSA notification threshold and the approval tier threshold are conflated.** The ¥100M notification threshold is a regulatory reporting control; the ¥10M director approval threshold is a financial authority control. Conflating them in a single code path makes both harder to change independently.
4. **Notification records are lost if the reserve write rolls back.** If the notification is written in a separate transaction from the reserve, a reserve rollback leaves an orphaned notification pointing to a non-existent reserve.

We need a design that:

1. Captures the notification synchronously within the same database transaction as the reserve proposal.
2. Fires at proposal time, not approval time.
3. Is implemented in a dedicated service with a single responsibility.
4. Stores enough information to construct a valid JFSA report entry without re-querying the claims database.
5. Does not block the reserve proposal response — notification creation is a write, not an external call.
6. Is independently testable: a reserve proposal above ¥100M always produces exactly one `NotificationToRegulator` row; a proposal below ¥100M produces none.

---

## Decision

### Dedicated notification service: `reserves-jfsa.service.ts`

All JFSA threshold notification logic is implemented in a dedicated service `src/reserves/reserves-jfsa.service.ts`. This service has one responsibility: given a reserve proposal, determine whether it crosses the JFSA notification threshold and, if so, create a `NotificationToRegulator` row.

The service exposes a single public method:

```typescript
export class ReservesJfsaService {
  async checkAndNotify(
    reserve: { id: string; proposed_yen: Prisma.Decimal; claim_id: string },
  ): Promise<NotificationToRegulator | null>
}
```

The method:
1. Compares `reserve.proposed_yen` against `RESERVE_APPROVAL_POLICY.JFSA_NOTIFICATION_THRESHOLD_YEN`.
2. If the threshold is not crossed, returns `null` — no side effects.
3. If the threshold is crossed, writes one `NotificationToRegulator` row and returns it.
4. Never throws on notification failure — if the notification write fails (e.g. constraint violation), it logs the error and returns `null`. The reserve proposal must not fail because of a notification write error. This is an explicit trade-off: we accept a rare missed notification (logged and alertable) over a failed reserve proposal.

### Synchronous write within reserve proposal transaction

The notification is created **within the same Prisma transaction** as the reserve row:

```
POST /claims/:id/reserves
        │
        ▼
  reserves.service.ts
  #proposeReserve(claimId, dto, caller)
        │
        ▼
  prisma.$transaction(async (tx) => {
    ① Create Reserve row via tx.reserve.create()
           │
           ▼
    ② reserves-jfsa.service.ts
       #checkAndNotify(reserve, tx)    ← same transaction context
           │
        below threshold ──► return null (no write)
           │
        at/above threshold
           │
           ▼
    ③ tx.notificationToRegulator.create({...})
           │
           ▼
  })  ← both rows committed or both rolled back
        │
        ▼
  ④ AuditInterceptor emits AuditEvent
     action = 'reserve.proposed'
     payload includes { proposed_yen, jfsa_notified: true/false }
```

By running both writes in the same transaction, the atomicity guarantee is:
- If the reserve row is committed, the notification row is also committed (if the threshold was crossed).
- If the reserve write rolls back, the notification write also rolls back — no orphaned notifications.
- There is no window where a threshold-crossing reserve exists in the database without a corresponding notification.

### `NotificationToRegulator` data shape

The `NotificationToRegulator` entity (defined in `prisma/schema.prisma`) stores the minimum information needed for the compliance team to construct a JFSA report entry:

```prisma
model NotificationToRegulator {
  id           String   @id @default(cuid())
  kind         String   // "jfsa_reserve_threshold"
  claim_id     String
  reserve_id   String
  amount_yen   Decimal  @db.Decimal(15,0)
  triggered_at DateTime @default(now())
  sent_at      DateTime?  // null until daily batch flushes
}
```

| Field | Purpose |
|---|---|
| `kind` | Identifies the notification category; always `"jfsa_reserve_threshold"` for Track A. Track B adds additional kinds for other regulatory events. |
| `claim_id` | Direct link to the claim; allows the JFSA report to include claim reference without a join. |
| `reserve_id` | Direct link to the triggering reserve row; allows the compliance team to retrieve full reserve details including justification, approver chain, and category. |
| `amount_yen` | Denormalised copy of `proposed_yen` at the time of notification; survives even if the reserve row is somehow amended (defence in depth). |
| `triggered_at` | Timestamp of threshold crossing; the authoritative event time for JFSA reporting purposes. |
| `sent_at` | Null until the daily batch marks it flushed. The compliance team's daily job queries `WHERE sent_at IS NULL`; sets `sent_at = now()` after successful transmission. |

### Threshold evaluation: pure function

The threshold check is a pure function independent of the service:

```typescript
export function crossesJfsaThreshold(proposedYen: Prisma.Decimal): boolean {
  return proposedYen.gte(
    new Prisma.Decimal(
      RESERVE_APPROVAL_POLICY.JFSA_NOTIFICATION_THRESHOLD_YEN.toString()
    )
  );
}
```

This function is importable and testable without instantiating the NestJS module. It uses `Prisma.Decimal.gte()` to avoid floating-point precision issues on yen amounts near ¥100M. The threshold is `>=`, not `>`: a reserve of exactly ¥100,000,000 triggers the notification.

### Query interface for pending notifications

`GET /notifications/jfsa-pending` (restricted to `auditor` role) returns all `NotificationToRegulator` rows where `sent_at IS NULL`, ordered by `triggered_at` descending:

```json
{
  "pending_count": 3,
  "notifications": [
    {
      "id": "clxabc123",
      "kind": "jfsa_reserve_threshold",
      "claim_id": "clxdef456",
      "reserve_id": "clxghi789",
      "amount_yen": "150000000",
      "triggered_at": "2024-03-15T10:30:00Z",
      "sent_at": null
    }
  ]
}
```

This endpoint gives the compliance team and internal auditors real-time visibility into notifications queued for the next daily flush. It does not allow mutation of notification records — `NotificationToRegulator` rows are append-only in the same spirit as the `AuditEvent` table.

### Event shape vs. wire format

Track A captures the **event shape** — the information required to construct a JFSA report entry. Track A does not implement:
- The JFSA submission packet format (EDI / XML schema specified by the JFSA).
- The authenticated transmission channel (JFSA e-Gov portal or SFTP).
- The submission acknowledgement and error-handling loop.
- Multi-event aggregation logic (e.g. grouping related reserve changes on the same claim into one notification).

These are explicitly Track B deliverables. The POC provides reviewable evidence that threshold detection works correctly; it does not create false credibility about wire-format compliance.

This distinction is important for regulatory readiness assessments: the system can demonstrate *that* it detects the relevant events with the correct timing and data, even before the wire-format integration is complete.

### Separation from the approval tier logic

The ¥100M JFSA notification threshold and the ¥10M director approval threshold are independent controls. Their co-location in `RESERVE_APPROVAL_POLICY` (a single constants object) is for discoverability, not because they are the same kind of control:

| Control | Threshold | Trigger timing | Enforcement mechanism | Failure mode if absent |
|---|---|---|---|---|
| Director approval | > ¥10M | Reserve proposal | `assertCanApprove()` blocks write | Reserve booked without required sign-off |
| JFSA notification | ≥ ¥100M | Reserve proposal | `checkAndNotify()` writes notification | Material event unreported to regulator |

Changing the director approval threshold does not require changing the JFSA notification threshold, and vice versa. `reserves-jfsa.service.ts` reads only `JFSA_NOTIFICATION_THRESHOLD_YEN`; `reserves.service.ts#assertCanApprove()` reads only `MANAGER_APPROVE_THRESHOLD_YEN` and `DIRECTOR_APPROVE_THRESHOLD_YEN`. There is no coupling between the two.

### Audit event emission

Every reserve proposal emits a standard `AuditEvent` via the audit interceptor. When the JFSA notification threshold is crossed, the `payload_hash` computation includes a `jfsa_notified: true` flag and the `notification_id`, creating a content-bound link between the audit trail and the notification record:

```typescript
// In AuditInterceptor payload construction:
const eventPayload = {
  claim_id: reserve.claim_id,
  reserve_id: reserve.id,
  proposed_yen: reserve.proposed_yen.toString(),
  category: reserve.category,
  tier: getRequiredApprovalTier(reserve.proposed_yen),
  jfsa_notified: notification !== null,
  notification_id: notification?.id ?? null,
};
```

This means an auditor querying `GET /audit?action=reserve.proposed&claim_id=X` can see whether a specific reserve proposal triggered a JFSA notification without querying the `NotificationToRegulator` table directly.

---

## Consequences

### Positive

- **Threshold detection is automatic and reliable.** Every reserve proposal above ¥100M produces exactly one `NotificationToRegulator` row, committed in the same transaction as the reserve. The compliance team does not rely on manual review or periodic batch scans to identify threshold-crossing events.
- **Atomicity guarantee.** Because the notification write is in the same Prisma transaction as the reserve write, there is no state where a threshold-crossing reserve exists without a corresponding notification (or vice versa). This eliminates the most common failure mode in notification systems: the reserve commits but the notification doesn't.
- **Proposal-time capture, not approval-time.** The notification records when the carrier's exposure was *assessed* at a material level, not when it was authorised. This is more conservative and more defensible under JFSA scrutiny: the regulator can see the full history of material reserve assessments, not just the subset that received approval.
- **No blocking of reserve workflow.** Notification creation is a database write, not an external HTTP call. It adds microseconds to the reserve proposal response time. If the notification write fails (extremely rare), the error is logged and the reserve proposal still succeeds. The compliance team is alerted via structured logging.
- **Clean separation of concerns.** `reserves-jfsa.service.ts` has one responsibility. Changes to the JFSA notification logic (e.g. adding additional notification kinds in Track B) do not touch `reserves.service.ts` and vice versa.
- **Auditor visibility via pending endpoint.** `GET /notifications/jfsa-pending` gives the compliance team a real-time queue view. The `sent_at` field provides a simple mechanism for the daily batch to mark notifications as processed without deleting records.
- **Audit trail linkage.** The `payload_hash` for every `reserve.proposed` audit event includes `jfsa_notified` and `notification_id`, creating a tamper-evident link between the audit log and the notification record.

### Negative / Accepted trade-offs

- **Notification-on-proposal, not notification-on-approval.** A ¥150M reserve that is immediately rejected by a manager still generates a `NotificationToRegulator` row. The compliance team's daily report will include the event with a note that the reserve was subsequently rejected. This is conservative but produces more notifications than a pure approval-time design. The JFSA notification record does not imply that the reserve was approved; it records that a material assessment was made.
- **No deduplication logic in Track A.** If a ¥150M reserve is proposed, rejected, and re-proposed at ¥120M, two `NotificationToRegulator` rows are generated. Track B's daily batch aggregation logic handles deduplication and grouping for the actual JFSA submission packet. Track A captures every event faithfully.
- **`sent_at` update is outside the append-only guarantee.** The `NotificationToRegulator` table allows `sent_at` to be set by the daily batch. This is a deliberate exception to the append-only principle: the `sent_at` field is operational metadata (did we flush this?), not evidentiary content. The evidentiary fields (`kind`, `claim_id`, `reserve_id`, `amount_yen`, `triggered_at`) are never mutated.
- **No wire format in Track A.** The `NotificationToRegulator` row is not a JFSA-compliant submission packet. A carrier deploying Track A in production would need to implement Track B's wire format before actual regulatory compliance is achieved. This is explicitly documented and is not a hidden gap.
- **Single threshold kind in Track A.** `kind = "jfsa_reserve_threshold"` is the only notification kind defined. Other JFSA-reportable events (e.g. catastrophic claims, mass tort indicators) are Track B additions. The `kind` field is a `String`, not an enum, to avoid a migration when new kinds are added.

---

## Alternatives Considered

### Option 1: Approval-time notification (fire when reserve reaches `approved`)

Rejected. Approval may occur days after proposal. A ¥150M reserve proposed on Monday and approved on Wednesday would generate a JFSA notification on Wednesday. If the daily JFSA reporting window closed on Monday night, the event misses the nearest reporting window. Proposal-time capture is more conservative and eliminates the timing gap entirely.

### Option 2: Asynchronous notification via message queue (e.g. SQS, Redis pub/sub)

Considered. Publishing a `JfsaThresholdCrossed` event to a message queue, with a consumer service writing `NotificationToRegulator` rows, would decouple the notification write from the reserve proposal transaction. However:

- It introduces a delivery guarantee problem: if the queue consumer fails, the notification is lost unless the queue has persistence and retry.
- The synchronous in-transaction write provides a stronger guarantee: either both rows exist or neither does.
- Track A's tech stack does not include a message broker. Introducing one for a notification pattern that fires rarely (only for reserves ≥ ¥100M) is disproportionate.
- Track B's architectural expansion (reinsurance signalling, batch JFSA submission) is a natural point to introduce a message broker if the operational pattern justifies it.

The synchronous in-transaction approach is chosen for Track A. The Track B message-queue migration path is left open by not coupling the notification write to any specific async infrastructure.

### Option 3: Post-transaction notification (write after commit, not in transaction)

Rejected. Writing the notification after the reserve transaction commits introduces a window — however small — where the reserve exists without a notification. A server crash between the reserve commit and the notification write leaves the event unrecorded. The in-transaction write eliminates this window at the cost of slightly longer transaction duration (one additional INSERT).

### Option 4: Periodic batch scan for threshold crossings

Rejected. A batch job scanning `Reserve` rows for `proposed_yen >= ¥100M` and `notification_id IS NULL` would eventually detect all threshold crossings, but:

- It introduces a detection lag proportional to the batch interval (minutes to hours).
- The JFSA daily reporting SLA requires same-day capture; a batch that runs every 6 hours provides insufficient precision.
- The scan approach requires a `notification_id` foreign key on `Reserve`, creating a coupling that the dedicated notification service avoids.
- Synchronous capture at proposal time is simpler, more reliable, and more auditable.

### Option 5: Notification threshold stored in database configuration table

Considered and deferred to Track B for the same reasons as the approval threshold (see ADR-005 §Alternatives). The ¥100M threshold is defined in `RESERVE_APPROVAL_POLICY` and requires a deployment to change. Given the regulatory significance of threshold changes (they must themselves be documented and approved), a deployment gate is appropriate.

### Option 6: `NotificationToRegulator` as an append-only audit-style table (no `sent_at` mutation)

Considered. An alternative design marks a notification as processed by creating a second `NotificationSent` record rather than updating `sent_at`. This would be fully append-only but makes the pending-query logic more complex (`WHERE id NOT IN (SELECT notification_id FROM NotificationSent)`). The `sent_at` nullable field is a pragmatic simplification for Track A; Track B may migrate to a separate `sent` record if the notification table grows large enough that a join is more performant.

---

## Test Matrix

The following combinations are covered by `test/reserves.e2e.spec.ts`:

| Scenario | Expected result |
|---|---|
| Reserve proposed at ¥99,999,999 | No `NotificationToRegulator` row created |
| Reserve proposed at exactly ¥100,000,000 | One `NotificationToRegulator` row created with `kind = "jfsa_reserve_threshold"` |
| Reserve proposed at ¥150,000,000 | One `NotificationToRegulator` row created; `amount_yen = "150000000"` |
| `notification.claim_id` matches the proposing claim | Foreign key assertion passes |
| `notification.reserve_id` matches the created reserve | Foreign key assertion passes |
| `notification.sent_at` is null immediately after proposal | Field is null (not yet flushed) |
| Reserve proposal at ¥150M then rejected | Notification row still present; `reserve.approval_status = 'rejected'` |
| Two separate ¥100M+ proposals on the same claim | Two separate `NotificationToRegulator` rows (no deduplication in Track A) |
| `GET /notifications/jfsa-pending` by auditor | Returns all rows with `sent_at = null`; count matches |
| `GET /notifications/jfsa-pending` by adjuster | HTTP 403 |
| `GET /notifications/jfsa-pending` by manager | HTTP 403 |
| AuditEvent for ¥150M reserve proposal | `payload_hash` preimage contains `jfsa_notified: true` |
| AuditEvent for ¥99M reserve proposal | `payload_hash` preimage contains `jfsa_notified: false` |
| Notification write fails (mocked DB error) | Reserve proposal still succeeds; error logged; returns HTTP 201 |
| `crossesJfsaThreshold(new Prisma.Decimal('100000000'))` | `true` (unit test, no DB) |
| `crossesJfsaThreshold(new Prisma.Decimal('99999999'))` | `false` (unit test, no DB) |

---

## Compliance Traceability

| JFSA / regulatory requirement | How this ADR satisfies it |
|---|---|
| JFSA supervisory guidelines — material reserve event reporting | `NotificationToRegulator` row created synchronously at proposal time for every reserve ≥ ¥100M |
| One-business-day reporting SLA | Proposal-time capture (not approval-time) ensures the event is in the daily queue within minutes of occurrence |
| Tamper-evident event record | `NotificationToRegulator` rows are never deleted or amended (except `sent_at`); `AuditEvent.payload_hash` links each proposal to its notification status |
| Traceability to source | `claim_id` and `reserve_id` on each notification provide a complete chain: notification → reserve → claim → adjuster |
| Separation of detection from submission | Track A captures events; Track B implements the wire-format submission. A JFSA readiness reviewer can verify detection logic independently of submission logic |
| Insurance Business Act Art. 128 — business improvement orders | The `sent_at` field and pending-query endpoint give the compliance team visibility into notification backlog, supporting timely response to any JFSA inquiry |

---

## Related ADRs

- **ADR-002** — Audit log immutability (every `reserve.proposed` audit event includes `jfsa_notified` in its `payload_hash`; the audit log is the secondary evidence trail for threshold-crossing events)
- **ADR-004** — Claim status FSM (the claim status is not directly affected by JFSA notifications; however, a claim with a pending JFSA notification in `under_investigation` state is a signal the compliance team monitors when reviewing the daily queue)
- **ADR-005** — Reserve approval tiers (the ¥100M JFSA notification threshold is defined in the same `RESERVE_APPROVAL_POLICY` constants object as the ¥10M director approval threshold; the two thresholds are independent controls evaluated in the same `proposeReserve()` call)

---

## Implementation Reference

| File | Role |
|---|---|
| `src/reserves/reserves-jfsa.service.ts` | `checkAndNotify(reserve, tx)` — evaluates threshold; writes `NotificationToRegulator` within transaction; `crossesJfsaThreshold()` pure function exported for unit testing |
| `src/reserves/reserves.service.ts` | `proposeReserve()` — calls `reserves-jfsa.service.ts#checkAndNotify()` within `prisma.$transaction()`; passes `jfsa_notified` flag to audit interceptor |
| `src/reserves/reserves.controller.ts` | `GET /notifications/jfsa-pending` — restricted to `auditor` role; queries `NotificationToRegulator WHERE sent_at IS NULL` |
| `src/reserves/reserves.module.ts` | Imports and provides `ReservesJfsaService` |
| `prisma/schema.prisma` | `NotificationToRegulator` model — `Decimal(15,0)` for `amount_yen`; `sent_at DateTime?` for flush tracking |
| `src/common/audit.interceptor.ts` | Includes `jfsa_notified` and `notification_id` in `payload_hash` preimage for `reserve.proposed` events |
| `test/reserves.e2e.spec.ts` | Threshold boundary tests, notification field assertions, pending-queue endpoint tests, audit event linkage |
| `docs/adr/006-jfsa-notification-pattern.md` | This document |

---

## Track B Follow-On Actions

1. **JFSA wire-format submission** — implement the EDI or XML submission packet format specified by the JFSA e-Gov portal. `reserves-export.service.ts` provides the data shape; Track B adds the serialisation, authentication, and transmission logic.
2. **Daily batch flush** — implement a scheduled job (`@nestjs/schedule` `@Cron`) that queries `NotificationToRegulator WHERE sent_at IS NULL`, constructs the JFSA submission packet, transmits it, and sets `sent_at = now()` on successful acknowledgement. Includes retry logic with exponential backoff.
3. **Additional notification kinds** — add notification kinds for other JFSA-reportable events: `jfsa_catastrophic_claim` (single claim reserve ≥ ¥500M), `jfsa_mass_tort_indicator` (five or more claims from the same incident), `jfsa_fraud_referral` (SIU referral above threshold). The `kind: String` field on `NotificationToRegulator` accommodates new kinds without a migration.
4. **Submission acknowledgement tracking** — add a `submission_reference` field to `NotificationToRegulator` to store the JFSA portal's acknowledgement reference number. Enables the compliance team to correlate internal records with JFSA receipts.
5. **Deduplication logic** — implement grouping and deduplication rules for the daily batch: multiple threshold-crossing reserve changes on the same claim within one business day may be combined into a single JFSA notification entry per JFSA reporting guidance.
6. **Notification SLA monitoring** — add a health check alert if any `NotificationToRegulator` row has `sent_at IS NULL` and `triggered_at < now() - interval '1 business day'`. Fires a PagerDuty / Slack alert to the compliance operations team to prevent silent SLA violations.
7. **Multi-currency threshold conversion** — when multi-currency reserves are added (Track B, per ADR-005), the JFSA notification threshold comparison must use the yen-equivalent amount rather than the raw `proposed_yen`. `crossesJfsaThreshold()` will accept an additional `yen_equivalent` parameter computed at proposal time using the BOJ reference rate.
8. **Message queue migration** — if the notification volume grows (e.g. during a catastrophe event with thousands of large reserves), evaluate migrating the synchronous in-transaction write to a transactional outbox pattern: write a `NotificationOutbox` row in the same transaction, consume it via a Debezium CDC connector or a polling consumer, and write the final `NotificationToRegulator` row. Preserves atomicity while decoupling the notification write latency from the reserve proposal response time.