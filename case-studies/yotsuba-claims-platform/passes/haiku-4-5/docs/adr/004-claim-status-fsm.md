# ADR-004: Claim Status Finite-State Machine

**Status:** Accepted  
**Date:** 2024-01-15  
**Context:** Yotsuba Insurance Claims Processing Platform (Track A)  
**Deciders:** Architecture team  

## Problem Statement

The Yotsuba Claims Platform must enforce a strict workflow for claim processing. Claims transition through multiple states — from initial intake through investigation, reserve approval, settlement, and closure — and not all transitions are legal. Without a formal state machine, we risk:

1. **Workflow violations** — a claim in `closed_paid` state being reopened without proper authorization
2. **Business logic scattered** — status transition rules spread across multiple controllers and services, making them hard to audit and maintain
3. **Inconsistent error handling** — different endpoints rejecting invalid transitions with different error messages
4. **Regulatory non-compliance** — JFSA expects claims to follow a documented, auditable workflow
5. **Operational confusion** — adjusters and managers unsure which transitions are allowed in which contexts

A generic string-based status field (e.g., `status: string`) with no validation is insufficient because it allows any transition and provides no guidance to callers about why a transition was rejected.

## Decision

We adopt a **pure, deterministic finite-state machine (FSM)** for claim status transitions. The FSM is:

- **Pure function:** Given a current state, target state, claim context, and actor role, it returns `{ok: boolean, reason?: string}`
- **Centralized:** All transition logic lives in a single file (`src/claims/claims-status.fsm.ts`)
- **Auditable:** The FSM is a pure function with no side effects; it can be reviewed, tested, and reasoned about independently
- **Documented:** The state diagram and transition rules are explicit in code and in this ADR

### 1. State Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    CLAIM LIFECYCLE                              │
└─────────────────────────────────────────────────────────────────┘

                          ┌──────────────┐
                          │    intake    │
                          └──────┬───────┘
                                 │
                    (adjuster assignment)
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │ under_investigation    │
                    └────────┬───────────────┘
                             │
              (investigation complete, reserve proposed)
                             │
                             ▼
                ┌──────────────────────────────┐
                │ awaiting_reserve_approval    │
                └────────┬─────────────────────┘
                         │
         (reserve approved by manager/director)
                         │
                         ▼
            ┌────────────────────────────┐
            │  settlement_offered        │
            └────────┬───────────────────┘
                     │
        (claimant accepts settlement)
                     │
                     ▼
            ┌────────────────────────────┐
            │    closed_paid             │
            └────────────────────────────┘

            ┌────────────────────────────┐
            │    closed_denied           │
            └────────────────────────────┘

            ┌────────────────────────────┐
            │    reopened                │
            └────────┬───────────────────┘
                     │
        (investigation resumes)
                     │
                     ▼
            ┌────────────────────────────┐
            │ under_investigation        │
            └────────────────────────────┘
```

### 2. Transition Rules

| From | To | Allowed Roles | Conditions | Reason if Denied |
|---|---|---|---|---|
| `intake` | `under_investigation` | `adjuster`, `manager` | Claim must be assigned to an adjuster | "Claim must be assigned before investigation" |
| `under_investigation` | `awaiting_reserve_approval` | `adjuster`, `manager` | Reserve must be proposed | "Reserve must be proposed before approval" |
| `awaiting_reserve_approval` | `settlement_offered` | `manager` | Reserve must be approved | "Reserve must be approved before settlement" |
| `settlement_offered` | `closed_paid` | `adjuster`, `manager` | Settlement accepted by claimant | "Settlement must be accepted" |
| `settlement_offered` | `closed_denied` | `manager` | Claim denied by insurer | None (always allowed) |
| `closed_paid` | `reopened` | `manager` | Claimant reopens claim (e.g., new injury discovered) | "Only manager can reopen" |
| `closed_denied` | `reopened` | `manager` | Claimant appeals denial | "Only manager can reopen" |
| `reopened` | `under_investigation` | `adjuster`, `manager` | Investigation resumes | None (always allowed) |
| Any | Any (same) | Any | No-op transition | None (allowed, idempotent) |
| Any | Any (other) | Any | Not in matrix above | "Transition from {from} to {to} is not allowed" |

### 3. FSM Implementation

```typescript
// src/claims/claims-status.fsm.ts

