# ADR-005: Reserve Approval Tiers

**Status:** Accepted  
**Date:** 2024-01-15  
**Context:** Yotsuba Insurance Claims Processing Platform (Track A)  
**Deciders:** Architecture team  

## Problem Statement

The Yotsuba Claims Platform must manage reserve (loss reserve) amounts with appropriate approval authority. Reserves represent money set aside against expected claim payouts and are a critical regulatory concern for Japanese P&C insurers. Without tiered approval authority, we risk:

1. **Regulatory non-compliance** — JFSA expects reserves above certain thresholds to require director-level approval
2. **Operational inefficiency** — requiring director approval for every reserve (including small ones) creates bottlenecks
3. **Fraud risk** — a single adjuster could propose and approve large reserves without oversight
4. **Audit gaps** — unclear which approver is responsible for which reserve amounts
5. **IFRS17 exposure** — reserve adequacy is reported to regulators; inadequate approval controls undermine credibility

A single approval level (e.g., "all reserves require manager approval") is insufficient because it either creates bottlenecks (if all require director approval) or leaves large reserves unvetted (if all require only adjuster approval).

## Decision

We adopt a **tiered reserve approval system** with three approval levels based on reserve amount:

### 1. Approval Tiers

| Reserve Amount | Approval Required | Approver Role | Rationale |
|---|---|---|---|
| ≤ ¥1,000,000 | Self-approving | Adjuster (proposer) | Small reserves are routine; adjuster can approve own proposal |
| ¥1,000,001 – ¥10,000,000 | Manager approval | `manager` | Medium reserves require peer review; manager oversees adjuster's work |
| > ¥10,000,000 | Manager + Director approval | `manager` + `claims_director` | Large reserves require director-level sign-off; regulatory threshold |

**Rationale:**

- **¥1M threshold:** Typical daily reserve authority for an experienced adjuster. Below this, adjuster judgment is trusted.
- **¥10M threshold:** Regulatory threshold for JFSA notification (ADR-006). Reserves crossing this amount trigger regulatory reporting; director approval ensures awareness.
- **Director approval:** Only users with `is_claims_director = true` can approve reserves > ¥10M. This is a separate flag on the `User` model, allowing a manager to be designated as a claims director.

### 2. Reserve Approval Workflow

```
┌──────────────────────────────────────────────────────────────────┐
│                    RESERVE APPROVAL WORKFLOW                     │
└──────────────────────────────────────────────────────────────────┘

  Adjuster proposes reserve
           │
           ▼
  ┌─────────────────────┐
  │ Is amount ≤ ¥1M?    │
  └────────┬────────────┘
           │
      Yes  │  No
           │
      ┌────▼────────────────────────┐
      │                             │
      ▼                             ▼
  Auto-approve              ┌──────────────────┐
  (adjuster)                │ Is amount ≤ ¥10M?│
      │                     └────┬─────────────┘
      │                         │
      │                    Yes  │  No
      │                         │
      │                    ┌────▼──────────────┐
      │                    │ Manager approves  │
      │                    │ (approval_status  │
      │                    │  = 'approved')    │
      │                    └────┬──────────────┘
      │                         │
      │                         ▼
      │                    ┌──────────────────┐
      │                    │ Director approves │
      │                    │ (director_       │
      │                    │  approved_by_id) │
      │                    └────┬──────────────┘
      │                         │
      └────────────┬────────────┘
                   │
                   ▼
           Reserve approved
           (ready for settlement)
```

### 3. Reserve Entity and Approval Fields

The `Reserve` model in Prisma schema includes approval tracking:

```prisma
model Reserve {
  id                      String          @id @default(cuid())
  claim_id                String
  claim                   Claim           @relation(fields: [claim_id], references: [id])
  category                ReserveCategory
  proposed_yen            Decimal         @db.Decimal(15,0)
  prior_yen               Decimal?        @db.Decimal(15,0)
  justification           String          // >= 50 chars
  proposed_by_id          String
  proposed_at             DateTime        @default(now())
  approval_status         ApprovalStatus  @default(pending)
  approved_by_id          String?         // Manager approval
  approved_at             DateTime?
  director_approved_by_id String?         // Director approval (for > ¥10M)
  director_approved_at    DateTime?
  reason_for_rejection    String?

  @@index([claim_id, proposed_at])
  @@index([approval_status])
}

enum ApprovalStatus { pending  approved  rejected }
```

