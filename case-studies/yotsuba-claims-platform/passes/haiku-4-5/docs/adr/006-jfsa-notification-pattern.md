# ADR-006: JFSA Notification Pattern

**Status:** Accepted  
**Date:** 2024-01-15  
**Context:** Yotsuba Insurance Claims Processing Platform (Track A)  
**Deciders:** Architecture team  

## Problem Statement

The Yotsuba Claims Platform must notify the Japanese Financial Services Agency (JFSA) when reserves cross regulatory thresholds. JFSA expects insurers to report significant reserve movements — particularly those exceeding ¥100M — as part of ongoing regulatory oversight. Without a systematic notification mechanism, we risk:

1. **Regulatory non-compliance** — JFSA expects timely notification of material reserve changes
2. **Operational opacity** — no audit trail of which reserves triggered regulatory reporting
3. **Manual process fragility** — relying on ad-hoc email or spreadsheet exports to regulators
4. **Missed thresholds** — a reserve crossing ¥100M could be overlooked without automated detection
5. **Audit gaps** — unclear which reserves were reported and when

A manual reporting process (e.g., "send an email to JFSA once a week") is insufficient because it is error-prone and leaves no audit trail. An automated system that detects threshold crossings and queues notifications is required.

## Decision

We adopt an **event-driven, asynchronous notification pattern** for JFSA threshold detection:

### 1. Notification Trigger

When a reserve is proposed or updated, the reserves service checks if the amount crosses the JFSA threshold (¥100M). If it does, a `NotificationToRegulator` record is created synchronously, capturing:

- **kind:** `"jfsa_reserve_threshold"` (extensible for future notification types)
- **claim_id:** The claim associated with the reserve
- **reserve_id:** The reserve that triggered the notification
- **amount_yen:** The reserve amount (in yen)
- **triggered_at:** Timestamp when the threshold was crossed
- **sent_at:** Null initially; populated when the notification is actually sent to JFSA (Track B)

### 2. Notification Model

The `NotificationToRegulator` entity in the Prisma schema:

```prisma
model NotificationToRegulator {
  id          String   @id @default(cuid())
  kind        String   // "jfsa_reserve_threshold"
  claim_id    String
  reserve_id  String
  amount_yen  Decimal  @db.Decimal(15,0)
  triggered_at DateTime @default(now())
  sent_at     DateTime?  // null until daily batch flushes
}
```

**Rationale:**

- **kind:** Allows future notification types (e.g., "jfsa_claim_reopened", "jfsa_fraud_referral") without schema changes.
- **triggered_at vs. sent_at:** Separates the moment the threshold is detected (synchronous) from the moment it is reported to JFSA (asynchronous, Track B).
- **Decimal for amount_yen:** Ensures precision; no floating-point rounding errors.
- **No UPDATE/DELETE:** Notifications are append-only, like audit events. Once created, they are never modified.

### 3. Threshold Definition

The JFSA notification threshold is a constant in the reserves service:

```typescript
// src/reserves/reserves.service.ts

const JFSA_NOTIFICATION_THRESHOLD = new Decimal(100_000_000); // ¥100M
```

**Rationale:**

- ¥100M is a material threshold for a top-tier Japanese P&C insurer.
- Reserves at or above this amount are typically reported to JFSA as part of quarterly/annual filings.
- The threshold is a constant, not a configuration, to ensure consistency and auditability.

### 4. Notification Emission

When a reserve is proposed, the reserves service checks the threshold and emits a notification if crossed:

```typescript
// src/reserves/reserves.service.ts

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Reserve, User } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { Logger } from '@nestjs/common';

const JFSA_NOTIFICATION_THRESHOLD = new Decimal(100_000_000); // ¥100M

@Injectable()
export class ReservesService {
  private readonly logger = new Logger(ReservesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Propose a new reserve.
   * If amount >= ¥100M, emit a NotificationToRegulator.
   */
  async proposeReserve(
    claimId: string,
    category: string,
    proposedYen: Decimal,
    justification: string,
    proposedBy: User,
  ): Promise<Reserve> {
    // Validate justification length
    if (justification.length < 50) {
      throw new BadRequestException(
        'Justification must be at least 50 characters',
      );
    }

    // Get prior reserve (if any) for this claim
    const priorReserve = await this.prisma.reserve.findFirst({
      where: { claim_id: claimId },
      orderBy: { proposed_at: 'desc' },
    });

    // Determine approval status based on amount
    const requirement = this.getApprovalRequirement(proposedYen);

    // Create the reserve
    const reserve = await this.prisma.reserve.create({
      data: {
        claim_id: claimId,
        category,
        proposed_yen: proposedYen,
        prior_yen: priorReserve?.proposed_yen,
        justification,
        proposed_by_id: proposedBy.id,
        approval_status:
          requirement.level === 'self' ? 'approved' : 'pending',
        approved_by_id:
          requirement.level === 'self' ? proposedBy.id : null,
        approved_at:
          requirement.level === 'self' ? new Date() : null,
      },
    });

    // Check if reserve crosses JFSA threshold
    if (proposedYen.gte(JFSA_NOTIFICATION_THRESHOLD)) {
      await this.emitJfsaNotification(
        claimId,
        reserve.id,
        proposedYen,
      );
    }

    return reserve;
  }

  /**
   * Emit a JFSA notification when a reserve crosses the threshold.
   * This is a synchronous operation; the notification is queued immediately.
   * A (future) daily batch job will send the notification to JFSA.
   */
  private async emitJfsaNotification(
    claimId: string,
    reserveId: string,
    amountYen: Decimal,
  ): Promise<void> {
    const notification = await this.prisma.notificationToRegulator.create({
      data: {
        kind: 'jfsa_reserve_threshold',
        claim_id: claimId,
        reserve_id: reserveId,
        amount_yen: amountYen,
      },
    });

    this.logger.warn(
      `JFSA notification emitted: reserve ${reserveId} (¥${amountYen.toString()}) on claim ${claimId}`,
      'ReservesService',
    );
  }
}
```

### 5. Querying Pending Notifications

Auditors can query pending JFSA notifications via a dedicated endpoint:

```typescript
// src/notifications/notifications.controller.ts

import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  /**
   * Get pending JFSA notifications.
   * Auditor-only endpoint.
   * Query params:
   *   - from: ISO date string (e.g., "2024-01-01")
   *   - to: ISO date string (e.g., "2024-01-31")
   *   - kind: notification kind (e.g., "jfsa_reserve_threshold")
   */
  @Get('jfsa-pending')
  @Roles('auditor')
  async getJfsaPendingNotifications(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('kind') kind?: string,
  ) {
    return this.notificationsService.getPendingNotifications({
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      kind,
    });
  }
}
```

```typescript
// src/notifications/notifications.service.ts

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

export interface GetPendingNotificationsFilter {
  from?: Date;
  to?: Date;
  kind?: string;
}

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get pending JFSA notifications (sent_at is null).
   */
  async getPendingNotifications(
    filter: GetPendingNotificationsFilter,
  ) {
    const where: any = {
      sent_at: null, // Only pending notifications
    };

    if (filter.from || filter.to) {
      where.triggered_at = {};
      if (filter.from) {
        where.triggered_at.gte = filter.from;
      }
      if (filter.to) {
        where.triggered_at.lte = filter.to;
      }
    }

    if (filter.kind) {
      where.kind = filter.kind;
    }

    return this.prisma.notificationToRegulator.findMany({
      where,
      orderBy: { triggered_at: 'desc' },
    });
  }

  /**
   * Mark a notification as sent.
   * Called by the daily batch job (Track B).
   */
  async markAsSent(notificationId: string): Promise<void> {
    await this.prisma.notificationToRegulator.update({
      where: { id: notificationId },
      data: { sent_at: new Date() },
    });
  }
}
```

### 6. Notification Aggregation for IFRS17

The reserves export endpoint (used for IFRS17 reporting) can optionally include pending JFSA notifications:

