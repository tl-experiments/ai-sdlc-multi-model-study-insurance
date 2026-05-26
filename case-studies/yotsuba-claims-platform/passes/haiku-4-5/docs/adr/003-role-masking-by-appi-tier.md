# ADR-003: Role Masking by APPI Tier

**Status:** Accepted  
**Date:** 2024-01-15  
**Context:** Yotsuba Insurance Claims Processing Platform (Track A)  
**Deciders:** Architecture team  

## Problem Statement

The Yotsuba Claims Platform must return different field sets to different user roles while protecting personally identifiable information (PII) according to Japanese data protection law (APPI). A single claim record contains fields at multiple sensitivity tiers:

- **Standard PII:** name, phone, email, address (lower sensitivity)
- **Sensitive PII:** policy number (links to financial product)
- **Special-care PII:** government ID, medical information, bank account (APPI Article 17; highest sensitivity)

Without a consistent masking strategy, we risk:

1. **Regulatory non-compliance** — exposing special-care PII to unauthorized roles
2. **Operational confusion** — different controllers applying masking inconsistently
3. **Security vulnerabilities** — accidentally returning unmasked PII in API responses
4. **Audit gaps** — unclear which roles should see which fields

A generic role-based access control (RBAC) system is insufficient because the same role (e.g., `adjuster`) must see different field sets depending on claim ownership (assigned vs. non-assigned).

## Decision

We adopt a **centralized, APPI-tier-aware masking function** that is the single source of truth for what each role sees:

### 1. Masking Function: `maskByAppiTier()`

A pure function in `src/common/pii-mask.util.ts` that takes:

- **Input:** Full claim record (all fields)
- **Context:** Caller role, caller user ID, claim's assigned adjuster ID
- **Output:** Masked claim record (sensitive fields redacted or removed)

```typescript
// src/common/pii-mask.util.ts

export interface MaskContext {
  callerRole: UserRole;
  callerUserId: string;
  claimAssignedAdjusterId?: string;
}

export function maskByAppiTier(
  claim: Claim,
  context: MaskContext,
): Partial<Claim> {
  const masked = { ...claim };

  // Determine caller's relationship to the claim
  const isAssignedAdjuster =
    context.callerRole === 'adjuster' &&
    claim.assigned_adjuster_id === context.callerUserId;
  const isManager = context.callerRole === 'manager';
  const isAuditor = context.callerRole === 'auditor';
  const isSiuReferrer = context.callerRole === 'siu_referrer';
  const isAgent = context.callerRole === 'agent';

  // ─── Standard PII Masking ───────────────────────────────────────
  // Cleartext fields; masked based on role and claim ownership

  if (!isAssignedAdjuster && !isManager && !isAuditor) {
    // Non-assigned adjusters, agents, SIU referrers: mask standard PII
    masked.reporter_name = '***';
    masked.reporter_phone = '***';
    masked.reporter_email = '***';
    // loss_location_detail: show prefecture only
    masked.loss_location_detail = masked.loss_location_prefecture;
  }

  // ─── Sensitive PII Masking ──────────────────────────────────────
  // policy_number: visible to manager and auditor only

  if (!isManager && !isAuditor) {
    masked.policy_number = '***';
  }

  // ─── Special-Care PII: Never in Standard API ────────────────────
  // These fields are encrypted at rest and only returned via
  // explicit data-subject-export endpoint (APPI Article 28).
  // Remove them from all standard API responses.

  delete masked.insured_government_id_ct;
  delete masked.bank_account_for_payout_ct;
  delete masked.injury_details_ct;
  delete masked.reporter_phone_ct;
  delete masked.reporter_email_ct;

  return masked;
}

/**
 * Mask an array of claims.
 */
export function maskClaimsByAppiTier(
  claims: Claim[],
  context: MaskContext,
): Partial<Claim>[] {
  return claims.map((claim) => maskByAppiTier(claim, context));
}
```