import { ClaimStatus, UserRole, Claim } from '@prisma/client';

export interface FsmTransitionResult {
  ok: boolean;
  reason?: string; // Explanation if transition is denied
}

export interface FsmContext {
  currentStatus: ClaimStatus;
  targetStatus: ClaimStatus;
  claim: Claim;
  actorRole: UserRole;
}

/**
 * Pure finite-state machine for claim status transitions.
 * Given a context, returns whether the transition is allowed and why (if denied).
 */
export function validateClaimStatusTransition(
  context: FsmContext,
): FsmTransitionResult {
  const { currentStatus, targetStatus, claim, actorRole } = context;

  // No-op transition (same state): always allowed
  if (currentStatus === targetStatus) {
    return { ok: true };
  }

  // Define the state machine as a map of (from, to) → (allowed roles, conditions)
  const transitions: Record<
    ClaimStatus,
    Record<
      ClaimStatus,
      {
        allowedRoles: UserRole[];
        condition?: (claim: Claim) => boolean;
        conditionFailureReason?: string;
      }
    >
  > = {
    intake: {
      under_investigation: {
        allowedRoles: ['adjuster', 'manager'],
        condition: (claim) => claim.assigned_adjuster_id !== null,
        conditionFailureReason: 'Claim must be assigned before investigation',
      },
      // All other transitions from intake are forbidden
    },
    under_investigation: {
      awaiting_reserve_approval: {
        allowedRoles: ['adjuster', 'manager'],
        // Condition: reserve must be proposed (checked in service layer)
        condition: (claim) => true, // Service layer validates reserve existence
        conditionFailureReason: 'Reserve must be proposed before approval',
      },
      reopened: {
        allowedRoles: ['manager'],
      },
    },
    awaiting_reserve_approval: {
      settlement_offered: {
        allowedRoles: ['manager'],
        // Condition: reserve must be approved (checked in service layer)
        condition: (claim) => true,
        conditionFailureReason: 'Reserve must be approved before settlement',
      },
      under_investigation: {
        allowedRoles: ['manager'],
        // Allow returning to investigation if reserve is rejected
      },
    },
    settlement_offered: {
      closed_paid: {
        allowedRoles: ['adjuster', 'manager'],
      },
      closed_denied: {
        allowedRoles: ['manager'],
      },
      under_investigation: {
        allowedRoles: ['manager'],
        // Allow returning to investigation if settlement is rejected
      },
    },
    closed_paid: {
      reopened: {
        allowedRoles: ['manager'],
      },
    },
    closed_denied: {
      reopened: {
        allowedRoles: ['manager'],
      },
    },
    reopened: {
      under_investigation: {
        allowedRoles: ['adjuster', 'manager'],
      },
    },
  };

  // Look up the transition rule
  const fromTransitions = transitions[currentStatus];
  if (!fromTransitions) {
    return {
      ok: false,
      reason: `No transitions defined from state '${currentStatus}'`,
    };
  }

  const transitionRule = fromTransitions[targetStatus];
  if (!transitionRule) {
    return {
      ok: false,
      reason: `Transition from '${currentStatus}' to '${targetStatus}' is not allowed`,
    };
  }

  // Check role authorization
  if (!transitionRule.allowedRoles.includes(actorRole)) {
    return {
      ok: false,
      reason: `Role '${actorRole}' is not authorized to transition from '${currentStatus}' to '${targetStatus}'. Allowed roles: ${transitionRule.allowedRoles.join(', ')}`,
    };
  }

  // Check condition (if defined)
  if (transitionRule.condition && !transitionRule.condition(claim)) {
    return {
      ok: false,
      reason: transitionRule.conditionFailureReason || 'Transition condition not met',
    };
  }

  return { ok: true };
}

/**
 * Get all valid target states from a given current state.
 * Useful for UI to show available actions.
 */