```typescript
// src/reserves/reserves-export.service.ts

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Decimal } from '@prisma/client/runtime/library';

export interface ReservesExportRow {
  claim_id: string;
  category: string;
  approved_yen: Decimal;
  pending_yen: Decimal;
  jfsa_notification_triggered: boolean;
}

@Injectable()
export class ReservesExportService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Export reserves for a given period, aggregated by category.
   * Suitable for IFRS17 calculation.
   * Includes a flag indicating whether a JFSA notification was triggered.
   */
  async exportByPeriod(period: string): Promise<ReservesExportRow[]> {
    // period format: "YYYY-MM"
    const [year, month] = period.split('-').map(Number);
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);

    // Get all reserves proposed in the period
    const reserves = await this.prisma.reserve.findMany({
      where: {
        proposed_at: {
          gte: startDate,
          lte: endDate,
        },
      },
      include: {
        claim: true,
      },
    });

    // Get all JFSA notifications triggered in the period
    const jfsaNotifications = await this.prisma.notificationToRegulator.findMany({
      where: {
        kind: 'jfsa_reserve_threshold',
        triggered_at: {
          gte: startDate,
          lte: endDate,
        },
      },
    });

    const jfsaReserveIds = new Set(
      jfsaNotifications.map((n) => n.reserve_id),
    );

    // Aggregate by category
    const aggregated = new Map<string, ReservesExportRow>();

    for (const reserve of reserves) {
      const key = reserve.category;
      const existing = aggregated.get(key) || {
        claim_id: '', // Placeholder; not used in aggregation
        category: key,
        approved_yen: new Decimal(0),
        pending_yen: new Decimal(0),
        jfsa_notification_triggered: false,
      };

      if (reserve.approval_status === 'approved') {
        existing.approved_yen = existing.approved_yen.plus(
          reserve.proposed_yen,
        );
      } else if (reserve.approval_status === 'pending') {
        existing.pending_yen = existing.pending_yen.plus(
          reserve.proposed_yen,
        );
      }

      if (jfsaReserveIds.has(reserve.id)) {
        existing.jfsa_notification_triggered = true;
      }

      aggregated.set(key, existing);
    }

    return Array.from(aggregated.values());
  }
}
```

## Consequences

### Positive

1. **Regulatory Compliance:** JFSA thresholds are detected automatically. No manual process to forget or delay.
2. **Audit Trail:** Every threshold crossing is recorded in `NotificationToRegulator`. Auditors can query the full history.
3. **Separation of Concerns:** Detection (synchronous) is separate from reporting (asynchronous, Track B). The POC captures the event shape; the wire format is Track B.
4. **Extensibility:** The `kind` field allows future notification types (e.g., "jfsa_claim_reopened") without schema changes.
5. **Operational Visibility:** Auditors can see pending notifications and track their status (sent vs. pending).
6. **IFRS17 Ready:** The export service can flag reserves that triggered JFSA notifications, enabling accurate disclosure.
7. **No False Positives:** Only reserves >= ¥100M trigger notifications. Routine reserves do not clutter the notification queue.
8. **Immutability:** Notifications are append-only. Once created, they are never deleted or modified (except for `sent_at` timestamp, which is idempotent).

### Negative

1. **Asynchronous Complexity:** The actual JFSA wire format is deferred to Track B. The POC captures the event shape but does not send real notifications.
2. **Threshold Rigidity:** The ¥100M threshold is hardcoded. Changing it requires a code deployment, not a configuration change. (Mitigated by keeping the threshold as a constant in a single file.)
3. **No Real-Time Reporting:** Notifications are queued synchronously but sent asynchronously (Track B). There is a delay between detection and reporting.
4. **Manual Batch Job:** The daily batch job that sends notifications to JFSA is not implemented in Track A. Requires Track B.

## Alternatives Considered

### 1. Synchronous JFSA API Call

**Rejected:** Calling JFSA's API synchronously during reserve proposal would:
- Add latency to the reserve proposal endpoint
- Create a hard dependency on JFSA's API availability
- Risk blocking claim processing if JFSA is unavailable

Asynchronous notification is safer and more resilient.

### 2. Scheduled Batch Job (No Event Capture)

**Rejected:** A scheduled job that queries reserves >= ¥100M every night would:
- Miss intra-day threshold crossings
- Require complex logic to detect "new" notifications (vs. previously reported)
- Leave no audit trail of when thresholds were crossed

Event-driven notification is more accurate and auditable.

### 3. Manual Email Alert

**Rejected:** Sending an email to auditors when a threshold is crossed would:
- Rely on manual action to report to JFSA
- Create no audit trail
- Be error-prone and inconsistent

Automated notification is more reliable.