### 2. Role × Field Matrix

The masking function encodes the following matrix:

| Field | `agent` | `adjuster` (assigned) | `adjuster` (non-assigned) | `manager` | `auditor` | `siu_referrer` |
|---|---|---|---|---|---|---|
| `reporter_name` | ✗ | ✓ | ✗ | ✓ | ✓ | ✗ |
| `reporter_phone` | ✗ | ✓ | ✗ | ✓ | ✓ | ✗ |
| `reporter_email` | ✗ | ✓ | ✗ | ✓ | ✓ | ✗ |
| `loss_location_detail` | ✗ (prefecture only) | ✓ | ✗ (prefecture only) | ✓ | ✓ | ✗ (prefecture only) |
| `policy_number` | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ |
| `insured_government_id_ct` | ✗ | ✗ | ✗ | ✗ | ✗ (data-subject-export only) | ✗ |
| `bank_account_for_payout_ct` | ✗ | ✗ | ✗ | ✗ | ✗ (data-subject-export only) | ✗ |
| `injury_details_ct` | ✗ | ✗ | ✗ | ✗ | ✗ (data-subject-export only) | ✗ |

**Legend:** ✓ = visible (cleartext), ✗ = masked or removed

### 3. Application in Controllers

Every controller that returns a claim record applies masking before serialization:

```typescript
// src/claims/claims.controller.ts

import { maskByAppiTier, MaskContext } from '../common/pii-mask.util';

@Controller('claims')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ClaimsController {
  constructor(private readonly claimsService: ClaimsService) {}

  @Get(':id')
  @Roles('agent', 'adjuster', 'manager', 'auditor', 'siu_referrer')
  async getClaim(
    @Param('id') claimId: string,
    @CurrentUser() user: User,
  ) {
    const claim = await this.claimsService.findById(claimId);

    // Apply masking based on caller's role and claim ownership
    const maskContext: MaskContext = {
      callerRole: user.role,
      callerUserId: user.id,
      claimAssignedAdjusterId: claim.assigned_adjuster_id,
    };

    return maskByAppiTier(claim, maskContext);
  }

  @Get()
  @Roles('agent', 'adjuster', 'manager', 'auditor', 'siu_referrer')
  async listClaims(
    @Query() filters: ListClaimsDto,
    @CurrentUser() user: User,
  ) {
    const claims = await this.claimsService.list(filters, user);

    const maskContext: MaskContext = {
      callerRole: user.role,
      callerUserId: user.id,
    };

    return claims.map((claim) => maskByAppiTier(claim, maskContext));
  }

  @Post(':id/notes')
  @Roles('adjuster', 'manager')
  @Audit({ action: 'claim.note.added' })
  async addNote(
    @Param('id') claimId: string,
    @Body() dto: AddNoteDto,
    @CurrentUser() user: User,
  ) {
    const note = await this.claimsService.addNote(claimId, dto, user);
    const claim = await this.claimsService.findById(claimId);

    const maskContext: MaskContext = {
      callerRole: user.role,
      callerUserId: user.id,
      claimAssignedAdjusterId: claim.assigned_adjuster_id,
    };

    return {
      note,
      claim: maskByAppiTier(claim, maskContext),
    };
  }
}
```

### 4. Masking Interceptor (Optional Enhancement)

For additional safety, a global interceptor can enforce masking on all responses:

```typescript
// src/common/mask-by-appi.interceptor.ts

import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { maskByAppiTier, MaskContext } from './pii-mask.util';

@Injectable()
export class MaskByAppiInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    return next.handle().pipe(
      map((data) => {
        // If response is a claim, mask it
        if (data && typeof data === 'object' && 'id' in data && 'policy_number' in data) {
          const maskContext: MaskContext = {
            callerRole: user.role,
            callerUserId: user.id,
            claimAssignedAdjusterId: data.assigned_adjuster_id,
          };
          return maskByAppiTier(data, maskContext);
        }

        // If response is an array of claims, mask each
        if (Array.isArray(data)) {
          return data.map((item) => {
            if (item && typeof item === 'object' && 'id' in item && 'policy_number' in item) {
              const maskContext: MaskContext = {
                callerRole: user.role,
                callerUserId: user.id,
                claimAssignedAdjusterId: item.assigned_adjuster_id,
              };
              return maskByAppiTier(item, maskContext);
            }
            return item;
          });
        }

        return data;
      }),
    );
  }
}
```

Register globally in `app.module.ts`:

```typescript
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MaskByAppiInterceptor } from './common/mask-by-appi.interceptor';

@Module({
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: MaskByAppiInterceptor,
    },
  ],
})
export class AppModule {}
```

### 5. Special-Care PII: Data-Subject Export Only

Special-care PII (encrypted fields) is **never** returned in standard API responses. It is only accessible via the explicit data-subject-export endpoint:

```typescript
// src/appi/appi.controller.ts

@Controller('claims')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AppiController {
  constructor(private readonly appiService: AppiService) {}

  /**
   * APPI Article 28: Data-subject disclosure right.
   * Returns all PII (including encrypted special-care fields) for an identified individual.
   * Manager (for own reports) or auditor only.
   */
  @Get(':id/data-subject-export')
  @Roles('manager', 'auditor')
  async dataSubjectExport(
    @Param('id') claimId: string,
    @CurrentUser() user: User,
  ) {
    // appiService.dataSubjectExport() decrypts special-care PII
    // and returns it in a single JSON document (no masking)
    return this.appiService.dataSubjectExport(claimId, user);
  }
}
```

## Consequences

### Positive

1. **Single Source of Truth:** `maskByAppiTier()` is the only place where masking logic lives. Adding a new sensitive field requires one line in the function.
2. **Consistency:** All controllers apply the same masking rules. No inconsistencies across endpoints.
3. **Testability:** Pure function is easy to unit test. Test matrix covers all role × field combinations.
4. **Auditability:** Masking logic is explicit and reviewable. Regulators can inspect the function and verify compliance.
5. **APPI Compliance:** Standard PII is protected via role-based masking; special-care PII is encrypted and restricted to data-subject-export.
6. **Operational Clarity:** Role matrix is documented and enforced in code. New team members can understand the rules immediately.
7. **Flexibility:** Masking rules can be updated without touching controllers. Pure function makes changes safe and testable.

### Negative

1. **Boilerplate:** Every controller that returns a claim must call `maskByAppiTier()`. Mitigated by global interceptor (optional).
2. **Performance:** Masking adds a small overhead (object cloning + field deletion). Negligible for typical claim sizes (~1 KB).
3. **Complexity:** The masking function must be kept in sync with the Prisma schema. If a new PII field is added, the function must be updated.

## Alternatives Considered

### 1. Database-Level Row-Level Security (RLS)

**Rejected:** Postgres RLS can enforce role-based access at the table level, but it cannot selectively mask individual fields within a row. RLS is all-or-nothing (show the row or hide it); it cannot show `reporter_name` but hide `policy_number` for the same row.

### 2. GraphQL Field-Level Permissions

**Rejected:** GraphQL field-level permissions (e.g., via `@Authorized` directives) would require a GraphQL API. The Yotsuba platform uses REST + OpenAPI. Retrofitting GraphQL is out of scope.

### 3. Separate API Endpoints per Role

**Rejected:** Creating separate endpoints for each role (e.g., `GET /claims/:id/adjuster`, `GET /claims/:id/manager`) would duplicate code and create maintenance burden. A single endpoint with masking is simpler.

### 4. Masking at the ORM Layer (Prisma Middleware)

**Rejected:** Prisma middleware could intercept queries and mask results, but it would require complex logic to determine the caller's role at the ORM level. Masking at the controller layer is clearer and more explicit.