### 4. Service Layer: Approval Rules

The reserves service encodes the approval tiers as pure functions:

```typescript
// src/reserves/reserves.service.ts

import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Reserve, User, ApprovalStatus } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';

// Approval thresholds (in yen)
const SELF_APPROVE_THRESHOLD = new Decimal(1_000_000);
const DIRECTOR_APPROVE_THRESHOLD = new Decimal(10_000_000);

export interface ApprovalRequirement {
  level: 'self' | 'manager' | 'director';
  reason: string;
}

@Injectable()
export class ReservesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Determine the approval requirement for a reserve amount.
   * Pure function; no side effects.
   */
  getApprovalRequirement(amountYen: Decimal): ApprovalRequirement {
    if (amountYen.lte(SELF_APPROVE_THRESHOLD)) {
      return {
        level: 'self',
        reason: `Reserve ≤ ¥${SELF_APPROVE_THRESHOLD.toString()} is self-approving`,
      };
    }

    if (amountYen.lte(DIRECTOR_APPROVE_THRESHOLD)) {
      return {
        level: 'manager',
        reason: `Reserve ¥${SELF_APPROVE_THRESHOLD.toString()} – ¥${DIRECTOR_APPROVE_THRESHOLD.toString()} requires manager approval`,
      };
    }

    return {
      level: 'director',
      reason: `Reserve > ¥${DIRECTOR_APPROVE_THRESHOLD.toString()} requires manager + director approval`,
    };
  }

  /**
   * Propose a new reserve.
   * If amount <= ¥1M, auto-approve.
   * Otherwise, set approval_status = 'pending'.
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

    const requirement = this.getApprovalRequirement(proposedYen);

    // Get prior reserve (if any) for this claim
    const priorReserve = await this.prisma.reserve.findFirst({
      where: { claim_id: claimId },
      orderBy: { proposed_at: 'desc' },
    });

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

    // If reserve crosses JFSA threshold, emit notification
    if (proposedYen.gte(DIRECTOR_APPROVE_THRESHOLD)) {
      await this.prisma.notificationToRegulator.create({
        data: {
          kind: 'jfsa_reserve_threshold',
          claim_id: claimId,
          reserve_id: reserve.id,
          amount_yen: proposedYen,
        },
      });
    }

    return reserve;
  }

  /**
   * Manager approves a reserve.
   * Allowed only if:
   * - approval_status = 'pending'
   * - proposed_yen <= ¥10M (director approval required for larger amounts)
   * - actor is a manager
   */
  async approveReserve(
    reserveId: string,
    approver: User,
  ): Promise<Reserve> {
    const reserve = await this.prisma.reserve.findUnique({
      where: { id: reserveId },
    });

    if (!reserve) {
      throw new BadRequestException(`Reserve ${reserveId} not found`);
    }

    if (reserve.approval_status !== 'pending') {
      throw new BadRequestException(
        `Reserve is already ${reserve.approval_status}`,
      );
    }

    if (approver.role !== 'manager') {
      throw new ForbiddenException(
        'Only managers can approve reserves',
      );
    }

    // Check if reserve exceeds manager approval threshold
    if (reserve.proposed_yen.gt(DIRECTOR_APPROVE_THRESHOLD)) {
      throw new BadRequestException(
        `Reserve > ¥${DIRECTOR_APPROVE_THRESHOLD.toString()} requires director approval. Use director-approve endpoint.`,
      );
    }

    // Approve the reserve
    const updated = await this.prisma.reserve.update({
      where: { id: reserveId },
      data: {
        approval_status: 'approved',
        approved_by_id: approver.id,
        approved_at: new Date(),
      },
    });

    return updated;
  }

  /**
   * Director approves a reserve.
   * Allowed only if:
   * - approval_status = 'pending'
   * - proposed_yen > ¥10M
   * - actor is a manager with is_claims_director = true
   */
  async directorApproveReserve(
    reserveId: string,
    approver: User,
  ): Promise<Reserve> {
    const reserve = await this.prisma.reserve.findUnique({
      where: { id: reserveId },
    });

    if (!reserve) {
      throw new BadRequestException(`Reserve ${reserveId} not found`);
    }

    if (reserve.approval_status !== 'pending') {
      throw new BadRequestException(
        `Reserve is already ${reserve.approval_status}`,
      );
    }

    if (approver.role !== 'manager' || !approver.is_claims_director) {
      throw new ForbiddenException(
        'Only claims directors can approve reserves > ¥10M',
      );
    }

    // Check if reserve is actually > ¥10M
    if (reserve.proposed_yen.lte(DIRECTOR_APPROVE_THRESHOLD)) {
      throw new BadRequestException(
        `Reserve ≤ ¥${DIRECTOR_APPROVE_THRESHOLD.toString()} does not require director approval. Use approve endpoint.`,
      );
    }

    // Approve the reserve
    const updated = await this.prisma.reserve.update({
      where: { id: reserveId },
      data: {
        approval_status: 'approved',
        director_approved_by_id: approver.id,
        director_approved_at: new Date(),
      },
    });

    return updated;
  }

  /**
   * Reject a reserve.
   * Allowed only if approval_status = 'pending'.
   * Actor must be a manager.
   */
  async rejectReserve(
    reserveId: string,
    rejecter: User,
    reason: string,
  ): Promise<Reserve> {
    const reserve = await this.prisma.reserve.findUnique({
      where: { id: reserveId },
    });

    if (!reserve) {
      throw new BadRequestException(`Reserve ${reserveId} not found`);
    }

    if (reserve.approval_status !== 'pending') {
      throw new BadRequestException(
        `Cannot reject a ${reserve.approval_status} reserve`,
      );
    }

    if (rejecter.role !== 'manager') {
      throw new ForbiddenException(
        'Only managers can reject reserves',
      );
    }

    const updated = await this.prisma.reserve.update({
      where: { id: reserveId },
      data: {
        approval_status: 'rejected',
        reason_for_rejection: reason,
      },
    });

    return updated;
  }
}
```

