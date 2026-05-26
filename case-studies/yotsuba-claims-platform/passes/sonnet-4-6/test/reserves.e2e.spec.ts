// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// test/reserves.e2e.spec.ts
//
// End-to-end tests for the Reserves Management module.
//
// Coverage:
//   - Happy path: propose → manager approve (≤ ¥10M)
//   - Happy path: propose → manager tier-1 approve → director approve (> ¥10M)
//   - Auto-approval for amounts ≤ ¥1M
//   - Validation failure: justification < 50 chars
//   - Auth-denied: adjuster not assigned to claim
//   - Auth-denied: non-manager attempts approval
//   - ADR-005 threshold: ¥15M cannot be approved by manager alone (requires director)
//   - Reserve rejection workflow
//   - Reserve history (GET /claims/:id/reserves)
//   - IFRS17 export shape (GET /reserves/export?period=YYYY-MM)
//   - JFSA notification triggered for ¥100M+ reserve
//   - JFSA pending notifications list (GET /notifications/jfsa-pending)
//   - Acceptance criterion 9: ¥15M proposal cannot be approved by manager without director
// =============================================================================

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { UserRole, ClaimStatus, IntakeChannel, IncidentType, ClaimSeverity } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loginAs(
  app: INestApplication,
  username: string,
  password: string,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ username, password })
    .expect(201);
  return res.body.access_token as string;
}

/**
 * Build a justification string of exactly `len` characters.
 */