### 5. Encryption + Decryption on Demand

**Rejected:** Encrypting all PII (including standard PII) and decrypting on demand would add overhead and complexity. Standard PII is lower-sensitivity under APPI; cleartext + masking is sufficient.

## Testing Strategy

### Unit Tests

```typescript
// test/pii-mask.util.spec.ts

import { maskByAppiTier, MaskContext } from '../src/common/pii-mask.util';
import { Claim, UserRole } from '@prisma/client';

describe('maskByAppiTier', () => {
  const baseClaim: Claim = {
    id: 'clm_123',
    policy_number: 'POL-2024-001234',
    reporter_name: '田中太郎',
    reporter_phone: '09012345678',
    reporter_email: 'tanaka@example.com',
    loss_location_detail: 'Chiyoda Ward, Tokyo',
    loss_location_prefecture: '東京都',
    assigned_adjuster_id: 'adj_001',
    // ... other fields
  };

  describe('adjuster role', () => {
    it('should show cleartext PII for assigned adjuster', () => {
      const context: MaskContext = {
        callerRole: 'adjuster',
        callerUserId: 'adj_001',
        claimAssignedAdjusterId: 'adj_001',
      };

      const masked = maskByAppiTier(baseClaim, context);

      expect(masked.reporter_name).toBe('田中太郎');
      expect(masked.reporter_phone).toBe('09012345678');
      expect(masked.reporter_email).toBe('tanaka@example.com');
      expect(masked.loss_location_detail).toBe('Chiyoda Ward, Tokyo');
    });

    it('should mask PII for non-assigned adjuster', () => {
      const context: MaskContext = {
        callerRole: 'adjuster',
        callerUserId: 'adj_002',
        claimAssignedAdjusterId: 'adj_001',
      };

      const masked = maskByAppiTier(baseClaim, context);

      expect(masked.reporter_name).toBe('***');
      expect(masked.reporter_phone).toBe('***');
      expect(masked.reporter_email).toBe('***');
      expect(masked.loss_location_detail).toBe('東京都');
    });
  });

  describe('manager role', () => {
    it('should show cleartext PII', () => {
      const context: MaskContext = {
        callerRole: 'manager',
        callerUserId: 'mgr_001',
        claimAssignedAdjusterId: 'adj_001',
      };

      const masked = maskByAppiTier(baseClaim, context);

      expect(masked.reporter_name).toBe('田中太郎');
      expect(masked.reporter_phone).toBe('09012345678');
      expect(masked.policy_number).toBe('POL-2024-001234');
    });
  });

  describe('auditor role', () => {
    it('should show cleartext PII', () => {
      const context: MaskContext = {
        callerRole: 'auditor',
        callerUserId: 'aud_001',
        claimAssignedAdjusterId: 'adj_001',
      };

      const masked = maskByAppiTier(baseClaim, context);

      expect(masked.reporter_name).toBe('田中太郎');
      expect(masked.reporter_phone).toBe('09012345678');
      expect(masked.policy_number).toBe('POL-2024-001234');
    });

    it('should never return special-care PII in standard response', () => {
      const context: MaskContext = {
        callerRole: 'auditor',
        callerUserId: 'aud_001',
        claimAssignedAdjusterId: 'adj_001',
      };

      const masked = maskByAppiTier(baseClaim, context);

      expect(masked.insured_government_id_ct).toBeUndefined();
      expect(masked.bank_account_for_payout_ct).toBeUndefined();
      expect(masked.injury_details_ct).toBeUndefined();
    });
  });

  describe('agent role', () => {
    it('should mask all PII', () => {
      const context: MaskContext = {
        callerRole: 'agent',
        callerUserId: 'agt_001',
        claimAssignedAdjusterId: 'adj_001',
      };

      const masked = maskByAppiTier(baseClaim, context);

      expect(masked.reporter_name).toBe('***');
      expect(masked.reporter_phone).toBe('***');
      expect(masked.reporter_email).toBe('***');
      expect(masked.policy_number).toBe('***');
    });
  });

  describe('siu_referrer role', () => {
    it('should mask all PII', () => {
      const context: MaskContext = {
        callerRole: 'siu_referrer',
        callerUserId: 'siu_001',
        claimAssignedAdjusterId: 'adj_001',
      };

      const masked = maskByAppiTier(baseClaim, context);

      expect(masked.reporter_name).toBe('***');
      expect(masked.reporter_phone).toBe('***');
      expect(masked.policy_number).toBe('***');
    });
  });
});
```

