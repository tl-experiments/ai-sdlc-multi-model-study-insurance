# ADR-002: Audit Log Immutability

**Status:** Accepted (POC-grade) · **Pass:** 1 (Opus-only)

## Context
Auditors must trust the contents of the audit log. Tampering by an admin must be prevented or detectable.

## Decision
No application code path mutates AuditLog rows. The only writer is `AuditInterceptor` (insert-only). Auditor-only read; `GET /audit` is gated to role `auditor`. POC enforcement is convention; documented as a SQLite limitation.

## Consequences
- **+** Single point of write means a single audit point of code review.
- **−** A malicious admin with DB access can tamper with the SQLite file. Acceptable for POC; in prod use Postgres RLS + INSERT-only grant + per-row HMAC chain.
