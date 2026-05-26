# ADR 002: Audit Trail Immutability and Integrity

## Status
Accepted

## Context
Our system is required to maintain a reliable, tamper-evident audit trail of all critical operations, such as customer profile modifications, claim status transitions, and security-sensitive events. In compliance-heavy environments (such as insurance and finance), audit logs must serve as a single source of truth that cannot be altered or deleted, even by system administrators or compromised application processes.

If an attacker gains unauthorized access to the application or database, or if an internal user attempts to cover their tracks, they must not be able to modify or delete existing audit records. Therefore, we need to establish a robust strategy to guarantee the immutability and integrity of our audit logs.

## Decision
We will implement a multi-layered approach to guarantee audit trail immutability and integrity across the application and database layers:

### 1. Append-Only Design
- The `AuditLog` table will be strictly append-only.
- The application code will only support creating (`INSERT`) and reading (`SELECT`) audit records. No application flows or APIs will ever expose update or delete capabilities for audit data.

### 2. Application-Level Prevention (Prisma Client Extensions)
- We will utilize Prisma Client Extensions to intercept database queries at runtime.
- Any attempt to execute mutation operations such as `update`, `updateMany`, `upsert`, `delete`, or `deleteMany` on the `AuditLog` model will be intercepted and blocked, throwing a strict runtime exception before the query is sent to the database.

### 3. Database-Level Restrictions
- **Database User Permissions**: In production, the database user account used by the NestJS application will be granted restricted permissions. It will have `SELECT` and `INSERT` privileges on the `AuditLog` table, but will be explicitly denied `UPDATE` and `DELETE` privileges.
- **Database Triggers**: We will implement database-level triggers (e.g., PostgreSQL `BEFORE UPDATE OR DELETE` triggers) on the `AuditLog` table that raise an exception and abort the transaction if any modification or deletion is attempted, providing a safety net even if a superuser or direct database connection is used.

### 4. Cryptographic Chaining (Tamper Detection)
- To ensure the integrity of the audit trail and detect any out-of-band database tampering, we will implement a cryptographic hash chain.
- Each audit log entry will store:
  - A SHA-256 hash of its own payload (timestamp, action, actor, resource, metadata).
  - The SHA-256 hash of the immediately preceding audit log entry (`previous_hash`).
- A background integrity-verification job will periodically recalculate and verify the hash chain. Any broken link in the chain will trigger an immediate high-priority security alert.

### 5. Long-Term Archiving and WORM Storage
- To prevent database bloat and ensure permanent preservation, audit logs older than a defined retention period (e.g., 90 days) will be automatically archived.
- Archived logs will be streamed to Write-Once-Read-Many (WORM) storage, such as AWS S3 with Object Lock enabled in Compliance Mode. This guarantees that even root administrators cannot delete or modify the archived logs until the retention period expires.

## Consequences

### Positive (Benefits)
- **Regulatory Compliance**: Fully satisfies strict regulatory requirements (e.g., SOC 2, HIPAA, GDPR) regarding the preservation of untampered audit trails.
- **Non-Repudiation**: Users and administrators cannot deny actions they performed, as the logs cannot be retroactively altered.
- **Early Tamper Detection**: Cryptographic chaining ensures that any direct database manipulation (e.g., by a compromised database administrator account) is immediately detected.
- **Defense in Depth**: Combining application-level blocks, database permissions, triggers, and WORM storage ensures there is no single point of failure for audit integrity.

### Negative (Trade-offs & Mitigations)
- **Storage Growth**: An append-only log can grow rapidly in high-throughput systems.
  - *Mitigation*: Implement the automated archiving strategy to WORM storage and prune the active database table of older records using a secure, authorized database maintenance process that is itself heavily audited.
- **Performance Overhead**: Generating and verifying cryptographic hashes adds minor CPU overhead during log creation.
  - *Mitigation*: SHA-256 is highly optimized on modern hardware, and audit writes are performed asynchronously relative to the primary user response to avoid latency impact.
- **Schema Migration Complexity**: Modifying the structure of an immutable table or its historical data during migrations can be challenging.
  - *Mitigation*: Design the audit log schema with a flexible JSON `metadata` field to accommodate changing payload structures without requiring schema alterations or data migrations.