### 4. Database Trigger (Postgres)

**Rejected:** A Postgres trigger that inserts into `NotificationToRegulator` when a reserve is created would:
- Couple the database schema to business logic
- Make the trigger logic hard to test and audit
- Require Postgres-specific knowledge

Application-level notification (in the service) is more portable and testable.

## Testing Strategy

### Unit Tests

```typescript
// test/reserves-jfsa-notification.spec.ts

import { ReservesService } from '../src/reserves/reserves.service';
import { PrismaService } from '../src/prisma.service';
import { Decimal } from '@prisma/client/runtime/library';
import { User } from '@prisma/client';

describe('JFSA Notification Emission', () => {
  let service: ReservesService;
  let prisma: PrismaService;

  beforeEach(() => {
    // Mock PrismaService
    prisma = {
      reserve: {
        create: jest.fn(),
        findFirst: jest.fn(),
      },
      notificationToRegulator: {
        create: jest.fn(),
      },
    } as any;

    service = new ReservesService(prisma);
  });

  describe('proposeReserve', () => {
    it('should emit JFSA notification for reserve >= ¥100M', async () => {
      const claimId = 'clm_123';
      const reserveId = 'res_456';
      const amount = new Decimal(150_000_000); // ¥150M

      prisma.reserve.findFirst.mockResolvedValue(null);
      prisma.reserve.create.mockResolvedValue({
        id: reserveId,
        claim_id: claimId,
        proposed_yen: amount,
        approval_status: 'pending',
      });

      const user: User = {
        id: 'adj_001',
        username: 'adjuster1',
        role: 'adjuster',
      } as any;

      await service.proposeReserve(
        claimId,
        'loss_unpaid',
        amount,
        'Comprehensive assessment of major incident.',
        user,
      );

      // Verify JFSA notification was created
      expect(prisma.notificationToRegulator.create).toHaveBeenCalledWith({
        data: {
          kind: 'jfsa_reserve_threshold',
          claim_id: claimId,
          reserve_id: reserveId,
          amount_yen: amount,
        },
      });
    });

    it('should NOT emit JFSA notification for reserve < ¥100M', async () => {
      const claimId = 'clm_123';
      const reserveId = 'res_456';
      const amount = new Decimal(50_000_000); // ¥50M

      prisma.reserve.findFirst.mockResolvedValue(null);
      prisma.reserve.create.mockResolvedValue({
        id: reserveId,
        claim_id: claimId,
        proposed_yen: amount,
        approval_status: 'approved',
      });

      const user: User = {
        id: 'adj_001',
        username: 'adjuster1',
        role: 'adjuster',
      } as any;

      await service.proposeReserve(
        claimId,
        'loss_unpaid',
        amount,
        'Initial assessment of property damage.',
        user,
      );

      // Verify JFSA notification was NOT created
      expect(prisma.notificationToRegulator.create).not.toHaveBeenCalled();
    });

    it('should emit JFSA notification for reserve exactly ¥100M', async () => {
      const claimId = 'clm_123';
      const reserveId = 'res_456';
      const amount = new Decimal(100_000_000); // ¥100M exactly

      prisma.reserve.findFirst.mockResolvedValue(null);
      prisma.reserve.create.mockResolvedValue({
        id: reserveId,
        claim_id: claimId,
        proposed_yen: amount,
        approval_status: 'pending',
      });

      const user: User = {
        id: 'adj_001',
        username: 'adjuster1',
        role: 'adjuster',
      } as any;

      await service.proposeReserve(
        claimId,
        'loss_unpaid',
        amount,
        'Major incident assessment. Threshold reserve.',
        user,
      );

      // Verify JFSA notification was created
      expect(prisma.notificationToRegulator.create).toHaveBeenCalled();
    });
  });
});
```

### Integration Tests

