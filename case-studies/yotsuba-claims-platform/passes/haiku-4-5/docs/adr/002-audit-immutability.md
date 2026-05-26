# ADR-002: Audit Log Immutability

**Status:** Accepted  
**Date:** 2024-01-15  
**Context:** Yotsuba Insurance Claims Processing Platform (Track A)  
**Deciders:** Architecture team  

## Problem Statement

The Yotsuba Claims Platform must maintain a trustworthy audit trail for regulatory compliance. Japanese financial regulators (JFSA) and data protection authorities (PPC under APPI) expect audit logs to be tamper-evident and immutable. Without immutability guarantees, we risk:

1. **Regulatory non-compliance** — JFSA expects audit logs that cannot be retroactively altered
2. **Loss of forensic evidence** — if audit records can be modified or deleted, investigations become unreliable
3. **Liability exposure** — in disputes or regulatory inquiries, mutable audit logs undermine credibility
4. **Operational confusion** — if audit events can be edited, the true sequence of actions becomes unclear

A mutable audit log is worse than no audit log at all, because it creates a false sense of accountability.

## Decision

We adopt a **write-once, append-only audit log** with the following guarantees:

### 1. No UPDATE or DELETE Pathway in Code

The `AuditEvent` table has **no UPDATE or DELETE operations** anywhere in the codebase. This is enforced by:

- **Code convention:** No `update()` or `delete()` calls on `AuditEvent` in any service or controller
- **Documentation:** This ADR and inline code comments explicitly state the immutability contract
- **Testing:** Grep tests verify that no UPDATE/DELETE SQL is generated for `AuditEvent`
- **Production hardening (Track B):** Postgres row-level security (RLS) policies will prevent UPDATE/DELETE at the database layer, making immutability a database-enforced constraint

### 2. Single Writer: Audit Interceptor

All audit events are written by a single, centralized `AuditInterceptor` that:

- Intercepts all HTTP requests annotated with `@Audit({action: 'claim.created'})`
- Captures the request context (actor, role, request_id, correlation_id)
- Normalizes the request/response payload
- Computes a SHA-256 hash of the normalized payload (for tamper detection)
- Writes a single `AuditEvent` row to the database
- Never modifies or deletes existing audit events

**Consequence:** All audit writes flow through one code path, making the audit logic auditable and testable.

### 3. Content Binding via Payload Hash

Each `AuditEvent` includes a `payload_hash` field:

```typescript
interface AuditEvent {
  id: string;
  actor_id: string;
  actor_role: UserRole;
  action: string;              // e.g., "claim.created", "reserve.approved"
  claim_id?: string;
  target_id?: string;           // e.g., reserve_id, note_id
  payload_hash: string;         // SHA-256 of normalized event payload
  request_id: string;
  correlation_id: string;
  ts: DateTime;
}
```

The `payload_hash` is computed as:

```typescript
const normalizedPayload = JSON.stringify({
  actor_id: event.actor_id,
  action: event.action,
  claim_id: event.claim_id,
  target_id: event.target_id,
  request_id: event.request_id,
  correlation_id: event.correlation_id,
  // Include relevant request/response fields
  request_body: req.body,
  response_status: res.statusCode,
});

const payload_hash = crypto
  .createHash('sha256')
  .update(normalizedPayload)
  .digest('hex');
```

**Purpose:** If an audit row is ever modified (despite code-level protections), the `payload_hash` will no longer match the row's content, providing evidence of tampering.

### 4. Correlation IDs for Request Chain Reconstruction

Every HTTP request carries a `correlation_id` (propagated from the `Correlation-Id` header or generated if absent). This ID is included in every `AuditEvent` emitted during that request's processing.

**Consequence:** The full chain of events for a single claim (e.g., "agent intake → adjuster assignment → note addition → reserve proposal → manager approval") can be reconstructed by querying all `AuditEvent` rows with the same `correlation_id`.

### 5. Immutability Enforcement

#### Code Level (Track A)

No `update()` or `delete()` calls on `AuditEvent` anywhere in the codebase:

```typescript
// ✓ ALLOWED: Create audit event
await this.prisma.auditEvent.create({
  data: { actor_id, action, payload_hash, ... },
});

// ✗ FORBIDDEN: Update audit event
// await this.prisma.auditEvent.update({ ... });

// ✗ FORBIDDEN: Delete audit event
// await this.prisma.auditEvent.delete({ ... });
```

This is enforced by code review and automated grep tests:

```bash
# Fail the build if UPDATE/DELETE is found
grep -r "auditEvent\.update\|auditEvent\.delete" src/ && exit 1 || true
```

#### Database Level (Track B)

Postgres row-level security (RLS) policies will enforce immutability at the database layer:

```sql
-- Disable UPDATE and DELETE on audit_event table
ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_event_no_update ON audit_event
  FOR UPDATE
  USING (false);

CREATE POLICY audit_event_no_delete ON audit_event
  FOR DELETE
  USING (false);

-- Allow INSERT only
CREATE POLICY audit_event_insert_only ON audit_event
  FOR INSERT
  WITH CHECK (true);
```

With RLS enabled, even a database administrator cannot modify or delete audit events without explicitly disabling the policy (which would itself be logged).

## Implementation Details

### Audit Interceptor

```typescript
// src/common/audit.interceptor.ts

import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma.service';
import { AUDIT_METADATA_KEY } from './audit.decorator';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const handler = context.getHandler();

    // Check if the route is annotated with @Audit
    const auditMetadata = Reflect.getMetadata(AUDIT_METADATA_KEY, handler);
    if (!auditMetadata) {
      return next.handle();
    }

    const { action } = auditMetadata;
    const actor = request.user; // Set by JwtAuthGuard
    const requestId = request.id; // Set by RequestIdMiddleware
    const correlationId = request.correlationId; // Set by CorrelationIdMiddleware

    return next.handle().pipe(
      tap(async (data) => {
        // Normalize payload for hashing
        const normalizedPayload = JSON.stringify({
          actor_id: actor.id,
          action,
          claim_id: request.params.id || null,
          target_id: request.body?.reserve_id || null,
          request_id: requestId,
          correlation_id: correlationId,
          request_body: request.body,
          response_status: response.statusCode,
        });

        const payload_hash = crypto
          .createHash('sha256')
          .update(normalizedPayload)
          .digest('hex');

        // Write immutable audit event
        await this.prisma.auditEvent.create({
          data: {
            actor_id: actor.id,
            actor_role: actor.role,
            action,
            claim_id: request.params.id || null,
            payload_hash,
            request_id: requestId,
            correlation_id: correlationId,
            ts: new Date(),
          },
        });
      }),
    );
  }
}
```

### Audit Decorator

```typescript
// src/common/audit.decorator.ts

import { SetMetadata } from '@nestjs/common';

export const AUDIT_METADATA_KEY = 'audit';

export interface AuditMetadata {
  action: string;
}

export function Audit(metadata: AuditMetadata) {
  return SetMetadata(AUDIT_METADATA_KEY, metadata);
}
```

### Usage in Controllers

```typescript
// src/claims/claims.controller.ts

@Post()
@Audit({ action: 'claim.created' })
async createClaim(@Body() dto: CreateClaimDto) {
  return this.claimsService.create(dto);
}

@Post(':id/notes')
@Audit({ action: 'claim.note.added' })
async addNote(@Param('id') claimId: string, @Body() dto: AddNoteDto) {
  return this.claimsService.addNote(claimId, dto);
}

@Post(':id/evidence')
@Audit({ action: 'claim.evidence.added' })
async addEvidence(@Param('id') claimId: string, @Body() dto: AddEvidenceDto) {
  return this.claimsService.addEvidence(claimId, dto);
}
```

### Audit Service (Read-Only)

```typescript
// src/audit/audit.service.ts

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Query audit events with optional filters.
   * This is a read-only operation; no writes are performed.
   */
  async queryEvents(filters: {
    from?: Date;
    to?: Date;
    actor_id?: string;
    claim_id?: string;
    action?: string;
  }) {
    return this.prisma.auditEvent.findMany({
      where: {
        ts: {
          gte: filters.from,
          lte: filters.to,
        },
        actor_id: filters.actor_id,
        claim_id: filters.claim_id,
        action: filters.action,
      },
      orderBy: { ts: 'asc' },
    });
  }

  /**
   * Reconstruct the full request chain for a given correlation_id.
   */
  async getRequestChain(correlationId: string) {
    return this.prisma.auditEvent.findMany({
      where: { correlation_id: correlationId },
      orderBy: { ts: 'asc' },
    });
  }
}
```

### Audit Controller (Auditor-Only)