export function getValidTransitions(
  currentStatus: ClaimStatus,
  actorRole: UserRole,
): ClaimStatus[] {
  const allStates: ClaimStatus[] = [
    'intake',
    'under_investigation',
    'awaiting_reserve_approval',
    'settlement_offered',
    'closed_paid',
    'closed_denied',
    'reopened',
  ];

  const validTransitions: ClaimStatus[] = [];

  for (const targetStatus of allStates) {
    const result = validateClaimStatusTransition({
      currentStatus,
      targetStatus,
      claim: {} as Claim, // Dummy claim for role/condition check
      actorRole,
    });

    if (result.ok) {
      validTransitions.push(targetStatus);
    }
  }

  return validTransitions;
}
```

### 4. Service Layer Integration

The claims service uses the FSM to validate transitions before updating the database:

```typescript
// src/claims/claims.service.ts

import { validateClaimStatusTransition, FsmContext } from './claims-status.fsm';

@Injectable()
export class ClaimsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: Logger,
  ) {}

  /**
   * Transition a claim to a new status.
   * Validates the transition using the FSM before updating the database.
   */
  async updateStatus(
    claimId: string,
    targetStatus: ClaimStatus,
    actor: User,
    reason?: string,
  ): Promise<Claim> {
    const claim = await this.prisma.claim.findUnique({
      where: { id: claimId },
    });

    if (!claim) {
      throw new NotFoundException(`Claim ${claimId} not found`);
    }

    // Validate transition using FSM
    const fsmResult = validateClaimStatusTransition({
      currentStatus: claim.status,
      targetStatus,
      claim,
      actorRole: actor.role,
    });

    if (!fsmResult.ok) {
      throw new BadRequestException(fsmResult.reason);
    }

    // Additional service-layer validations (e.g., reserve approval)
    if (targetStatus === 'settlement_offered') {
      const reserve = await this.prisma.reserve.findFirst({
        where: {
          claim_id: claimId,
          approval_status: 'approved',
        },
      });

      if (!reserve) {
        throw new BadRequestException(
          'Cannot offer settlement without an approved reserve',
        );
      }
    }

    // Update the claim status
    const updated = await this.prisma.claim.update({
      where: { id: claimId },
      data: {
        status: targetStatus,
        updated_at: new Date(),
      },
    });

    this.logger.log(
      `Claim ${claimId} transitioned from ${claim.status} to ${targetStatus} by ${actor.username}`,
      'ClaimsService',
    );

    return updated;
  }
}
```

### 5. Controller Integration

The controller calls the service and returns a 422 (Unprocessable Entity) if the transition is invalid:

```typescript
// src/claims/claims.controller.ts

import { BadRequestException } from '@nestjs/common';

@Controller('claims')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ClaimsController {
  constructor(private readonly claimsService: ClaimsService) {}

  @Patch(':id/status')
  @Roles('adjuster', 'manager')
  @Audit({ action: 'claim.status.updated' })
  async updateStatus(
    @Param('id') claimId: string,
    @Body() dto: UpdateStatusDto,
    @CurrentUser() user: User,
  ) {
    try {
      return await this.claimsService.updateStatus(
        claimId,
        dto.to,
        user,
        dto.reason,
      );
    } catch (error) {
      if (error instanceof BadRequestException) {
        // FSM validation failed; return 422 with the reason
        throw new UnprocessableEntityException(error.message);
      }
      throw error;
    }
  }
}
```

### 6. DTO Definition

```typescript
// src/claims/dto/update-status.dto.ts

import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { ClaimStatus } from '@prisma/client';

export class UpdateStatusDto {
  @IsEnum(ClaimStatus)
  to: ClaimStatus;