### 5. Controller Integration

The reserves controller exposes three approval endpoints:

```typescript
// src/reserves/reserves.controller.ts

import {
  Controller,
  Post,
  Param,
  Body,
  UseGuards,
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { CurrentUser } from '../common/current-user.decorator';
import { Audit } from '../common/audit.decorator';
import { ReservesService } from './reserves.service';
import { User } from '@prisma/client';
import { ProposeReserveDto } from './dto/propose-reserve.dto';
import { RejectReserveDto } from './dto/reject-reserve.dto';

@Controller('reserves')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReservesController {
  constructor(private readonly reservesService: ReservesService) {}

  /**
   * Propose a new reserve.
   * Adjuster proposes; if <= ¥1M, auto-approved.
   * Otherwise, pending manager approval.
   */
  @Post()
  @Roles('adjuster')
  @Audit({ action: 'reserve.proposed' })
  async proposeReserve(
    @Body() dto: ProposeReserveDto,
    @CurrentUser() user: User,
  ) {
    return this.reservesService.proposeReserve(
      dto.claim_id,
      dto.category,
      dto.proposed_yen,
      dto.justification,
      user,
    );
  }

  /**
   * Manager approves a reserve.
   * Allowed only if proposed_yen <= ¥10M.
   * For larger amounts, use director-approve endpoint.
   */
  @Post(':id/approve')
  @Roles('manager')
  @Audit({ action: 'reserve.approved' })
  async approveReserve(
    @Param('id') reserveId: string,
    @CurrentUser() user: User,
  ) {
    try {
      return await this.reservesService.approveReserve(reserveId, user);
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw new UnprocessableEntityException(error.message);
      }
      throw error;
    }
  }

  /**
   * Director approves a reserve.
   * Allowed only if proposed_yen > ¥10M.
   * Actor must be a manager with is_claims_director = true.
   */
  @Post(':id/director-approve')
  @Roles('manager')
  @Audit({ action: 'reserve.director_approved' })
  async directorApproveReserve(
    @Param('id') reserveId: string,
    @CurrentUser() user: User,
  ) {
    try {
      return await this.reservesService.directorApproveReserve(
        reserveId,
        user,
      );
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw new UnprocessableEntityException(error.message);
      }
      throw error;
    }
  }

  /**
   * Reject a reserve.
   * Manager can reject a pending reserve.
   */
  @Post(':id/reject')
  @Roles('manager')
  @Audit({ action: 'reserve.rejected' })
  async rejectReserve(
    @Param('id') reserveId: string,
    @Body() dto: RejectReserveDto,
    @CurrentUser() user: User,
  ) {
    try {
      return await this.reservesService.rejectReserve(
        reserveId,
        user,
        dto.reason_for_rejection,
      );
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw new UnprocessableEntityException(error.message);
      }
      throw error;
    }
  }
}
```