```typescript
// test/jfsa-notification.e2e.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';

describe('JFSA Notification (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adjusterToken: string;
  let auditorToken: string;
  let claimId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get<PrismaService>(PrismaService);

    // Login as adjuster and auditor
    const adjusterRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: 'adjuster1', password: 'password123' });
    adjusterToken = adjusterRes.body.access_token;

    const auditorRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: 'auditor1', password: 'password123' });
    auditorToken = auditorRes.body.access_token;

    // Create a claim
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

    claimId = claimRes.body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('should emit JFSA notification when reserve >= ¥100M is proposed', async () => {
    const res = await request(app.getHttpServer())
      .post('/reserves')
      .set('Authorization', `Bearer ${adjusterToken}`)
      .send({
        claim_id: claimId,
        category: 'loss_unpaid',
        proposed_yen: '150000000', // ¥150M
        justification:
          'Catastrophic incident with multiple claimants. Comprehensive investigation ongoing. Reserve reflects worst-case scenario.',
      });

    expect(res.status).toBe(201);

    // Verify JFSA notification was created
    const notifications = await prisma.notificationToRegulator.findMany({
      where: {
        kind: 'jfsa_reserve_threshold',
        claim_id: claimId,
      },
    });

    expect(notifications.length).toBe(1);
    expect(notifications[0].amount_yen.toString()).toBe('150000000');
    expect(notifications[0].sent_at).toBeNull(); // Not yet sent
  });

  it('should NOT emit JFSA notification when reserve < ¥100M is proposed', async () => {
    const res = await request(app.getHttpServer())
      .post('/reserves')
      .set('Authorization', `Bearer ${adjusterToken}`)
      .send({
        claim_id: claimId,
        category: 'loss_unpaid',
        proposed_yen: '50000000', // ¥50M
        justification:
          'Initial assessment of property damage. Repair estimate obtained from authorized dealer.',
      });

    expect(res.status).toBe(201);

    // Verify no JFSA notification was created for this reserve
    const notifications = await prisma.notificationToRegulator.findMany({
      where: {
        kind: 'jfsa_reserve_threshold',
        reserve_id: res.body.id,
      },
    });

    expect(notifications.length).toBe(0);
  });

  it('auditor should query pending JFSA notifications', async () => {
    const res = await request(app.getHttpServer())
      .get('/notifications/jfsa-pending')
      .set('Authorization', `Bearer ${auditorToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Should include the ¥150M notification from the previous test
    const largeReserveNotification = res.body.find(
      (n: any) => n.amount_yen === '150000000',
    );
    expect(largeReserveNotification).toBeDefined();
    expect(largeReserveNotification.sent_at).toBeNull();
  });

  it('auditor should filter JFSA notifications by date range', async () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const res = await request(app.getHttpServer())
      .get('/notifications/jfsa-pending')
      .query({
        from: yesterday.toISOString().split('T')[0],
        to: tomorrow.toISOString().split('T')[0],
      })
      .set('Authorization', `Bearer ${auditorToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('non-auditor should not access JFSA notifications', async () => {
    const res = await request(app.getHttpServer())
      .get('/notifications/jfsa-pending')
      .set('Authorization', `Bearer ${adjusterToken}`);

    expect(res.status).toBe(403); // Forbidden
  });
});
```

## Monitoring and Alerting

All JFSA notifications are logged via the `AuditInterceptor` (ADR-002). When a reserve is proposed and a notification is emitted, an `AuditEvent` is recorded with:

- `actor_id` — who proposed the reserve
- `action` — "reserve.proposed"
- `claim_id` — which claim
- `correlation_id` — request chain for traceability

Auditors can query the audit log to see the full chain: reserve proposal → JFSA notification emission → (Track B) JFSA reporting.

## References

- **JFSA (Financial Services Agency):** https://www.fsa.go.jp/
- **JFSA Reserve Reporting Requirements:** https://www.fsa.go.jp/en/
- **Japanese Insurance Business Law (保険業法):** Requires notification of material reserve changes
- **IFRS 17 (Insurance Contracts):** Requires disclosure of reserve adequacy and regulatory notifications
- **Event-Driven Architecture:** https://en.wikipedia.org/wiki/Event-driven_architecture
- **Phase 1 Notification Patterns:** `src/common/notification.service.ts` (Workforce Ops platform)

## Related ADRs

- **ADR-002:** Audit log immutability (all reserve proposals and JFSA notifications are logged via AuditEvent)
- **ADR-005:** Reserve approval tiers (JFSA threshold is separate from approval tiers; both are checked independently)
- **ADR-001:** PII encryption (JFSA notifications do not contain PII; they reference claim_id and reserve_id only)