  @IsOptional()
  @IsString()
  @MinLength(10)
  reason?: string; // Optional reason for the transition
}
```

## Consequences

### Positive

1. **Centralized Logic:** All state transition rules live in one pure function. No business logic scattered across controllers or services.
2. **Auditability:** The FSM is a deterministic function that can be reviewed, tested, and reasoned about independently. Regulators can inspect the code and verify compliance.
3. **Consistency:** All endpoints use the same FSM. No inconsistencies in transition validation.
4. **Testability:** Pure function is easy to unit test. Test matrix covers all state × role combinations.
5. **Error Clarity:** When a transition is rejected, the FSM provides a clear reason (e.g., "Claim must be assigned before investigation"). Users understand why their action was denied.
6. **Operational Guidance:** The FSM can be used to generate UI hints (e.g., "Available actions: [under_investigation, reopened]"). Adjusters know what transitions are available.
7. **Regulatory Compliance:** JFSA expects claims to follow a documented, auditable workflow. The FSM is explicit and auditable.
8. **Flexibility:** Transition rules can be updated without touching controllers. Pure function makes changes safe and testable.

### Negative

1. **Boilerplate:** The transition matrix is verbose. Adding a new state requires updating the matrix.
2. **Condition Complexity:** Complex conditions (e.g., "reserve must be approved") are checked in the service layer, not the FSM. The FSM returns `true` for the condition, and the service layer validates the actual condition. This splits logic across two places.
3. **No Async Conditions:** The FSM is synchronous. Async conditions (e.g., "check if reserve is approved in the database") must be checked in the service layer, not the FSM.

## Alternatives Considered

### 1. State Machine Library (e.g., XState)

**Rejected:** A state machine library would add a dependency and learning curve. For a simple FSM with 7 states and ~15 transitions, a pure function is simpler and more transparent.

### 2. Enum-Based Status with Validation in Each Controller

**Rejected:** Validation scattered across controllers is hard to audit and maintain. A centralized FSM is clearer.

### 3. Database Constraints (Check Constraints)

**Rejected:** Postgres check constraints can enforce some rules (e.g., "status must be one of [intake, under_investigation, ...]"), but they cannot enforce complex transition rules (e.g., "can only transition from intake to under_investigation if assigned_adjuster_id is not null"). Application-level FSM is more flexible.

### 4. Decorator-Based Validation

**Rejected:** Decorators (e.g., `@AllowTransitionTo('under_investigation')`) would scatter validation logic across the codebase. A centralized FSM is clearer.

## Testing Strategy

### Unit Tests

```typescript
// test/claims-status.fsm.spec.ts

import {
  validateClaimStatusTransition,
  getValidTransitions,
  FsmContext,
} from '../src/claims/claims-status.fsm';
import { Claim, ClaimStatus, UserRole } from '@prisma/client';

