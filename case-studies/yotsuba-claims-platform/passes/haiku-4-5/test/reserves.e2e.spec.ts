import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, BadRequestException, ForbiddenException } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { UserRole, ApprovalStatus } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';

describe('Reserves (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adjusterToken: string;
  let managerToken: string;
  let directorToken: string;
  let auditorToken: string;
  let adjusterId: string;
  let managerId: string;
  let directorId: string;
  let auditorId: string;
  let claimId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);

    // Clean up test data
    await prisma.auditEvent.deleteMany({});
    await prisma.notificationToRegulator.deleteMany({});
    await prisma.reserve.deleteMany({});
    await prisma.witnessStatement.deleteMany({});
    await prisma.evidence.deleteMany({});
    await prisma.claimNote.deleteMany({});
    await prisma.claim.deleteMany({});
    await prisma.user.deleteMany({});

    // Create test users
    const adjuster = await prisma.user.create({
      data: {
        username: 'adjuster_reserves_test',
        password_hash: 'hashed_password',
        role: UserRole.adjuster,
        display_name: 'Adjuster Test',
        email: 'adjuster@test.local',
      },
    });
    adjusterId = adjuster.id;

    const manager = await prisma.user.create({
      data: {
        username: 'manager_reserves_test',
        password_hash: 'hashed_password',
        role: UserRole.manager,
        display_name: 'Manager Test',
        email: 'manager@test.local',
        is_claims_director: false,
      },
    });
    managerId = manager.id;

    const director = await prisma.user.create({
      data: {
        username: 'director_reserves_test',
        password_hash: 'hashed_password',
        role: UserRole.manager,
        display_name: 'Director Test',
        email: 'director@test.local',
        is_claims_director: true,
      },
    });
    directorId = director.id;

    const auditor = await prisma.user.create({
      data: {
        username: 'auditor_reserves_test',
        password_hash: 'hashed_password',
        role: UserRole.auditor,
        display_name: 'Auditor Test',
        email: 'auditor@test.local',
      },
    });
    auditorId = auditor.id;

    // Create a test claim
    const claim = await prisma.claim.create({
      data: {
        policy_number: 'POL-RESERVES-TEST-001',
        loss_date: new Date('2024-01-15'),
        loss_location_prefecture: '東京都',
        loss_location_postal_code: '100-0001',
        loss_location_detail: 'Test Location',
        reported_by_channel: 'agent',
        reporter_name: 'Test Reporter',
        reporter_relation_to_insured: '本人',
        incident_type: 'auto_collision',
        initial_description: 'Test incident for reserves',
        severity_initial: 'complex',
        appi_consent_version: '1.0',
        appi_consent_at: new Date(),
        assigned_adjuster_id: adjusterId,
      },
    });
    claimId = claim.id;

    // Mock JWT tokens (in real tests, these would be generated via /auth/login)
    adjusterToken = 'mock_adjuster_token';
    managerToken = 'mock_manager_token';
    directorToken = 'mock_director_token';
    auditorToken = 'mock_auditor_token';
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /claims/:id/reserves - Propose Reserve', () => {
    it('should propose a reserve with valid data', async () => {
      const dto = {
        category: 'loss_unpaid',
        proposed_yen: '500000',
        justification: 'This is a detailed justification for the reserve proposal that exceeds fifty characters.',
      };

      const response = await request(app.getHttpServer())
        .post(`/claims/${claimId}/reserves`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send(dto)
        .expect(201);

      expect(response.body).toHaveProperty('id');
      expect(response.body.claim_id).toBe(claimId);
      expect(response.body.category).toBe('loss_unpaid');
      expect(response.body.proposed_yen).toBe('500000');
      expect(response.body.approval_status).toBe('pending');
    });

    it('should reject reserve proposal with negative amount', async () => {
      const dto = {
        category: 'loss_paid',
        proposed_yen: '-100000',
        justification: 'This is a detailed justification for the reserve proposal that exceeds fifty characters.',
      };

      await request(app.getHttpServer())
        .post(`/claims/${claimId}/reserves`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send(dto)
        .expect(400);
    });

    it('should reject reserve proposal with short justification', async () => {
      const dto = {
        category: 'alae',
        proposed_yen: '100000',
        justification: 'Too short',
      };

      await request(app.getHttpServer())
        .post(`/claims/${claimId}/reserves`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send(dto)
        .expect(400);
    });

    it('should reject reserve proposal for non-existent claim', async () => {
      const dto = {
        category: 'loss_unpaid',
        proposed_yen: '500000',
        justification: 'This is a detailed justification for the reserve proposal that exceeds fifty characters.',
      };

      await request(app.getHttpServer())
        .post(`/claims/nonexistent-claim-id/reserves`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send(dto)
        .expect(400);
    });

    it('should deny reserve proposal for non-adjuster role', async () => {
      const dto = {
        category: 'loss_unpaid',
        proposed_yen: '500000',
        justification: 'This is a detailed justification for the reserve proposal that exceeds fifty characters.',
      };

      await request(app.getHttpServer())
        .post(`/claims/${claimId}/reserves`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send(dto)
        .expect(403);
    });
  });

  describe('GET /claims/:id/reserves - List Reserves', () => {
    it('should list reserves for a claim', async () => {
      const response = await request(app.getHttpServer())
        .get(`/claims/${claimId}/reserves`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
      expect(response.body[0]).toHaveProperty('id');
      expect(response.body[0]).toHaveProperty('claim_id');
      expect(response.body[0]).toHaveProperty('category');
      expect(response.body[0]).toHaveProperty('proposed_yen');
      expect(response.body[0]).toHaveProperty('approval_status');
    });

    it('should allow auditor to list reserves for any claim', async () => {
      const response = await request(app.getHttpServer())
        .get(`/claims/${claimId}/reserves`)
        .set('Authorization', `Bearer ${auditorToken}`)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
    });
  });

  describe('POST /reserves/:id/approve - Manager Approval', () => {
    let reserveId: string;

    beforeAll(async () => {
      // Create a reserve to approve
      const reserve = await prisma.reserve.create({
        data: {
          claim_id: claimId,
          category: 'loss_unpaid',
          proposed_yen: new Decimal('500000'),
          justification: 'This is a detailed justification for the reserve proposal that exceeds fifty characters.',
          proposed_by_id: adjusterId,
          approval_status: 'pending',
        },
      });
      reserveId = reserve.id;
    });

    it('should approve a reserve within manager limit (≤¥10M)', async () => {
      const response = await request(app.getHttpServer())
        .post(`/reserves/${reserveId}/approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);

      expect(response.body.approval_status).toBe('approved');
      expect(response.body.approved_by_id).toBe(managerId);
      expect(response.body.approved_at).toBeDefined();
    });

    it('should reject approval of already-approved reserve', async () => {
      await request(app.getHttpServer())
        .post(`/reserves/${reserveId}/approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(400);
    });

    it('should deny approval for non-manager role', async () => {
      const reserve = await prisma.reserve.create({
        data: {
          claim_id: claimId,
          category: 'alae',
          proposed_yen: new Decimal('300000'),
          justification: 'This is a detailed justification for the reserve proposal that exceeds fifty characters.',
          proposed_by_id: adjusterId,
          approval_status: 'pending',
        },
      });

      await request(app.getHttpServer())
        .post(`/reserves/${reserve.id}/approve`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .expect(403);
    });
  });

  describe('POST /reserves/:id/director-approve - Director Approval (>¥10M)', () => {
    let largeReserveId: string;

    beforeAll(async () => {
      // Create a large reserve (>¥10M) that requires director approval
      const reserve = await prisma.reserve.create({
        data: {
          claim_id: claimId,
          category: 'loss_paid',
          proposed_yen: new Decimal('15000000'),
          justification: 'This is a detailed justification for a large reserve proposal that exceeds fifty characters and requires director approval.',
          proposed_by_id: adjusterId,
          approval_status: 'pending',
        },
      });
      largeReserveId = reserve.id;
    });

    it('should reject manager approval of reserve >¥10M', async () => {
      await request(app.getHttpServer())
        .post(`/reserves/${largeReserveId}/approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(403);
    });

    it('should allow director to approve reserve >¥10M', async () => {
      const response = await request(app.getHttpServer())
        .post(`/reserves/${largeReserveId}/director-approve`)
        .set('Authorization', `Bearer ${directorToken}`)
        .expect(200);

      expect(response.body.approval_status).toBe('approved');
      expect(response.body.director_approved_by_id).toBe(directorId);
      expect(response.body.director_approved_at).toBeDefined();
    });

    it('should deny director approval for non-director manager', async () => {
      const reserve = await prisma.reserve.create({
        data: {
          claim_id: claimId,
          category: 'ulae',
          proposed_yen: new Decimal('20000000'),
          justification: 'This is a detailed justification for a large reserve proposal that exceeds fifty characters and requires director approval.',
          proposed_by_id: adjusterId,
          approval_status: 'pending',
        },
      });

      await request(app.getHttpServer())
        .post(`/reserves/${reserve.id}/director-approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(403);
    });
  });

  describe('POST /reserves/:id/reject - Reject Reserve', () => {
    let rejectableReserveId: string;

    beforeAll(async () => {
      const reserve = await prisma.reserve.create({
        data: {
          claim_id: claimId,
          category: 'loss_unpaid',
          proposed_yen: new Decimal('750000'),
          justification: 'This is a detailed justification for the reserve proposal that exceeds fifty characters.',
          proposed_by_id: adjusterId,
          approval_status: 'pending',
        },
      });
      rejectableReserveId = reserve.id;
    });

    it('should reject a pending reserve with valid reason', async () => {
      const dto = {
        reason_for_rejection: 'Insufficient evidence to support the proposed amount at this time.',
      };

      const response = await request(app.getHttpServer())
        .post(`/reserves/${rejectableReserveId}/reject`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send(dto)
        .expect(200);

      expect(response.body.approval_status).toBe('rejected');
      expect(response.body.reason_for_rejection).toBe(dto.reason_for_rejection);
    });

    it('should deny rejection for non-manager role', async () => {
      const reserve = await prisma.reserve.create({
        data: {
          claim_id: claimId,
          category: 'alae',
          proposed_yen: new Decimal('200000'),
          justification: 'This is a detailed justification for the reserve proposal that exceeds fifty characters.',
          proposed_by_id: adjusterId,
          approval_status: 'pending',
        },
      });

      const dto = {
        reason_for_rejection: 'Insufficient evidence to support the proposed amount at this time.',
      };

      await request(app.getHttpServer())
        .post(`/reserves/${reserve.id}/reject`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send(dto)
        .expect(403);
    });
  });

  describe('GET /reserves/export - IFRS17 Export', () => {
    beforeAll(async () => {
      // Create and approve some reserves for export
      const reserve1 = await prisma.reserve.create({
        data: {
          claim_id: claimId,
          category: 'loss_paid',
          proposed_yen: new Decimal('1000000'),
          justification: 'This is a detailed justification for the reserve proposal that exceeds fifty characters.',
          proposed_by_id: adjusterId,
          approval_status: 'approved',
          approved_by_id: managerId,
          approved_at: new Date(),
        },
      });

      const reserve2 = await prisma.reserve.create({
        data: {
          claim_id: claimId,
          category: 'loss_unpaid',
          proposed_yen: new Decimal('2000000'),
          justification: 'This is a detailed justification for the reserve proposal that exceeds fifty characters.',
          proposed_by_id: adjusterId,
          approval_status: 'approved',
          approved_by_id: managerId,
          approved_at: new Date(),
        },
      });
    });

    it('should export reserves by period in IFRS17-ready format', async () => {
      const currentMonth = new Date().toISOString().slice(0, 7);

      const response = await request(app.getHttpServer())
        .get(`/reserves/export?period=${currentMonth}`)
        .set('Authorization', `Bearer ${auditorToken}`)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      if (response.body.length > 0) {
        expect(response.body[0]).toHaveProperty('category');
        expect(response.body[0]).toHaveProperty('count');
        expect(response.body[0]).toHaveProperty('total_yen');
      }
    });

    it('should deny export for non-auditor role', async () => {
      const currentMonth = new Date().toISOString().slice(0, 7);

      await request(app.getHttpServer())
        .get(`/reserves/export?period=${currentMonth}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(403);
    });
  });

  describe('GET /notifications/jfsa-pending - JFSA Notifications', () => {
    beforeAll(async () => {
      // Create a notification by proposing a reserve that crosses ¥100M threshold
      await prisma.notificationToRegulator.create({
        data: {
          kind: 'jfsa_reserve_threshold',
          claim_id: claimId,
          reserve_id: 'test-reserve-id',
          amount_yen: new Decimal('150000000'),
        },
      });
    });

    it('should list pending JFSA notifications for auditor', async () => {
      const response = await request(app.getHttpServer())
        .get(`/notifications/jfsa-pending`)
        .set('Authorization', `Bearer ${auditorToken}`)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      if (response.body.length > 0) {
        expect(response.body[0]).toHaveProperty('id');
        expect(response.body[0]).toHaveProperty('kind');
        expect(response.body[0]).toHaveProperty('amount_yen');
        expect(response.body[0]).toHaveProperty('triggered_at');
      }
    });

    it('should deny JFSA notification access for non-auditor role', async () => {
      await request(app.getHttpServer())
        .get(`/notifications/jfsa-pending`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(403);
    });
  });

  describe('Reserve Approval Threshold Enforcement', () => {
    it('should enforce ¥10M threshold for director approval', async () => {
      // Create a ¥15M reserve
      const reserve = await prisma.reserve.create({
        data: {
          claim_id: claimId,
          category: 'loss_paid',
          proposed_yen: new Decimal('15000000'),
          justification: 'This is a detailed justification for a large reserve proposal that exceeds fifty characters and requires director approval.',
          proposed_by_id: adjusterId,
          approval_status: 'pending',
        },
      });

      // Manager should not be able to approve
      await request(app.getHttpServer())
        .post(`/reserves/${reserve.id}/approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(403);

      // Director should be able to approve
      const response = await request(app.getHttpServer())
        .post(`/reserves/${reserve.id}/director-approve`)
        .set('Authorization', `Bearer ${directorToken}`)
        .expect(200);

      expect(response.body.approval_status).toBe('approved');
    });

    it('should allow manager to approve reserves ≤¥10M', async () => {
      const reserve = await prisma.reserve.create({
        data: {
          claim_id: claimId,
          category: 'alae',
          proposed_yen: new Decimal('5000000'),
          justification: 'This is a detailed justification for the reserve proposal that exceeds fifty characters.',
          proposed_by_id: adjusterId,
          approval_status: 'pending',
        },
      });

      const response = await request(app.getHttpServer())
        .post(`/reserves/${reserve.id}/approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);

      expect(response.body.approval_status).toBe('approved');
      expect(response.body.approved_by_id).toBe(managerId);
    });
  });

  describe('Audit Event Emission', () => {
    it('should emit audit event on reserve proposal', async () => {
      const dto = {
        category: 'loss_unpaid',
        proposed_yen: '600000',
        justification: 'This is a detailed justification for the reserve proposal that exceeds fifty characters.',
      };

      const response = await request(app.getHttpServer())
        .post(`/claims/${claimId}/reserves`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send(dto)
        .expect(201);

      const reserveId = response.body.id;

      // Verify audit event was created
      const auditEvents = await prisma.auditEvent.findMany({
        where: {
          action: 'reserve.proposed',
          target_id: reserveId,
        },
      });

      expect(auditEvents.length).toBeGreaterThan(0);
      expect(auditEvents[0].actor_id).toBe(adjusterId);
      expect(auditEvents[0].action).toBe('reserve.proposed');
    });

    it('should emit audit event on reserve approval', async () => {
      const reserve = await prisma.reserve.create({
        data: {
          claim_id: claimId,
          category: 'ulae',
          proposed_yen: new Decimal('400000'),
          justification: 'This is a detailed justification for the reserve proposal that exceeds fifty characters.',
          proposed_by_id: adjusterId,
          approval_status: 'pending',
        },
      });

      await request(app.getHttpServer())
        .post(`/reserves/${reserve.id}/approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);

      const auditEvents = await prisma.auditEvent.findMany({
        where: {
          action: 'reserve.approved',
          target_id: reserve.id,
        },
      });

      expect(auditEvents.length).toBeGreaterThan(0);
      expect(auditEvents[0].actor_id).toBe(managerId);
    });
  });
});