function justification(len: number): string {
  return 'A'.repeat(len);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Reserves (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  // Seeded user credentials
  const MANAGER_USERNAME = 'reserves_test_manager';
  const MANAGER_PASSWORD = 'TestPass1!';
  const DIRECTOR_USERNAME = 'reserves_test_director';
  const DIRECTOR_PASSWORD = 'TestPass1!';
  const ADJUSTER_USERNAME = 'reserves_test_adjuster';
  const ADJUSTER_PASSWORD = 'TestPass1!';
  const ADJUSTER2_USERNAME = 'reserves_test_adjuster2';
  const ADJUSTER2_PASSWORD = 'TestPass1!';
  const AUDITOR_USERNAME = 'reserves_test_auditor';
  const AUDITOR_PASSWORD = 'TestPass1!';
  const AGENT_USERNAME = 'reserves_test_agent';
  const AGENT_PASSWORD = 'TestPass1!';

  // Seeded entity IDs
  let managerId: string;
  let directorId: string;
  let adjusterId: string;
  let adjuster2Id: string;
  let auditorId: string;
  let agentId: string;
  let claimId: string;
  let unassignedClaimId: string;

  // Auth tokens
  let managerToken: string;
  let directorToken: string;
  let adjusterToken: string;
  let adjuster2Token: string;
  let auditorToken: string;
  let agentToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);

    // ------------------------------------------------------------------
    // Seed test users
    // ------------------------------------------------------------------
    const hash = await bcrypt.hash('TestPass1!', 10);

    const manager = await prisma.user.upsert({
      where: { username: MANAGER_USERNAME },
      update: {},
      create: {
        username: MANAGER_USERNAME,
        password_hash: hash,
        role: UserRole.manager,
        display_name: 'Reserves Test Manager',
        email: 'reserves_mgr@test.yotsuba.local',
        is_claims_director: false,
      },
    });
    managerId = manager.id;

    const director = await prisma.user.upsert({
      where: { username: DIRECTOR_USERNAME },
      update: {},
      create: {
        username: DIRECTOR_USERNAME,
        password_hash: hash,
        role: UserRole.manager,
        display_name: 'Reserves Test Director',
        email: 'reserves_dir@test.yotsuba.local',
        is_claims_director: true,
      },
    });
    directorId = director.id;

    const adjuster = await prisma.user.upsert({
      where: { username: ADJUSTER_USERNAME },
      update: {},
      create: {
        username: ADJUSTER_USERNAME,
        password_hash: hash,
        role: UserRole.adjuster,
        display_name: 'Reserves Test Adjuster',
        email: 'reserves_adj@test.yotsuba.local',
        is_claims_director: false,
      },
    });
    adjusterId = adjuster.id;

    const adjuster2 = await prisma.user.upsert({
      where: { username: ADJUSTER2_USERNAME },
      update: {},
      create: {
        username: ADJUSTER2_USERNAME,
        password_hash: hash,
        role: UserRole.adjuster,
        display_name: 'Reserves Test Adjuster 2',
        email: 'reserves_adj2@test.yotsuba.local',
        is_claims_director: false,
      },
    });
    adjuster2Id = adjuster2.id;

    const auditor = await prisma.user.upsert({
      where: { username: AUDITOR_USERNAME },
      update: {},
      create: {
        username: AUDITOR_USERNAME,
        password_hash: hash,
        role: UserRole.auditor,
        display_name: 'Reserves Test Auditor',
        email: 'reserves_aud@test.yotsuba.local',
        is_claims_director: false,
      },
    });
    auditorId = auditor.id;

    const agent = await prisma.user.upsert({
      where: { username: AGENT_USERNAME },
      update: {},
      create: {
        username: AGENT_USERNAME,
        password_hash: hash,
        role: UserRole.agent,
        display_name: 'Reserves Test Agent',
        email: 'reserves_agent@test.yotsuba.local',
        is_claims_director: false,
      },
    });
    agentId = agent.id;

    // ------------------------------------------------------------------
    // Seed a claim assigned to adjuster
    // ------------------------------------------------------------------
    const claim = await prisma.claim.create({
      data: {
        policy_number: 'POL-RESERVES-TEST-001',
        loss_date: new Date('2024-03-15'),
        loss_location_prefecture: '東京都',
        loss_location_postal_code: '100-0001',
        loss_location_detail: '千代田区1-1',
        reported_by_channel: IntakeChannel.agent,
        reporter_name: 'Test Reporter',
        reporter_relation_to_insured: '本人',
        incident_type: IncidentType.auto_collision,
        initial_description: 'Test auto collision for reserve tests',
        injury_reported: false,
        third_party_involved: false,
        severity_initial: ClaimSeverity.complex,
        status: ClaimStatus.under_investigation,
        appi_consent_version: '1.0',
        appi_consent_at: new Date(),
        assigned_adjuster_id: adjusterId,
      },
    });
    claimId = claim.id;

    // Seed an unassigned claim for testing adjuster ownership checks
    const unassignedClaim = await prisma.claim.create({
      data: {
        policy_number: 'POL-RESERVES-TEST-002',
        loss_date: new Date('2024-03-15'),
        loss_location_prefecture: '大阪府',
        loss_location_postal_code: '530-0001',
        loss_location_detail: '北区1-1',
        reported_by_channel: IntakeChannel.mobile,
        reporter_name: 'Unassigned Reporter',
        reporter_relation_to_insured: '本人',
        incident_type: IncidentType.fire_residential,
        initial_description: 'Test fire claim with no adjuster assigned',
        injury_reported: false,
        third_party_involved: false,
        severity_initial: ClaimSeverity.simple,
        status: ClaimStatus.intake,
        appi_consent_version: '1.0',
        appi_consent_at: new Date(),
        assigned_adjuster_id: null,
      },
    });
    unassignedClaimId = unassignedClaim.id;

    // ------------------------------------------------------------------
    // Obtain tokens
    // ------------------------------------------------------------------
    managerToken = await loginAs(app, MANAGER_USERNAME, MANAGER_PASSWORD);
    directorToken = await loginAs(app, DIRECTOR_USERNAME, DIRECTOR_PASSWORD);
    adjusterToken = await loginAs(app, ADJUSTER_USERNAME, ADJUSTER_PASSWORD);
    adjuster2Token = await loginAs(app, ADJUSTER2_USERNAME, ADJUSTER2_PASSWORD);
    auditorToken = await loginAs(app, AUDITOR_USERNAME, AUDITOR_PASSWORD);
    agentToken = await loginAs(app, AGENT_USERNAME, AGENT_PASSWORD);
  });

  afterAll(async () => {
    // Clean up test data to avoid polluting other test suites
    await prisma.notificationToRegulator.deleteMany({
      where: { claim_id: { in: [claimId, unassignedClaimId] } },
    });
    await prisma.reserve.deleteMany({
      where: { claim_id: { in: [claimId, unassignedClaimId] } },
    });
    await prisma.auditEvent.deleteMany({
      where: { claim_id: { in: [claimId, unassignedClaimId] } },
    });
    await prisma.claim.deleteMany({
      where: { id: { in: [claimId, unassignedClaimId] } },
    });
    await prisma.user.deleteMany({
      where: {
        id: {
          in: [managerId, directorId, adjusterId, adjuster2Id, auditorId, agentId],
        },
      },
    });
    await app.close();
  });

  // ==========================================================================
  // POST /claims/:id/reserves — propose reserve
  // ==========================================================================

  describe('POST /claims/:id/reserves', () => {
    describe('happy path — auto-approval for amounts ≤ ¥1M', () => {
      it('returns 201 with approval_status=approved for ¥500,000 proposal', async () => {
        const res = await request(app.getHttpServer())
          .post(`/claims/${claimId}/reserves`)
          .set('Authorization', `Bearer ${adjusterToken}`)
          .send({
            category: 'loss_unpaid',
            proposed_yen: '500000',
            justification: justification(60),
          })
          .expect(201);

        expect(res.body).toMatchObject({
          claim_id: claimId,
          category: 'loss_unpaid',
          approval_status: 'approved',
        });
        expect(res.body.proposed_yen).toBe('500000');
        // Auto-approved: approved_by_id should be set
        expect(res.body.approved_by_id).toBe(adjusterId);
        expect(res.body.approved_at).toBeTruthy();
      });
    });

    describe('happy path — pending approval for ¥5M (manager approval required)', () => {
      it('returns 201 with approval_status=pending for ¥5,000,000 proposal', async () => {
        const res = await request(app.getHttpServer())
          .post(`/claims/${claimId}/reserves`)
          .set('Authorization', `Bearer ${adjusterToken}`)
          .send({
            category: 'loss_unpaid',
            proposed_yen: '5000000',
            justification: justification(60),
          })
          .expect(201);

        expect(res.body).toMatchObject({
          claim_id: claimId,
          category: 'loss_unpaid',
          approval_status: 'pending',
        });
        expect(res.body.proposed_yen).toBe('5000000');
        expect(res.body.approved_by_id).toBeNull();
      });
    });

    describe('happy path — manager can propose reserves on any claim', () => {
      it('returns 201 when manager proposes reserve on assigned claim', async () => {
        const res = await request(app.getHttpServer())
          .post(`/claims/${claimId}/reserves`)
          .set('Authorization', `Bearer ${managerToken}`)
          .send({
            category: 'alae',
            proposed_yen: '2000000',
            justification: justification(55),
          })
          .expect(201);

        expect(res.body).toMatchObject({
          claim_id: claimId,
          category: 'alae',
          approval_status: 'pending',
        });
      });
    });

    describe('validation failure — justification too short', () => {
      it('returns 400 when justification is < 50 characters', async () => {
        const res = await request(app.getHttpServer())
          .post(`/claims/${claimId}/reserves`)
          .set('Authorization', `Bearer ${adjusterToken}`)
          .send({
            category: 'loss_paid',
            proposed_yen: '100000',
            justification: 'Too short',
          })
          .expect(400);

        expect(res.body.message).toBeDefined();
      });
    });

    describe('validation failure — missing required fields', () => {
      it('returns 400 when category is missing', async () => {
        await request(app.getHttpServer())
          .post(`/claims/${claimId}/reserves`)
          .set('Authorization', `Bearer ${adjusterToken}`)
          .send({
            proposed_yen: '100000',
            justification: justification(60),
          })
          .expect(400);
      });

      it('returns 400 when proposed_yen is missing', async () => {
        await request(app.getHttpServer())
          .post(`/claims/${claimId}/reserves`)
          .set('Authorization', `Bearer ${adjusterToken}`)
          .send({
            category: 'loss_paid',
            justification: justification(60),
          })
          .expect(400);
      });
    });

    describe('auth-denied — adjuster not assigned to claim', () => {
      it('returns 403 when a different adjuster proposes a reserve', async () => {
        const res = await request(app.getHttpServer())
          .post(`/claims/${claimId}/reserves`)
          .set('Authorization', `Bearer ${adjuster2Token}`)
          .send({
            category: 'loss_unpaid',
            proposed_yen: '500000',
            justification: justification(60),
          })
          .expect(403);

        expect(res.body.message).toContain('not assigned');
      });
    });

    describe('auth-denied — adjuster proposes on unassigned claim', () => {
      it('returns 403 when adjuster proposes on claim with no assignment', async () => {
        await request(app.getHttpServer())
          .post(`/claims/${unassignedClaimId}/reserves`)
          .set('Authorization', `Bearer ${adjusterToken}`)
          .send({
            category: 'loss_paid',
            proposed_yen: '100000',
            justification: justification(60),
          })
          .expect(403);
      });
    });

    describe('auth-denied — unauthenticated request', () => {
      it('returns 401 when no token is provided', async () => {
        await request(app.getHttpServer())
          .post(`/claims/${claimId}/reserves`)
          .send({
            category: 'loss_paid',
            proposed_yen: '100000',
            justification: justification(60),
          })
          .expect(401);
      });
    });

    describe('auth-denied — agent cannot propose reserves', () => {
      it('returns 403 when an agent attempts to propose a reserve', async () => {
        await request(app.getHttpServer())
          .post(`/claims/${claimId}/reserves`)
          .set('Authorization', `Bearer ${agentToken}`)
          .send({
            category: 'loss_paid',
            proposed_yen: '100000',
            justification: justification(60),
          })
          .expect(403);
      });
    });

    describe('404 — claim not found', () => {
      it('returns 404 when claim does not exist', async () => {
        await request(app.getHttpServer())
          .post('/claims/nonexistent-claim-id/reserves')
          .set('Authorization', `Bearer ${managerToken}`)
          .send({
            category: 'loss_paid',
            proposed_yen: '100000',
            justification: justification(60),
          })
          .expect(404);
      });
    });
  });

  // ==========================================================================
  // POST /reserves/:id/approve — manager approval
  // ==========================================================================

  describe('POST /reserves/:id/approve', () => {
    let pendingReserveId5M: string;
    let pendingReserveId15M: string;

    beforeAll(async () => {
      // Create a ¥5M pending reserve
      const r5m = await prisma.reserve.create({
        data: {
          claim_id: claimId,
          category: 'loss_unpaid',
          proposed_yen: '5000000',
          justification: justification(60),
          proposed_by_id: adjusterId,
          approval_status: 'pending',
        },
      });
      pendingReserveId5M = r5m.id;

      // Create a ¥15M pending reserve (requires director approval)
      const r15m = await prisma.reserve.create({
        data: {
          claim_id: claimId,
          category: 'loss_unpaid',
          proposed_yen: '15000000',
          justification: justification(60),
          proposed_by_id: adjusterId,
          approval_status: 'pending',
        },
      });
      pendingReserveId15M = r15m.id;
    });

    describe('happy path — manager approves ¥5M reserve', () => {
      it('returns 200 with approval_status=approved for ¥5M reserve', async () => {
        const res = await request(app.getHttpServer())
          .post(`/reserves/${pendingReserveId5M}/approve`)
          .set('Authorization', `Bearer ${managerToken}`)
          .expect(200);

        expect(res.body).toMatchObject({
          id: pendingReserveId5M,
          approval_status: 'approved',
        });
        expect(res.body.approved_by_id).toBe(managerId);
        expect(res.body.approved_at).toBeTruthy();
      });
    });

    describe('ADR-005 threshold enforcement — ¥15M requires director (acceptance criterion 9)', () => {
      it('returns 200 but status remains pending for ¥15M (manager tier-1 approval only)', async () => {
        const res = await request(app.getHttpServer())
          .post(`/reserves/${pendingReserveId15M}/approve`)
          .set('Authorization', `Bearer ${managerToken}`)
          .expect(200);

        // Status should STILL be pending — director approval required
        expect(res.body.approval_status).toBe('pending');
        // Manager first-tier approval recorded
        expect(res.body.approved_by_id).toBe(managerId);
        // Message should indicate director approval is required
        expect(res.body._message).toContain('Director approval required');
      });

      it('returns 422 when manager tries to approve the same ¥15M reserve again', async () => {
        const res = await request(app.getHttpServer())
          .post(`/reserves/${pendingReserveId15M}/approve`)
          .set('Authorization', `Bearer ${managerToken}`)
          .expect(422);

        expect(res.body.message).toContain('already has manager approval');
      });
    });

    describe('auth-denied — non-manager cannot approve', () => {
      it('returns 403 when adjuster attempts to approve a reserve', async () => {
        // Create a fresh pending reserve
        const fresh = await prisma.reserve.create({
          data: {
            claim_id: claimId,
            category: 'alae',
            proposed_yen: '3000000',
            justification: justification(60),
            proposed_by_id: adjusterId,
            approval_status: 'pending',
          },
        });

        await request(app.getHttpServer())
          .post(`/reserves/${fresh.id}/approve`)
          .set('Authorization', `Bearer ${adjusterToken}`)
          .expect(403);
      });

      it('returns 403 when auditor attempts to approve a reserve', async () => {
        const fresh = await prisma.reserve.create({
          data: {
            claim_id: claimId,
            category: 'ulae',
            proposed_yen: '2000000',
            justification: justification(60),
            proposed_by_id: adjusterId,
            approval_status: 'pending',
          },
        });

        await request(app.getHttpServer())
          .post(`/reserves/${fresh.id}/approve`)
          .set('Authorization', `Bearer ${auditorToken}`)
          .expect(403);
      });
    });

    describe('422 — already approved', () => {
      it('returns 422 when approving an already-approved reserve', async () => {
        const approved = await prisma.reserve.create({
          data: {
            claim_id: claimId,
            category: 'loss_paid',
            proposed_yen: '500000',
            justification: justification(60),
            proposed_by_id: adjusterId,
            approval_status: 'approved',
            approved_by_id: adjusterId,
            approved_at: new Date(),
          },
        });

        await request(app.getHttpServer())
          .post(`/reserves/${approved.id}/approve`)
          .set('Authorization', `Bearer ${managerToken}`)
          .expect(422);
      });
    });

    describe('404 — reserve not found', () => {
      it('returns 404 for non-existent reserve ID', async () => {
        await request(app.getHttpServer())
          .post('/reserves/nonexistent-reserve-id/approve')
          .set('Authorization', `Bearer ${managerToken}`)
          .expect(404);
      });
    });
  });

  // ==========================================================================
  // POST /reserves/:id/director-approve — director approval
  // ==========================================================================

  describe('POST /reserves/:id/director-approve', () => {
    let reserveAwaitingDirector: string;
    let reserveNoManagerApproval: string;
    let reserveBelow10M: string;

    beforeAll(async () => {
      // Create ¥15M reserve with manager tier-1 approval already recorded
      const r = await prisma.reserve.create({
        data: {
          claim_id: claimId,
          category: 'loss_unpaid',
          proposed_yen: '15000000',
          justification: justification(60),
          proposed_by_id: adjusterId,
          approval_status: 'pending',
          approved_by_id: managerId,
          approved_at: new Date(),
        },
      });
      reserveAwaitingDirector = r.id;

      // Create ¥15M reserve WITHOUT manager approval (to test enforcement)
      const r2 = await prisma.reserve.create({
        data: {
          claim_id: claimId,
          category: 'loss_unpaid',
          proposed_yen: '15000000',
          justification: justification(60),
          proposed_by_id: adjusterId,
          approval_status: 'pending',
        },
      });
      reserveNoManagerApproval = r2.id;

      // Create ¥5M reserve (below director threshold)
      const r3 = await prisma.reserve.create({
        data: {
          claim_id: claimId,
          category: 'alae',
          proposed_yen: '5000000',
          justification: justification(60),
          proposed_by_id: adjusterId,
          approval_status: 'pending',
          approved_by_id: managerId,
          approved_at: new Date(),
        },
      });
      reserveBelow10M = r3.id;
    });

    describe('happy path — director approves ¥15M reserve after manager tier-1', () => {
      it('returns 200 with approval_status=approved', async () => {
        const res = await request(app.getHttpServer())
          .post(`/reserves/${reserveAwaitingDirector}/director-approve`)
          .set('Authorization', `Bearer ${directorToken}`)
          .expect(200);

        expect(res.body).toMatchObject({
          id: reserveAwaitingDirector,
          approval_status: 'approved',
        });
        expect(res.body.director_approved_by_id).toBe(directorId);
        expect(res.body.director_approved_at).toBeTruthy();
      });
    });

    describe('auth-denied — regular manager (non-director) cannot director-approve', () => {
      it('returns 403 when non-director manager calls director-approve', async () => {
        const fresh = await prisma.reserve.create({
          data: {
            claim_id: claimId,
            category: 'loss_unpaid',
            proposed_yen: '12000000',
            justification: justification(60),
            proposed_by_id: adjusterId,
            approval_status: 'pending',
            approved_by_id: managerId,
            approved_at: new Date(),
          },
        });

        const res = await request(app.getHttpServer())
          .post(`/reserves/${fresh.id}/director-approve`)
          .set('Authorization', `Bearer ${managerToken}`)
          .expect(403);

        expect(res.body.message).toContain('is_claims_director');
      });
    });

    describe('422 — director approval without manager tier-1', () => {
      it('returns 422 when manager approval has not been recorded yet', async () => {
        const res = await request(app.getHttpServer())
          .post(`/reserves/${reserveNoManagerApproval}/director-approve`)
          .set('Authorization', `Bearer ${directorToken}`)
          .expect(422);

        expect(res.body.message).toContain('manager first-tier approval');
      });
    });

    describe('422 — reserve below director threshold', () => {
      it('returns 422 for a ¥5M reserve (should use /approve instead)', async () => {
        const res = await request(app.getHttpServer())
          .post(`/reserves/${reserveBelow10M}/director-approve`)
          .set('Authorization', `Bearer ${directorToken}`)
          .expect(422);

        expect(res.body.message).toContain('director approval threshold');
      });
    });

    describe('422 — duplicate director approval', () => {
      it('returns 422 when director-approve is called on already director-approved reserve', async () => {
        // Use the already-approved reserve from the happy path above
        await request(app.getHttpServer())
          .post(`/reserves/${reserveAwaitingDirector}/director-approve`)
          .set('Authorization', `Bearer ${directorToken}`)
          .expect(422);
      });
    });
  });

  // ==========================================================================
  // POST /reserves/:id/reject — rejection workflow
  // ==========================================================================

  describe('POST /reserves/:id/reject', () => {
    let rejectableReserveId: string;

    beforeAll(async () => {
      const r = await prisma.reserve.create({
        data: {
          claim_id: claimId,
          category: 'ulae',
          proposed_yen: '7500000',
          justification: justification(60),
          proposed_by_id: adjusterId,
          approval_status: 'pending',
        },
      });
      rejectableReserveId = r.id;
    });

    describe('happy path — manager rejects a pending reserve', () => {
      it('returns 200 with approval_status=rejected and reason', async () => {
        const res = await request(app.getHttpServer())
          .post(`/reserves/${rejectableReserveId}/reject`)
          .set('Authorization', `Bearer ${managerToken}`)
          .send({
            reason_for_rejection:
              'Insufficient documentation provided. Please resubmit with full repair estimates.',
          })
          .expect(200);

        expect(res.body).toMatchObject({
          id: rejectableReserveId,
          approval_status: 'rejected',
          reason_for_rejection:
            'Insufficient documentation provided. Please resubmit with full repair estimates.',
        });
      });
    });

    describe('422 — cannot reject an already-rejected reserve', () => {
      it('returns 422 when attempting to reject an already-rejected reserve', async () => {
        await request(app.getHttpServer())
          .post(`/reserves/${rejectableReserveId}/reject`)
          .set('Authorization', `Bearer ${managerToken}`)
          .send({ reason_for_rejection: 'Attempted second rejection' })
          .expect(422);
      });
    });

    describe('auth-denied — non-manager cannot reject', () => {
      it('returns 403 when adjuster attempts to reject a reserve', async () => {
        const fresh = await prisma.reserve.create({
          data: {
            claim_id: claimId,
            category: 'alae',
            proposed_yen: '3000000',
            justification: justification(60),
            proposed_by_id: adjusterId,
            approval_status: 'pending',
          },
        });

        await request(app.getHttpServer())
          .post(`/reserves/${fresh.id}/reject`)
          .set('Authorization', `Bearer ${adjusterToken}`)
          .send({ reason_for_rejection: 'Adjuster trying to reject' })
          .expect(403);
      });
    });

    describe('validation failure — missing reason_for_rejection', () => {
      it('returns 400 when reason_for_rejection is not provided', async () => {
        const fresh = await prisma.reserve.create({
          data: {
            claim_id: claimId,
            category: 'loss_paid',
            proposed_yen: '2000000',
            justification: justification(60),
            proposed_by_id: adjusterId,
            approval_status: 'pending',
          },
        });

        await request(app.getHttpServer())
          .post(`/reserves/${fresh.id}/reject`)
          .set('Authorization', `Bearer ${managerToken}`)
          .send({})
          .expect(400);
      });
    });
  });

  // ==========================================================================
  // GET /claims/:id/reserves — reserve history
  // ==========================================================================

  describe('GET /claims/:id/reserves', () => {
    describe('happy path — retrieve reserve history for a claim', () => {
      it('returns 200 with array of reserves ordered by proposed_at ascending', async () => {
        const res = await request(app.getHttpServer())
          .get(`/claims/${claimId}/reserves`)
          .set('Authorization', `Bearer ${adjusterToken}`)
          .expect(200);

        expect(Array.isArray(res.body)).toBe(true);
        // All records should belong to the claim
        for (const reserve of res.body) {
          expect(reserve.claim_id).toBe(claimId);
        }
        // Verify ordering: proposed_at ascending
        for (let i = 1; i < res.body.length; i++) {
          const prev = new Date(res.body[i - 1].proposed_at).getTime();
          const curr = new Date(res.body[i].proposed_at).getTime();
          expect(curr).toBeGreaterThanOrEqual(prev);
        }
      });

      it('allows manager to view reserve history', async () => {
        const res = await request(app.getHttpServer())
          .get(`/claims/${claimId}/reserves`)
          .set('Authorization', `Bearer ${managerToken}`)
          .expect(200);

        expect(Array.isArray(res.body)).toBe(true);
      });

      it('allows auditor to view reserve history', async () => {
        const res = await request(app.getHttpServer())
          .get(`/claims/${claimId}/reserves`)
          .set('Authorization', `Bearer ${auditorToken}`)
          .expect(200);

        expect(Array.isArray(res.body)).toBe(true);
      });
    });

    describe('auth-denied — unauthenticated request', () => {
      it('returns 401 without a JWT', async () => {
        await request(app.getHttpServer())
          .get(`/claims/${claimId}/reserves`)
          .expect(401);
      });
    });

    describe('404 — claim not found', () => {
      it('returns 404 for non-existent claim', async () => {
        await request(app.getHttpServer())
          .get('/claims/nonexistent-claim-id/reserves')
          .set('Authorization', `Bearer ${adjusterToken}`)
          .expect(404);
      });
    });

    describe('reserve history fields', () => {
      it('returns all expected fields per reserve record', async () => {
        const res = await request(app.getHttpServer())
          .get(`/claims/${claimId}/reserves`)
          .set('Authorization', `Bearer ${managerToken}`)
          .expect(200);

        expect(res.body.length).toBeGreaterThan(0);
        const sample = res.body[0];
        expect(sample).toHaveProperty('id');
        expect(sample).toHaveProperty('claim_id');
        expect(sample).toHaveProperty('category');
        expect(sample).toHaveProperty('proposed_yen');
        expect(sample).toHaveProperty('justification');
        expect(sample).toHaveProperty('proposed_by_id');
        expect(sample).toHaveProperty('proposed_at');
        expect(sample).toHaveProperty('approval_status');
      });
    });
  });

  // ==========================================================================
  // GET /reserves/export — IFRS17 export shape
  // ==========================================================================

  describe('GET /reserves/export', () => {
    beforeAll(async () => {
      // Seed approved reserves in March 2024 to ensure export data exists
      await prisma.reserve.createMany({
        data: [
          {
            claim_id: claimId,
            category: 'loss_paid',
            proposed_yen: '3000000',
            justification: justification(60),
            proposed_by_id: adjusterId,
            approval_status: 'approved',
            approved_by_id: managerId,
            approved_at: new Date('2024-03-20'),
            proposed_at: new Date('2024-03-20'),
          },
          {
            claim_id: claimId,
            category: 'loss_unpaid',
            proposed_yen: '8000000',
            justification: justification(60),
            proposed_by_id: adjusterId,
            approval_status: 'approved',
            approved_by_id: managerId,
            approved_at: new Date('2024-03-21'),
            proposed_at: new Date('2024-03-21'),
          },
          {
            claim_id: claimId,
            category: 'alae',
            proposed_yen: '1500000',
            justification: justification(60),
            proposed_by_id: adjusterId,
            approval_status: 'approved',
            approved_by_id: managerId,
            approved_at: new Date('2024-03-22'),
            proposed_at: new Date('2024-03-22'),
          },
        ],
        skipDuplicates: true,
      });
    });

    describe('happy path — auditor exports IFRS17 aggregates for a period', () => {
      it('returns 200 with correct IFRS17 export shape for 2024-03', async () => {
        const res = await request(app.getHttpServer())
          .get('/reserves/export?period=2024-03')
          .set('Authorization', `Bearer ${auditorToken}`)
          .expect(200);

        // Shape validation (brief.md: "Format: tabular JSON suitable for downstream IFRS17 calculation")
        expect(res.body).toHaveProperty('period', '2024-03');
        expect(res.body).toHaveProperty('exported_at');
        expect(res.body).toHaveProperty('categories');
        expect(res.body).toHaveProperty('total_approved_yen');

        // categories should be an object or array with IFRS17 category breakdowns
        const { categories } = res.body;
        expect(categories).toBeDefined();

        // Verify at least the categories we seeded are present
        const categoryKeys = Array.isArray(categories)
          ? categories.map((c: Record<string, unknown>) => c.category)
          : Object.keys(categories);

        expect(categoryKeys).toContain('loss_paid');
        expect(categoryKeys).toContain('loss_unpaid');
        expect(categoryKeys).toContain('alae');
      });

      it('returns numeric yen totals (not float) in export', async () => {
        const res = await request(app.getHttpServer())
          .get('/reserves/export?period=2024-03')
          .set('Authorization', `Bearer ${auditorToken}`)
          .expect(200);

        // total_approved_yen should be a string representation of Decimal or integer
        const total = res.body.total_approved_yen;
        expect(typeof total === 'string' || typeof total === 'number').toBe(true);
        // Should not contain a decimal fraction (JPY has no cents)
        if (typeof total === 'string') {
          expect(total).not.toMatch(/\.\d+$/);
        }
      });
    });

    describe('auth-denied — non-auditor cannot export', () => {
      it('returns 403 when manager attempts to export', async () => {
        await request(app.getHttpServer())
          .get('/reserves/export?period=2024-03')
          .set('Authorization', `Bearer ${managerToken}`)
          .expect(403);
      });

      it('returns 403 when adjuster attempts to export', async () => {
        await request(app.getHttpServer())
          .get('/reserves/export?period=2024-03')
          .set('Authorization', `Bearer ${adjusterToken}`)
          .expect(403);
      });
    });

    describe('validation failure — invalid period format', () => {
      it('returns 400 for period not in YYYY-MM format', async () => {
        await request(app.getHttpServer())
          .get('/reserves/export?period=2024-3')
          .set('Authorization', `Bearer ${auditorToken}`)
          .expect(400);
      });

      it('returns 400 when period is missing', async () => {
        await request(app.getHttpServer())
          .get('/reserves/export')
          .set('Authorization', `Bearer ${auditorToken}`)
          .expect(400);
      });
    });

    describe('empty period — no reserves for period', () => {
      it('returns 200 with zero totals for a period with no approved reserves', async () => {
        const res = await request(app.getHttpServer())
          .get('/reserves/export?period=1990-01')
          .set('Authorization', `Bearer ${auditorToken}`)
          .expect(200);

        expect(res.body.period).toBe('1990-01');
        // Total should be 0 or '0' for empty period
        const total = Number(res.body.total_approved_yen);
        expect(total).toBe(0);
      });
    });
  });

  // ==========================================================================
  // JFSA threshold — ¥100M reserve triggers NotificationToRegulator
  // ==========================================================================

  describe('JFSA threshold notification (ADR-006)', () => {
    let jfsaClaimId: string;

    beforeAll(async () => {
      // Create a separate claim for JFSA tests to avoid polluting other assertions
      const jfsaClaim = await prisma.claim.create({
        data: {
          policy_number: 'POL-JFSA-TEST-001',
          loss_date: new Date('2024-04-01'),
          loss_location_prefecture: '神奈川県',
          loss_location_postal_code: '220-0001',
          loss_location_detail: '横浜市西区1-1',
          reported_by_channel: IntakeChannel.broker,
          reporter_name: 'JFSA Test Reporter',
          reporter_relation_to_insured: '代理店',
          incident_type: IncidentType.fire_commercial,
          initial_description: 'Large commercial fire claim for JFSA threshold testing',
          injury_reported: true,
          third_party_involved: true,
          severity_initial: ClaimSeverity.catastrophic,
          status: ClaimStatus.under_investigation,
          appi_consent_version: '1.0',
          appi_consent_at: new Date(),
          assigned_adjuster_id: adjusterId,
        },
      });
      jfsaClaimId = jfsaClaim.id;
    });

    afterAll(async () => {
      await prisma.notificationToRegulator.deleteMany({
        where: { claim_id: jfsaClaimId },
      });
      await prisma.reserve.deleteMany({ where: { claim_id: jfsaClaimId } });
      await prisma.auditEvent.deleteMany({ where: { claim_id: jfsaClaimId } });
      await prisma.claim.delete({ where: { id: jfsaClaimId } });
    });

    describe('happy path — ¥100M reserve triggers JFSA notification', () => {
      let jfsaReserveId: string;

      it('creates a NotificationToRegulator record when ¥100M reserve is proposed', async () => {
        const res = await request(app.getHttpServer())
          .post(`/claims/${jfsaClaimId}/reserves`)
          .set('Authorization', `Bearer ${adjusterToken}`)
          .send({
            category: 'loss_unpaid',
            proposed_yen: '100000000',
            justification: justification(70),
          })
          .expect(201);

        jfsaReserveId = res.body.id;
        expect(jfsaReserveId).toBeTruthy();

        // Verify JFSA notification was created in the database
        const notification = await prisma.notificationToRegulator.findFirst({
          where: {
            claim_id: jfsaClaimId,
            reserve_id: jfsaReserveId,
            kind: 'jfsa_reserve_threshold',
          },
        });

        expect(notification).not.toBeNull();
        expect(notification!.amount_yen.toString()).toBe('100000000');
        expect(notification!.sent_at).toBeNull(); // not yet sent (Track B)
        expect(notification!.triggered_at).toBeTruthy();
      });

      it('is visible in GET /notifications/jfsa-pending', async () => {
        const res = await request(app.getHttpServer())
          .get('/notifications/jfsa-pending')
          .set('Authorization', `Bearer ${auditorToken}`)
          .expect(200);

        expect(Array.isArray(res.body)).toBe(true);
        const found = res.body.find(
          (n: Record<string, unknown>) => n['claim_id'] === jfsaClaimId,
        );
        expect(found).toBeDefined();
        expect(found.kind).toBe('jfsa_reserve_threshold');
        expect(found.sent_at).toBeNull();
      });
    });

    describe('sub-threshold — ¥99M does NOT trigger JFSA notification', () => {
      it('does not create a NotificationToRegulator for ¥99M', async () => {
        const beforeCount = await prisma.notificationToRegulator.count({
          where: { claim_id: jfsaClaimId },
        });

        await request(app.getHttpServer())
          .post(`/claims/${jfsaClaimId}/reserves`)
          .set('Authorization', `Bearer ${adjusterToken}`)
          .send({
            category: 'alae',
            proposed_yen: '99000000',
            justification: justification(70),
          })
          .expect(201);

        const afterCount = await prisma.notificationToRegulator.count({
          where: { claim_id: jfsaClaimId },
        });

        // No new JFSA notification should have been created
        expect(afterCount).toBe(beforeCount);
      });
    });
  });

  // ==========================================================================
  // GET /notifications/jfsa-pending — list pending notifications
  // ==========================================================================

  describe('GET /notifications/jfsa-pending', () => {
    describe('happy path — auditor retrieves pending JFSA notifications', () => {
      it('returns 200 with array of pending notifications', async () => {
        const res = await request(app.getHttpServer())
          .get('/notifications/jfsa-pending')
          .set('Authorization', `Bearer ${auditorToken}`)
          .expect(200);

        expect(Array.isArray(res.body)).toBe(true);
        for (const notification of res.body) {
          expect(notification.sent_at).toBeNull();
          expect(notification.kind).toBe('jfsa_reserve_threshold');
        }
      });

      it('supports pagination via limit and offset', async () => {
        const resPage1 = await request(app.getHttpServer())
          .get('/notifications/jfsa-pending?limit=1&offset=0')
          .set('Authorization', `Bearer ${auditorToken}`)
          .expect(200);

        expect(Array.isArray(resPage1.body)).toBe(true);
        expect(resPage1.body.length).toBeLessThanOrEqual(1);
      });
    });

    describe('auth-denied — non-auditor cannot list JFSA pending notifications', () => {
      it('returns 403 when manager attempts to access jfsa-pending', async () => {
        await request(app.getHttpServer())
          .get('/notifications/jfsa-pending')
          .set('Authorization', `Bearer ${managerToken}`)
          .expect(403);
      });

      it('returns 403 when adjuster attempts to access jfsa-pending', async () => {
        await request(app.getHttpServer())
          .get('/notifications/jfsa-pending')
          .set('Authorization', `Bearer ${adjusterToken}`)
          .expect(403);
      });

      it('returns 401 when unauthenticated', async () => {
        await request(app.getHttpServer())
          .get('/notifications/jfsa-pending')
          .expect(401);
      });
    });
  });

  // ==========================================================================
  // Audit log accumulation (acceptance criterion 8)
  // ==========================================================================

  describe('Audit log accumulation', () => {
    it('every reserve write emits a corresponding AuditEvent (ADR-002)', async () => {
      // Propose a fresh reserve and verify an audit event is created
      const proposalRes = await request(app.getHttpServer())
        .post(`/claims/${claimId}/reserves`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          category: 'ulae',
          proposed_yen: '750000',
          justification: justification(60),
        })
        .expect(201);

      const reserveId = proposalRes.body.id;

      const auditEvent = await prisma.auditEvent.findFirst({
        where: {
          action: 'reserve.proposed',
          target_id: reserveId,
        },
      });

      expect(auditEvent).not.toBeNull();
      expect(auditEvent!.actor_id).toBe(adjusterId);
      expect(auditEvent!.claim_id).toBe(claimId);
      expect(auditEvent!.payload_hash).toBeTruthy();
      expect(auditEvent!.request_id).toBeTruthy();
      expect(auditEvent!.correlation_id).toBeTruthy();
    });

    it('reserve approval emits an audit event', async () => {
      // Create a pending reserve
      const pendingReserve = await prisma.reserve.create({
        data: {
          claim_id: claimId,
          category: 'loss_paid',
          proposed_yen: '4000000',
          justification: justification(60),
          proposed_by_id: adjusterId,
          approval_status: 'pending',
        },
      });

      await request(app.getHttpServer())
        .post(`/reserves/${pendingReserve.id}/approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);

      const auditEvent = await prisma.auditEvent.findFirst({
        where: {
          action: 'reserve.approved',
          target_id: pendingReserve.id,
        },
      });

      expect(auditEvent).not.toBeNull();
      expect(auditEvent!.actor_id).toBe(managerId);
    });

    it('reserve rejection emits an audit event', async () => {
      const pendingReserve = await prisma.reserve.create({
        data: {
          claim_id: claimId,
          category: 'loss_unpaid',
          proposed_yen: '3500000',
          justification: justification(60),
          proposed_by_id: adjusterId,
          approval_status: 'pending',
        },
      });

      await request(app.getHttpServer())
        .post(`/reserves/${pendingReserve.id}/reject`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          reason_for_rejection:
            'Claim documentation does not support the requested reserve amount at this stage.',
        })
        .expect(200);

      const auditEvent = await prisma.auditEvent.findFirst({
        where: {
          action: 'reserve.rejected',
          target_id: pendingReserve.id,
        },
      });

      expect(auditEvent).not.toBeNull();
      expect(auditEvent!.actor_id).toBe(managerId);
    });
  });

  // ==========================================================================
  // Acceptance criterion 9 — explicit end-to-end scenario
  // A ¥15M proposal CANNOT be approved by manager alone;
  // requires manager tier-1 then director approval.
  // ==========================================================================

  describe('Acceptance criterion 9 — ¥15M approval requires manager + director', () => {
    let ac9ReserveId: string;

    it('step 1: adjuster proposes ¥15M reserve — status=pending', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/reserves`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          category: 'loss_unpaid',
          proposed_yen: '15000000',
          justification:
            'Large bodily injury reserve for multi-vehicle collision with multiple hospitalised occupants requiring surgery.',
        })
        .expect(201);

      ac9ReserveId = res.body.id;
      expect(res.body.approval_status).toBe('pending');
    });

    it('step 2: manager approves — status REMAINS pending; tier-1 recorded', async () => {
      const res = await request(app.getHttpServer())
        .post(`/reserves/${ac9ReserveId}/approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);

      // Acceptance criterion: manager approval alone is not sufficient
      expect(res.body.approval_status).toBe('pending');
      expect(res.body.approved_by_id).toBe(managerId);
      expect(res.body._message).toContain('Director approval required');
    });

    it('step 3: non-director manager cannot director-approve — 403', async () => {
      const res = await request(app.getHttpServer())
        .post(`/reserves/${ac9ReserveId}/director-approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(403);

      expect(res.body.message).toContain('is_claims_director');
    });

    it('step 4: claims director approves — status=approved', async () => {
      const res = await request(app.getHttpServer())
        .post(`/reserves/${ac9ReserveId}/director-approve`)
        .set('Authorization', `Bearer ${directorToken}`)
        .expect(200);

      expect(res.body.approval_status).toBe('approved');
      expect(res.body.director_approved_by_id).toBe(directorId);
      expect(res.body.approved_by_id).toBe(managerId);
    });

    it('step 5: audit log contains both manager and director approval events', async () => {
      const managerAudit = await prisma.auditEvent.findFirst({
        where: {
          action: 'reserve.manager_approved_tier1',
          target_id: ac9ReserveId,
          actor_id: managerId,
        },
      });

      const directorAudit = await prisma.auditEvent.findFirst({
        where: {
          action: 'reserve.director_approved',
          target_id: ac9ReserveId,
          actor_id: directorId,
        },
      });

      expect(managerAudit).not.toBeNull();
      expect(directorAudit).not.toBeNull();
    });
  });
});