describe('Claim Status FSM', () => {
  const baseClaim: Claim = {
    id: 'clm_123',
    assigned_adjuster_id: 'adj_001',
    status: 'intake',
    // ... other fields
  } as Claim;

  describe('intake → under_investigation', () => {
    it('should allow adjuster to transition if claim is assigned', () => {
      const result = validateClaimStatusTransition({
        currentStatus: 'intake',
        targetStatus: 'under_investigation',
        claim: baseClaim,
        actorRole: 'adjuster',
      });

      expect(result.ok).toBe(true);
    });

    it('should reject transition if claim is not assigned', () => {
      const unassignedClaim = { ...baseClaim, assigned_adjuster_id: null };
      const result = validateClaimStatusTransition({
        currentStatus: 'intake',
        targetStatus: 'under_investigation',
        claim: unassignedClaim,
        actorRole: 'adjuster',
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('must be assigned');
    });

    it('should reject agent role', () => {
      const result = validateClaimStatusTransition({
        currentStatus: 'intake',
        targetStatus: 'under_investigation',
        claim: baseClaim,
        actorRole: 'agent',
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('not authorized');
    });
  });

  describe('settlement_offered → closed_paid', () => {
    it('should allow adjuster to transition', () => {
      const result = validateClaimStatusTransition({
        currentStatus: 'settlement_offered',
        targetStatus: 'closed_paid',
        claim: baseClaim,
        actorRole: 'adjuster',
      });

      expect(result.ok).toBe(true);
    });
  });

  describe('settlement_offered → closed_denied', () => {
    it('should allow manager to transition', () => {
      const result = validateClaimStatusTransition({
        currentStatus: 'settlement_offered',
        targetStatus: 'closed_denied',
        claim: baseClaim,
        actorRole: 'manager',
      });

      expect(result.ok).toBe(true);
    });

    it('should reject adjuster role', () => {
      const result = validateClaimStatusTransition({
        currentStatus: 'settlement_offered',
        targetStatus: 'closed_denied',
        claim: baseClaim,
        actorRole: 'adjuster',
      });

      expect(result.ok).toBe(false);
    });
  });

  describe('closed_paid → reopened', () => {
    it('should allow manager to transition', () => {
      const result = validateClaimStatusTransition({
        currentStatus: 'closed_paid',
        targetStatus: 'reopened',
        claim: baseClaim,
        actorRole: 'manager',
      });

      expect(result.ok).toBe(true);
    });

    it('should reject adjuster role', () => {
      const result = validateClaimStatusTransition({
        currentStatus: 'closed_paid',
        targetStatus: 'reopened',
        claim: baseClaim,
        actorRole: 'adjuster',
      });

      expect(result.ok).toBe(false);
    });
  });

  describe('invalid transitions', () => {
    it('should reject intake → closed_paid', () => {
      const result = validateClaimStatusTransition({
        currentStatus: 'intake',
        targetStatus: 'closed_paid',
        claim: baseClaim,
        actorRole: 'manager',
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('not allowed');
    });

    it('should reject closed_paid → intake', () => {
      const result = validateClaimStatusTransition({
        currentStatus: 'closed_paid',
        targetStatus: 'intake',
        claim: baseClaim,
        actorRole: 'manager',
      });

      expect(result.ok).toBe(false);
    });
  });

  describe('no-op transitions', () => {
    it('should allow same-state transition', () => {
      const result = validateClaimStatusTransition({
        currentStatus: 'under_investigation',
        targetStatus: 'under_investigation',
        claim: baseClaim,
        actorRole: 'adjuster',
      });

      expect(result.ok).toBe(true);
    });
  });

  describe('getValidTransitions', () => {
    it('should return valid transitions for adjuster from intake', () => {
      const transitions = getValidTransitions('intake', 'adjuster');

      expect(transitions).toContain('under_investigation');
      expect(transitions).not.toContain('closed_paid');
    });

    it('should return valid transitions for manager from settlement_offered', () => {
      const transitions = getValidTransitions('settlement_offered', 'manager');

      expect(transitions).toContain('closed_paid');
      expect(transitions).toContain('closed_denied');
      expect(transitions).toContain('under_investigation');
    });
  });
});
```

### Integration Tests

```typescript
// test/claims-status.e2e.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Claim Status Transitions (e2e)', () => {
  let app: INestApplication;
  let adjusterToken: string;
  let managerToken: string;
  let claimId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    // Login
    const adjusterRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: 'adjuster1', password: 'password123' });
    adjusterToken = adjusterRes.body.access_token;

    const managerRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: 'manager1', password: 'password123' });
    managerToken = managerRes.body.access_token;

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

  it('should transition intake → under_investigation', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/claims/${claimId}/status`)
      .set('Authorization', `Bearer ${adjusterToken}`)
      .send({ to: 'under_investigation', reason: 'Starting investigation' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('under_investigation');
  });

  it('should reject invalid transition with 422', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/claims/${claimId}/status`)
      .set('Authorization', `Bearer ${adjusterToken}`)
      .send({ to: 'closed_paid', reason: 'Invalid transition' });

    expect(res.status).toBe(422);
    expect(res.body.message).toContain('not allowed');
  });

  it('should reject unauthorized role with 422', async () => {
    // Agent cannot transition status
    const agentRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: 'agent1', password: 'password123' });
    const agentToken = agentRes.body.access_token;

    const res = await request(app.getHttpServer())
      .patch(`/claims/${claimId}/status`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ to: 'under_investigation' });

    expect(res.status).toBe(403); // Forbidden (role guard)
  });
});
```

## Monitoring and Alerting

All status transitions are logged via the `AuditInterceptor` (ADR-002). When a claim transitions, an `AuditEvent` is recorded with:

- `actor_id` — who made the transition
- `action` — "claim.status.updated"
- `claim_id` — which claim transitioned
- `correlation_id` — request chain for traceability

Auditors can query the audit log to see the full history of status transitions for any claim, enabling root-cause analysis and regulatory compliance verification.

## References

- **Finite-State Machines:** https://en.wikipedia.org/wiki/Finite-state_machine
- **State Pattern (Gang of Four):** Design pattern for encapsulating state-dependent behavior
- **JFSA Workflow Requirements:** https://www.fsa.go.jp/
- **Phase 1 Status Patterns:** `src/common/status.enum.ts` (Workforce Ops platform)

## Related ADRs

- **ADR-002:** Audit log immutability (all status transitions are logged via AuditEvent)
- **ADR-005:** Reserve approval tiers (reserve approval is a prerequisite for settlement_offered transition)
- **ADR-006:** JFSA notification pattern (reserve threshold notifications are triggered during status transitions)