### Integration Tests

```typescript
// test/claims-masking.e2e.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Claims Masking (e2e)', () => {
  let app: INestApplication;
  let adjusterToken: string;
  let managerToken: string;
  let auditorToken: string;
  let claimId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    // Login as different roles
    const adjusterRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: 'adjuster1', password: 'password123' });
    adjusterToken = adjusterRes.body.access_token;

    const managerRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: 'manager1', password: 'password123' });
    managerToken = managerRes.body.access_token;

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
        loss_location_detail: 'Chiyoda Ward, Tokyo',
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

  it('assigned adjuster should see cleartext PII', async () => {
    const res = await request(app.getHttpServer())
      .get(`/claims/${claimId}`)
      .set('Authorization', `Bearer ${adjusterToken}`);

    expect(res.status).toBe(200);
    expect(res.body.reporter_name).toBe('田中太郎');
    expect(res.body.reporter_phone).toBe('09012345678');
    expect(res.body.reporter_email).toBe('tanaka@example.com');
  });

  it('manager should see cleartext PII and policy number', async () => {
    const res = await request(app.getHttpServer())
      .get(`/claims/${claimId}`)
      .set('Authorization', `Bearer ${managerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.reporter_name).toBe('田中太郎');
    expect(res.body.policy_number).toBe('POL-2024-001234');
  });

  it('auditor should see cleartext PII and policy number', async () => {
    const res = await request(app.getHttpServer())
      .get(`/claims/${claimId}`)
      .set('Authorization', `Bearer ${auditorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.reporter_name).toBe('田中太郎');
    expect(res.body.policy_number).toBe('POL-2024-001234');
  });

  it('should never return special-care PII in standard API response', async () => {
    const res = await request(app.getHttpServer())
      .get(`/claims/${claimId}`)
      .set('Authorization', `Bearer ${auditorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.insured_government_id_ct).toBeUndefined();
    expect(res.body.bank_account_for_payout_ct).toBeUndefined();
    expect(res.body.injury_details_ct).toBeUndefined();
  });
});
```

## Monitoring and Auditing

All masking operations are logged via the `AuditInterceptor` (ADR-002). When a claim is accessed, an `AuditEvent` is recorded with:

- `actor_id` — who accessed the claim
- `action` — "claim.read"
- `claim_id` — which claim was accessed
- `correlation_id` — request chain for traceability

Auditors can query the audit log to see who accessed which claims and when, enabling detection of unauthorized access patterns.

## References

- **APPI (Act on Protection of Personal Information):** https://www.ppc.go.jp/en/
- **APPI Article 17 (Special-Care Personal Information):** Requires stricter handling of government ID, medical, and financial information.
- **APPI Article 28 (Data-Subject Disclosure Right):** Individuals have the right to request all PII held about them.
- **Phase 1 Masking Pattern:** `src/common/pii-mask.util.ts` (Workforce Ops platform)

## Related ADRs

- **ADR-001:** PII encryption (special-care PII is encrypted at rest; standard PII is cleartext + masking)
- **ADR-002:** Audit log immutability (all PII access is logged via AuditEvent)
- **ADR-006:** JFSA notification pattern (reserve threshold notifications respect role masking)