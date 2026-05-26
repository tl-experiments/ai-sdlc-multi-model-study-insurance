# ADR-002: Audit Log Immutability

**Status:** Accepted  
**Date:** 2024-01-01  
**Deciders:** Platform Architecture Team  
**Regulated under:** JFSA (金融庁) / APPI (個人情報保護法)  
**Track:** A (convention enforced) — Track B adds Postgres RLS + trigger enforcement

---

## Context

The Claims Processing Platform is a JFSA-regulated system where the integrity of the audit trail is a legal and operational requirement. Insurance regulators, internal compliance teams, and the `auditor` role must be able to trust that every write operation has been faithfully recorded and that no record has been altered or deleted after the fact.

Three distinct concerns drive this requirement:

### 1. JFSA Regulatory Expectation

The Financial Services Agency (金融庁) expects that regulated insurers maintain tamper-evident records of material decisions — reserve changes, claim status transitions, adjuster assignments, and settlement offers. A mutable audit log provides no assurance: an insider could alter or delete a record after a disputed decision. The JFSA expects the log to be relied upon as evidence.

### 2. APPI Article 28 Data-Subject Export Integrity

When a data subject requests disclosure of all information the platform holds about them under APPI Article 28, the audit trail is part of that disclosure. If audit records could be deleted (e.g. to suppress evidence of a prior write), the disclosure would be incomplete and the platform would be in breach of the Article 28 obligation.

### 3. Internal Claims Dispute Resolution

The platform's audit log is the authoritative record for internal disputes: who approved a ¥15M reserve, which adjuster added a note before a status transition, whether a manager reassigned a claim before or after a reserve proposal. These questions arise in litigation, ombudsman complaints, and regulatory examinations. A mutable log cannot answer them reliably.

### Problem Statement

We need an audit log design that:

1. Records every material write operation with sufficient context to reconstruct the event.
2. Provides cryptographic content-binding so tampering with a row is detectable.
3. Has no UPDATE or DELETE code path — not merely by convention but enforced as structurally as the technology stack allows at Track A.
4. Carries enough correlation context (`request_id`, `correlation_id`) to reconstruct the full chain of a multi-step workflow (e.g. FNOL intake → adjuster investigation → reserve proposal → manager approval).
5. Is queryable by auditors without any pathway to modify the underlying rows.

---

## Decision

### Append-only `AuditEvent` table

The `AuditEvent` Prisma model is defined with no UPDATE or DELETE pathway anywhere in the codebase. The only write operation is `prisma.auditEvent.create()`, called exclusively from `src/common/audit.interceptor.ts` via `audit.service.ts#writeEvent()`.

```
Write path (the ONLY write path):
    HTTP Request
        │
        ▼
    [AuditInterceptor]           — fires after successful controller execution
        │
        ▼
    audit.service.ts#writeEvent()
        │
        ▼
    prisma.auditEvent.create()   ← INSERT only; no update, no delete

Read path (the ONLY read path):
    GET /audit   [auditor role only]
        │
        ▼
    audit.service.ts#query()
        │
        ▼
    prisma.auditEvent.findMany() ← SELECT only
```

No service, controller, or utility calls `prisma.auditEvent.update()` or `prisma.auditEvent.delete()`. This is enforced by:

1. **Code convention + peer review** — all PRs are grepped for `auditEvent.update` / `auditEvent.delete`; any match is a blocking review failure.
2. **Automated grep in CI** — the verification script (`tools/verify.mjs`) includes a check that zero occurrences of `auditEvent.update` or `auditEvent.delete` appear in `src/`.
3. **Payload hash content-binding** — even if a row were somehow altered, the `payload_hash` (SHA-256 of the normalised event payload) would no longer match, making tampering detectable.

### `AuditEvent` record structure

Every `AuditEvent` row captures:

| Field | Type | Purpose |
|---|---|---|
| `id` | `cuid()` | Stable identifier |
| `actor_id` | `String` | User who performed the action |
| `actor_role` | `UserRole` | Role at time of action (snapshot; role may change) |
| `action` | `String` | Semantic action name (see Action Taxonomy below) |
| `claim_id` | `String?` | Affected claim (null for non-claim actions) |
| `target_id` | `String?` | Affected sub-resource (reserve ID, note ID, evidence ID, etc.) |
| `payload_hash` | `String` | SHA-256 of normalised event payload — content-binding |
| `request_id` | `String` | Traces to the originating HTTP request (from `X-Request-Id` header or generated UUID) |
| `correlation_id` | `String` | Traces across the full request chain; propagated via `X-Correlation-Id` header |
| `ts` | `DateTime` | ISO 8601 timestamp; set by Postgres `DEFAULT now()` |

### Payload hash computation

The `payload_hash` is computed by `AuditInterceptor` before writing the row:

```
payload = JSON.stringify({
    actor_id,
    actor_role,
    action,
    claim_id,
    target_id,
    request_id,
    correlation_id,
    ts            // ISO string; set before hashing
}, null, 0)      // deterministic key order via sorted replacer

payload_hash = 'sha256:' + crypto.createHash('sha256').update(payload).digest('hex')
```

The hash binds the identity of the actor, the action, the affected resource, and the timestamp into a single verifiable value. Any post-hoc alteration to any of those fields would invalidate the hash. A future audit tool can re-derive the hash and compare.

### Correlation ID propagation

Every `AuditEvent` carries both `request_id` and `correlation_id`. This enables reconstruction of multi-step workflows:

```
Request chain example:

  POST /claims                     correlation_id = C1
      └── AuditEvent: claim.created          correlation_id = C1

  POST /claims/:id/assign           correlation_id = C1  (propagated from X-Correlation-Id header)
      └── AuditEvent: claim.assigned         correlation_id = C1

  POST /claims/:id/reserves         correlation_id = C1
      └── AuditEvent: reserve.proposed       correlation_id = C1

  POST /reserves/:id/approve        correlation_id = C1
      └── AuditEvent: reserve.approved       correlation_id = C1

Query: SELECT * FROM audit_events WHERE correlation_id = 'C1' ORDER BY ts
→ Returns the complete lifecycle of a single claim intake-to-approval chain.
```

The `CorrelationIdMiddleware` (`src/common/correlation-id.middleware.ts`) reads the `X-Correlation-Id` request header, falls back to the `X-Request-Id` value, or generates a new UUID. It is applied globally in `app.module.ts`.

### Action taxonomy

Action names follow a `<resource>.<verb>` dot-notation convention. The full set for Track A:

| Action | Triggered by |
|---|---|
| `claim.created` | `POST /claims` (all channels) |
| `claim.assigned` | `POST /claims/:id/assign` |
| `claim.status.transitioned` | `PATCH /claims/:id/status` |
| `claim.note.added` | `POST /claims/:id/notes` |
| `claim.evidence.added` | `POST /claims/:id/evidence` |
| `claim.witness_statement.added` | `POST /claims/:id/witness-statement` |
| `claim.pii.anonymised` | `DELETE /claims/:id/personal-data-anonymise` |
| `reserve.proposed` | `POST /claims/:id/reserves` |
| `reserve.approved` | `POST /reserves/:id/approve` |
| `reserve.director_approved` | `POST /reserves/:id/director-approve` |
| `reserve.rejected` | `POST /reserves/:id/reject` |
| `jfsa.notification.created` | Synchronous side-effect of reserve crossing ¥100M |
| `auth.login` | `POST /auth/login` (success only) |

### `@Audit()` decorator

Routes that emit audit events are annotated with the `@Audit()` decorator defined in `src/common/audit.decorator.ts`:

```typescript
@Audit({ action: 'claim.note.added' })
@Post(':id/notes')
async addNote(...) { ... }
```

The `AuditInterceptor` reads this metadata after the handler returns successfully. If the handler throws, no audit event is written — failed attempts are captured at the HTTP layer by the structured Pino logger, not in the immutable audit log. This prevents the audit log from accumulating noise from validation failures and auth rejections while ensuring every successful write is recorded.

---

## Consequences

### Positive

- **Regulatory trust.** JFSA examiners and internal auditors can rely on the audit log as tamper-evident evidence. The `auditor` role has read-only access across all claims and all audit events; no write path is available to any role.
- **Dispute resolution.** The full chain of custody for every claim — who created it, who assigned it, who proposed and approved reserves, who transitioned the status — is reconstructible from a single table query filtered by `claim_id`.
- **Cross-request traceability.** `correlation_id` propagation means a single claim's multi-step lifecycle across multiple HTTP requests is reconstructible in any log aggregation tool (e.g. Datadog, CloudWatch Logs Insights, Splunk) by filtering on the correlation ID.
- **Content-binding.** `payload_hash` provides a lightweight tamper-detection mechanism. A database administrator who altered a row would invalidate the hash; a verification job can detect this.
- **Minimal surface area.** `AuditInterceptor` + `audit.service.ts#writeEvent()` is the single write path. The implementation is auditable in two files.

### Negative / Accepted trade-offs

- **No row-level enforcement in Track A.** The immutability guarantee is a code convention, not a database-layer enforcement. A sufficiently privileged database user could issue a raw `UPDATE` or `DELETE` against `audit_events` without the application knowing. This is the primary gap acknowledged for Track B resolution.
- **Audit events accumulate indefinitely.** There is no archival or purge mechanism in Track A. At high claim volumes (millions of claims per year) the table grows without bound. Archival to cold storage is a Track B operational concern.
- **No audit of failed attempts.** Failed authentication attempts and authorisation denials are emitted as structured Pino log lines, not as `AuditEvent` rows. This is intentional (noise reduction in the immutable log) but means the audit table alone does not capture probing activity. In production, the Pino log stream would be shipped to a SIEM.
- **Interceptor fires after handler success only.** If the database write succeeds but the audit interceptor subsequently fails (e.g. due to a transient DB error on the second write), the business write is committed without an audit record. Mitigation: both writes target the same Postgres instance; the interceptor failure is logged at `error` level and triggers an alert. A fully transactional audit write (same transaction as the business write) is a Track B hardening option.