### 6. DTOs

```typescript
// src/reserves/dto/propose-reserve.dto.ts

import {
  IsString,
  IsEnum,
  IsDecimal,
  MinLength,
  IsNotEmpty,
} from 'class-validator';
import { Decimal } from '@prisma/client/runtime/library';
import { ReserveCategory } from '@prisma/client';

export class ProposeReserveDto {
  @IsString()
  @IsNotEmpty()
  claim_id: string;

  @IsEnum(ReserveCategory)
  category: ReserveCategory;

  @IsDecimal()
  proposed_yen: Decimal;

  @IsString()
  @MinLength(50)
  justification: string;
}
```

```typescript
// src/reserves/dto/reject-reserve.dto.ts

import { IsString, MinLength } from 'class-validator';

export class RejectReserveDto {
  @IsString()
  @MinLength(10)
  reason_for_rejection: string;
}
```

## Consequences

### Positive

1. **Regulatory Compliance:** JFSA expects tiered approval for large reserves. The ¥10M threshold aligns with regulatory expectations.
2. **Operational Efficiency:** Small reserves (≤ ¥1M) are auto-approved, reducing bottlenecks. Adjusters can move quickly on routine claims.
3. **Fraud Prevention:** Large reserves require director-level sign-off, preventing a single adjuster from committing large amounts without oversight.
4. **Audit Trail:** Every approval is recorded with `approved_by_id`, `approved_at`, `director_approved_by_id`, `director_approved_at`. Full history is queryable.
5. **Clarity:** Approval requirements are explicit and documented. Adjusters know exactly what approval is needed for a given amount.
6. **Flexibility:** Thresholds are constants in the service layer. Changing thresholds requires only updating two numbers and re-testing.
7. **IFRS17 Ready:** Reserve approval status is tracked, enabling accurate reserve adequacy reporting to regulators.

### Negative

1. **Complexity:** Three approval levels add complexity to the approval workflow. Adjusters and managers must understand the tiers.
2. **Bottleneck Risk:** If directors are unavailable, large reserves can be delayed. Requires operational planning (e.g., backup directors).
3. **Threshold Rigidity:** Thresholds are fixed in code. Changing them requires a code deployment, not a configuration change. (Mitigated by keeping thresholds as constants in a single file.)
4. **No Partial Approval:** A reserve > ¥10M cannot be approved by a manager alone; it requires director approval. No "manager approval pending director approval" state.

## Alternatives Considered

### 1. Single Approval Level (All Reserves Require Manager Approval)

**Rejected:** Creates bottlenecks for routine claims. Managers would be overwhelmed with small-reserve approvals.

### 2. Single Approval Level (All Reserves Auto-Approved)

**Rejected:** Large reserves (¥100M+) would bypass oversight entirely. Fraud risk and regulatory non-compliance.

### 3. Continuous Approval Curve (Approval Required = f(amount))

**Rejected:** Too complex. Thresholds are simpler and more auditable.

### 4. Approval by Reserve Category (e.g., ALAE Always Requires Approval)

**Rejected:** Category-based approval doesn't align with regulatory thresholds. Amount is the primary risk factor.

### 5. Approval by Claim Severity (e.g., Catastrophic Claims Always Require Director Approval)

**Rejected:** Severity is subjective. Amount-based thresholds are objective and auditable.

## Testing Strategy

### Unit Tests

```typescript
// test/reserves-approval.spec.ts

import { ReservesService } from '../src/reserves/reserves.service';
import { Decimal } from '@prisma/client/runtime/library';

describe('Reserve Approval Tiers', () => {
  let service: ReservesService;

  beforeEach(() => {
    service = new ReservesService(null); // Mock PrismaService
  });

  describe('getApprovalRequirement', () => {
    it('should return self-approval for ≤ ¥1M', () => {
      const requirement = service.getApprovalRequirement(
        new Decimal(1_000_000),
      );
      expect(requirement.level).toBe('self');
    });

    it('should return manager approval for ¥1M–¥10M', () => {
      const requirement = service.getApprovalRequirement(
        new Decimal(5_000_000),
      );
      expect(requirement.level).toBe('manager');
    });

    it('should return director approval for > ¥10M', () => {
      const requirement = service.getApprovalRequirement(
        new Decimal(15_000_000),
      );
      expect(requirement.level).toBe('director');
    });

    it('should return director approval for exactly ¥10M + 1', () => {
      const requirement = service.getApprovalRequirement(
        new Decimal(10_000_001),
      );
      expect(requirement.level).toBe('director');
    });
  });
});
```