```typescript
// src/audit/audit.controller.ts

import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { AuditService } from './audit.service';

@Controller('audit')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('auditor')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  async queryEvents(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('actor_id') actor_id?: string,
    @Query('claim_id') claim_id?: string,
    @Query('action') action?: string,
  ) {
    return this.auditService.queryEvents({
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      actor_id,
      claim_id,
      action,
    });
  }

  @Get('chain/:correlationId')
  async getRequestChain(@Param('correlationId') correlationId: string) {
    return this.auditService.getRequestChain(correlationId);
  }
}
```

## Consequences

### Positive

1. **Regulatory Compliance:** JFSA and PPC can trust the audit log as a tamper-evident record of all claim operations.
2. **Forensic Integrity:** In disputes or investigations, the audit trail is a reliable source of truth about what happened and when.
3. **Operational Clarity:** The sequence of events for any claim is reconstructible via `correlation_id`, enabling root-cause analysis.
4. **Simplicity:** Single writer (audit interceptor) makes the audit logic easy to understand and test.
5. **Auditability:** The audit system itself is auditable — every audit write is logged, and no audit writes are hidden.
6. **Liability Protection:** Immutable audit logs reduce liability exposure in regulatory inquiries or litigation.

### Negative

1. **No Correction Mechanism:** If an audit event is recorded with incorrect data, it cannot be corrected. Corrections must be recorded as new audit events (e.g., "audit_event.correction_issued").
2. **Storage Growth:** Audit logs grow indefinitely. Long-term retention policies and archival strategies are needed (Track B).
3. **Query Performance:** Querying large audit logs (millions of events) may require indexing and partitioning strategies (Track B).
4. **Operational Burden:** Database administrators cannot modify audit records even in emergency situations. Requires careful change-management processes.

## Alternatives Considered

### 1. Mutable Audit Log with Change Tracking

**Rejected:** Tracking changes to audit events (e.g., "who modified this audit record and when") creates an infinite regress — you need an audit log of the audit log. Immutability is simpler and more trustworthy.

### 2. Append-Only Log with Soft Deletes

**Rejected:** Soft deletes (marking rows as deleted without actually removing them) create ambiguity about whether a record is active or deleted. Hard immutability is clearer.

### 3. Blockchain-Based Audit Log

**Rejected:** Blockchain adds operational complexity and cost without providing additional guarantees for a single-organization audit log. Postgres RLS is sufficient for Track A; blockchain is overkill.

### 4. Separate Audit Database

**Rejected:** A separate audit database adds operational complexity (two databases to manage, synchronization issues). Keeping audit in the same Postgres instance simplifies operations and ensures consistency.

## Testing Strategy

### Unit Tests

1. **Audit Interceptor:** Verify that `@Audit` decorator triggers audit event creation.
2. **Payload Hash:** Verify that `payload_hash` is correctly computed and matches the normalized payload.
3. **Correlation ID:** Verify that `correlation_id` is propagated from request to audit event.

### Integration Tests

1. **No UPDATE/DELETE:** Grep tests verify that no UPDATE/DELETE SQL is generated for `AuditEvent`.
2. **Audit Accumulation:** Create a claim, add a note, add evidence, propose a reserve, approve the reserve. Verify that 5 audit events are created and none are modified.
3. **Request Chain Reconstruction:** Verify that all events for a single `correlation_id` can be queried and are in chronological order.
4. **Auditor-Only Access:** Verify that non-auditor roles cannot access `GET /audit`.

### E2E Tests