---

## Alternatives Considered

### Option 1: Mutable `AuditEvent` rows with a `modified_at` column

Rejected. A mutable audit log defeats its own purpose. JFSA and APPI compliance both require that the record of what happened cannot be retroactively altered. Even with a `modified_at` column, the original value is lost.

### Option 2: Separate audit database / write-ahead log shipping

Considered for Track B. Shipping the Postgres WAL (write-ahead log) to a separate read-only replica gives a secondary tamper-evident record. However, for Track A POC, the single-database append-only convention is sufficient and avoids operational complexity.

### Option 3: Blockchain / distributed ledger for audit records

Rejected. The operational overhead and latency of a distributed ledger are disproportionate to the POC scope. The payload-hash content-binding approach provides equivalent tamper-detection for the audit record contents without the infrastructure cost. A Merkle-chain extension (each event hashes the previous event's hash) is a Track B option if regulatory examiners require it.

### Option 4: Postgres triggers to block UPDATE/DELETE at DB layer (Track A)

Implemented as part of **Track B**, not Track A. The decision to defer this to Track B is deliberate: it requires a Postgres migration with a trigger function and RLS policies that have non-trivial operational implications (e.g. the application's Prisma migration user must be excluded from the RLS restriction, or migration tooling breaks). The Track A code-convention approach is documented, testable by grep, and sufficient for the POC. The Track B trigger is the production hardening step.

---

## Track B Follow-On Actions

1. **Postgres RLS policy** — define a row-security policy on `audit_events` that permits `INSERT` to the application role and denies `UPDATE` / `DELETE` to all roles including the application role. A superuser exception covers migration-time schema changes only.
2. **Write-blocking trigger** — `CREATE RULE no_update_audit AS ON UPDATE TO audit_events DO INSTEAD NOTHING;` and equivalent for DELETE, as a belt-and-suspenders measure beneath RLS.
3. **WAL replication to read replica** — ship `audit_events` writes to a read-only replica in a separate availability zone for independent tamper detection.
4. **Merkle-chain hash extension** — extend `payload_hash` to include the hash of the preceding event for the same `claim_id`, creating a per-claim chain where any gap or reorder is detectable.
5. **Archival procedure** — move `audit_events` rows older than the regulatory retention period (e.g. 7 years) to cold storage (S3 Glacier equivalent) with a cryptographic manifest.
6. **Transactional audit writes** — explore wrapping business writes and audit writes in a single Postgres transaction to eliminate the gap where a business write commits without an audit record.

---

## Compliance Traceability

| Requirement | How this ADR satisfies it |
|---|---|
| JFSA — tamper-evident records for regulated decisions | Append-only table; `payload_hash` content-binding; no delete pathway |
| APPI Art. 28 — complete data-subject disclosure | Audit trail is preserved even after `personal-data-anonymise`; anonymisation itself emits `claim.pii.anonymised` audit event |
| APPI Art. 19 — accuracy; Art. 20 — security measures | Immutability ensures the record of what data was held (and when) cannot be retroactively altered |
| Internal claims governance | Full chain-of-custody reconstructible per `claim_id`; cross-request chain reconstructible per `correlation_id` |

---

## Related ADRs

- **ADR-001** — PII Encryption (audit events carry `payload_hash`, not PII values; the two ADRs complement each other)
- **ADR-003** — Role masking by APPI tier (the `auditor` role has read-only access to all audit events; this ADR defines the write side)
- **ADR-006** — JFSA notification pattern (`jfsa.notification.created` audit events are written by the same interceptor)

---

## Implementation Reference

| File | Role |
|---|---|
| `src/common/audit.interceptor.ts` | The single write path for `AuditEvent` rows; reads `@Audit()` metadata; computes `payload_hash` |
| `src/common/audit.decorator.ts` | `@Audit({action: '...'})` — annotates controller methods that must emit audit events |
| `src/audit/audit.service.ts` | `writeEvent()` (called by interceptor) and `query()` (called by controller); no update/delete methods |
| `src/audit/audit.controller.ts` | `GET /audit` — auditor-only; read-only query interface |
| `src/common/correlation-id.middleware.ts` | Propagates `correlation_id` from request headers into every log line and audit event |
| `prisma/schema.prisma` | `AuditEvent` model — no `@updatedAt`; append semantics by design |
| `docs/adr/002-audit-immutability.md` | This document |