### Integration Tests

```typescript
// test/reserves-approval.e2e.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';

describe('Reserve Approval Tiers (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adjusterToken: string;
  let managerToken: string;
  let directorToken: string;
  let claimId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get<PrismaService>(PrismaService);

    // Login as different roles
    const adjusterRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: 'adjuster1', password: 'password123' });
    adjusterToken = adjusterRes.body.access_token;

    const managerRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: 'manager1', password: 'password123' });
    managerToken = managerRes.body.access_token;

    const directorRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: 'director1', password: 'password123' });
    directorToken = directorRes.body.access_token;

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

  it('should auto-approve reserve ≤ ¥1M', async () => {
    const res = await request(app.getHttpServer())
      .post('/reserves')
      .set('Authorization', `Bearer ${adjusterToken}`)
      .send({
        claim_id: claimId,
        category: 'loss_unpaid',
        proposed_yen: '500000',
        justification:
          'Initial assessment of vehicle damage. Repair estimate obtained from authorized dealer.',
      });

    expect(res.status).toBe(201);
    expect(res.body.approval_status).toBe('approved');
    expect(res.body.approved_by_id).toBe(res.body.proposed_by_id);
  });

  it('should require manager approval for ¥1M–¥10M', async () => {
    const res = await request(app.getHttpServer())
      .post('/reserves')
      .set('Authorization', `Bearer ${adjusterToken}`)
      .send({
        claim_id: claimId,
        category: 'loss_unpaid',
        proposed_yen: '5000000',
        justification:
          'Comprehensive assessment of property damage. Multiple repair quotes obtained and reviewed.',
      });

    expect(res.status).toBe(201);
    expect(res.body.approval_status).toBe('pending');
    expect(res.body.approved_by_id).toBeNull();
  });

  it('manager should approve reserve ¥1M–¥10M', async () => {
    // Propose reserve
    const proposeRes = await request(app.getHttpServer())
      .post('/reserves')
      .set('Authorization', `Bearer ${adjusterToken}`)
      .send({
        claim_id: claimId,
        category: 'loss_unpaid',
        proposed_yen: '7500000',
        justification:
          'Detailed investigation completed. Third-party liability confirmed. Reserve reflects expected settlement.',
      });

    const reserveId = proposeRes.body.id;

    // Manager approves
    const approveRes = await request(app.getHttpServer())
      .post(`/reserves/${reserveId}/approve`)
      .set('Authorization', `Bearer ${managerToken}`);

    expect(approveRes.status).toBe(200);
    expect(approveRes.body.approval_status).toBe('approved');
    expect(approveRes.body.approved_by_id).toBeDefined();
  });

  it('should require director approval for > ¥10M', async () => {
    const res = await request(app.getHttpServer())
      .post('/reserves')
      .set('Authorization', `Bearer ${adjusterToken}`)
      .send({
        claim_id: claimId,
        category: 'loss_unpaid',
        proposed_yen: '15000000',
        justification:
          'Major incident with multiple claimants. Comprehensive investigation ongoing. Reserve reflects worst-case scenario.',
      });

    expect(res.status).toBe(201);
    expect(res.body.approval_status).toBe('pending');
  });

  it('manager should reject > ¥10M reserve approval', async () => {
    // Propose reserve > ¥10M
    const proposeRes = await request(app.getHttpServer())
      .post('/reserves')
      .set('Authorization', `Bearer ${adjusterToken}`)
      .send({
        claim_id: claimId,
        category: 'loss_unpaid',
        proposed_yen: '20000000',
        justification:
          'Catastrophic incident. Multiple injuries reported. Reserve reflects comprehensive settlement estimate.',
      });

    const reserveId = proposeRes.body.id;

    // Manager tries to approve (should fail)
    const approveRes = await request(app.getHttpServer())
      .post(`/reserves/${reserveId}/approve`)
      .set('Authorization', `Bearer ${managerToken}`);

    expect(approveRes.status).toBe(422);
    expect(approveRes.body.message).toContain('director approval');
  });

  it('director should approve > ¥10M reserve', async () => {
    // Propose reserve > ¥10M
    const proposeRes = await request(app.getHttpServer())
      .post('/reserves')
      .set('Authorization', `Bearer ${adjusterToken}`)
      .send({
        claim_id: claimId,
        category: 'loss_unpaid',
        proposed_yen: '25000000',
        justification:
          'Catastrophic incident with significant third-party liability. Reserve reflects comprehensive settlement estimate.',
      });

    const reserveId = proposeRes.body.id;

    // Director approves
    const approveRes = await request(app.getHttpServer())
      .post(`/reserves/${reserveId}/director-approve`)
      .set('Authorization', `Bearer ${directorToken}`);

    expect(approveRes.status).toBe(200);
    expect(approveRes.body.approval_status).toBe('approved');
    expect(approveRes.body.director_approved_by_id).toBeDefined();
  });

  it('should reject reserve with insufficient justification', async () => {
    const res = await request(app.getHttpServer())
      .post('/reserves')
      .set('Authorization', `Bearer ${adjusterToken}`)
      .send({
        claim_id: claimId,
        category: 'loss_unpaid',
        proposed_yen: '1000000',
        justification: 'Too short', // < 50 chars
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('at least 50 characters');
  });

  it('should reject approval of already-approved reserve', async () => {
    // Propose and auto-approve small reserve
    const proposeRes = await request(app.getHttpServer())
      .post('/reserves')
      .set('Authorization', `Bearer ${adjusterToken}`)
      .send({
        claim_id: claimId,
        category: 'loss_unpaid',
        proposed_yen: '500000',
        justification:
          'Initial assessment of vehicle damage. Repair estimate obtained from authorized dealer.',
      });

    const reserveId = proposeRes.body.id;

    // Manager tries to approve (should fail)
    const approveRes = await request(app.getHttpServer())
      .post(`/reserves/${reserveId}/approve`)
      .set('Authorization', `Bearer ${managerToken}`);

    expect(approveRes.status).toBe(422);
    expect(approveRes.body.message).toContain('already approved');
  });

  it('should allow manager to reject pending reserve', async () => {
    // Propose reserve requiring manager approval
    const proposeRes = await request(app.getHttpServer())
      .post('/reserves')
      .set('Authorization', `Bearer ${adjusterToken}`)
      .send({
        claim_id: claimId,
        category: 'loss_unpaid',
        proposed_yen: '8000000',
        justification:
          'Detailed investigation completed. Third-party liability confirmed. Reserve reflects expected settlement.',
      });

    const reserveId = proposeRes.body.id;

    // Manager rejects
    const rejectRes = await request(app.getHttpServer())
      .post(`/reserves/${reserveId}/reject`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        reason_for_rejection:
          'Investigation incomplete. Additional evidence required before reserve approval.',
      });

    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.approval_status).toBe('rejected');
    expect(rejectRes.body.reason_for_rejection).toBeDefined();
  });
});
```

## Monitoring and Alerting

All reserve approvals are logged via the `AuditInterceptor` (ADR-002). When a reserve is approved or rejected, an `AuditEvent` is recorded with:

- `actor_id` — who approved/rejected
- `action` — "reserve.approved", "reserve.director_approved", or "reserve.rejected"
- `claim_id` — which claim
- `target_id` — reserve ID
- `correlation_id` — request chain for traceability

Auditors can query the audit log to see the full approval history for any reserve, enabling root-cause analysis and regulatory compliance verification.

## References

- **JFSA Reserve Adequacy Requirements:** https://www.fsa.go.jp/
- **IFRS 17 (Insurance Contracts):** Requires disclosure of reserve adequacy and approval processes
- **Japanese Insurance Business Law (保険業法):** Requires appropriate controls over reserve setting
- **Phase 1 Approval Patterns:** `src/common/approval.service.ts` (Workforce Ops platform)

## Related ADRs

- **ADR-002:** Audit log immutability (all reserve approvals are logged via AuditEvent)
- **ADR-004:** Claim status FSM (reserve approval is a prerequisite for settlement_offered transition)
- **ADR-006:** JFSA notification pattern (reserves > ¥10M trigger regulatory notifications)