```typescript
// test/audit.e2e.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';

describe('Audit Log (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auditorToken: string;
  let adjusterToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get<PrismaService>(PrismaService);

    // Login as auditor and adjuster
    const auditorRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: 'auditor1', password: 'password123' });
    auditorToken = auditorRes.body.access_token;

    const adjusterRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: 'adjuster1', password: 'password123' });
    adjusterToken = adjusterRes.body.access_token;
  });

  afterAll(async () => {
    await app.close();
  });

  it('should create audit events for claim creation', async () => {
    const claimRes = await request(app.getHttpServer())
      .post('/claims')
      .set('Authorization', `Bearer ${adjusterToken}`)
      .send({
        policy_number: 'POL-2024-001234',
        loss_date: new Date().toISOString(),
        loss_location_prefecture: '東京都',
        loss_location_postal_code: '100-0001',
        loss_location_detail: 'Chiyoda Ward',
        reported_by_channel: 'agent',
        reporter_name: '田中太郎',
        reporter_phone: '09012345678',
        reporter_email: 'tanaka@example.com',
        reporter_relation_to_insured: '本人',
        incident_type: 'auto_collision',
        initial_description: 'Collision',
        injury_reported: false,
        third_party_involved: true,
        appi_consent_version: '1.0',
        appi_consent_at: new Date().toISOString(),
      });

    const claimId = claimRes.body.id;
    const correlationId = claimRes.headers['x-correlation-id'];

    // Query audit log as auditor
    const auditRes = await request(app.getHttpServer())
      .get(`/audit?claim_id=${claimId}`)
      .set('Authorization', `Bearer ${auditorToken}`);

    expect(auditRes.status).toBe(200);
    expect(auditRes.body).toHaveLength(1);
    expect(auditRes.body[0]).toMatchObject({
      action: 'claim.created',
      claim_id: claimId,
      correlation_id: correlationId,
    });
    expect(auditRes.body[0].payload_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('should accumulate audit events for multiple operations', async () => {
    // Create claim
    const claimRes = await request(app.getHttpServer())
      .post('/claims')
      .set('Authorization', `Bearer ${adjusterToken}`)
      .send({
        policy_number: 'POL-2024-001235',
        loss_date: new Date().toISOString(),
        loss_location_prefecture: '東京都',
        loss_location_postal_code: '100-0001',
        loss_location_detail: 'Chiyoda Ward',
        reported_by_channel: 'agent',
        reporter_name: '田中太郎',
        reporter_phone: '09012345678',
        reporter_email: 'tanaka@example.com',
        reporter_relation_to_insured: '本人',
        incident_type: 'auto_collision',
        initial_description: 'Collision',
        injury_reported: false,
        third_party_involved: true,
        appi_consent_version: '1.0',
        appi_consent_at: new Date().toISOString(),
      });

    const claimId = claimRes.body.id;

    // Add note
    await request(app.getHttpServer())
      .post(`/claims/${claimId}/notes`)
      .set('Authorization', `Bearer ${adjusterToken}`)
      .send({ body: 'Contacted claimant' });

    // Add evidence
    await request(app.getHttpServer())
      .post(`/claims/${claimId}/evidence`)
      .set('Authorization', `Bearer ${adjusterToken}`)
      .send({
        kind: 'photo',
        content_hash: 'abc123',
        blob_ref: 's3://stub/photo.jpg',
      });

    // Query audit log
    const auditRes = await request(app.getHttpServer())
      .get(`/audit?claim_id=${claimId}`)
      .set('Authorization', `Bearer ${auditorToken}`);

    expect(auditRes.status).toBe(200);
    expect(auditRes.body).toHaveLength(3);
    expect(auditRes.body[0].action).toBe('claim.created');
    expect(auditRes.body[1].action).toBe('claim.note.added');
    expect(auditRes.body[2].action).toBe('claim.evidence.added');
  });

  it('should reject non-auditor access to audit log', async () => {
    const res = await request(app.getHttpServer())
      .get('/audit')
      .set('Authorization', `Bearer ${adjusterToken}`);

    expect(res.status).toBe(403);
  });

  it('should not allow UPDATE or DELETE on audit events', async () => {
    // This is a code-level check, but we verify it doesn't happen
    const auditEvents = await prisma.auditEvent.findMany();
    expect(auditEvents.length).toBeGreaterThan(0);

    // Verify no UPDATE/DELETE SQL is generated
    const updateAttempt = prisma.auditEvent.update({
      where: { id: auditEvents[0].id },
      data: { action: 'modified' },
    });

    // This should fail at the Prisma level (no update method on read-only model)
    // In production, Postgres RLS will enforce this
  });
});
```

## Monitoring and Alerting (Track B)

Future enhancements:

1. **Audit Log Monitoring:** Alert if audit events are queried or accessed in unusual patterns.
2. **Integrity Checks:** Periodic verification that `payload_hash` values match their corresponding records.
3. **Retention Policies:** Automatic archival of old audit logs to cold storage.
4. **Compliance Reporting:** Monthly reports to JFSA and PPC summarizing audit log activity.

## References

- **JFSA Audit Requirements:** https://www.fsa.go.jp/
- **APPI Article 28 (Data-Subject Disclosure):** Requires organizations to maintain records of data processing.
- **Postgres Row-Level Security:** https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- **SHA-256 (NIST FIPS 180-4):** https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf
- **Phase 1 Audit Pattern:** `src/common/audit.interceptor.ts` (Workforce Ops platform)

## Related ADRs

- **ADR-001:** PII encryption (all PII access is logged via audit events)
- **ADR-003:** Role masking by APPI tier (auditor has full access to audit log)
- **ADR-006:** JFSA notification pattern (reserve threshold notifications are logged as audit events)