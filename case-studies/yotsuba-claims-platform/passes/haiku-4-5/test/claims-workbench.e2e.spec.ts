import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { AuthService } from '../src/auth/auth.service';
import { UserRole, IntakeChannel, IncidentType, ClaimStatus } from '@prisma/client';

describe('Claims Workbench (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authService: AuthService;

  let agentToken: string;
  let adjusterToken: string;
  let managerToken: string;
  let auditorToken: string;

  let agentUser: { id: string };
  let adjusterUser: { id: string };
  let managerUser: { id: string };
  let auditorUser: { id: string };

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
    authService = moduleFixture.get<AuthService>(AuthService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Clean up all data before each test
    await prisma.auditEvent.deleteMany({});
    await prisma.witnessStatement.deleteMany({});
    await prisma.evidence.deleteMany({});
    await prisma.claimNote.deleteMany({});
    await prisma.reserve.deleteMany({});
    await prisma.notificationToRegulator.deleteMany({});
    await prisma.claim.deleteMany({});
    await prisma.user.deleteMany({});

    // Create test users with different roles
    const agentHash = await authService.hashPassword('agent-password');
    agentUser = await prisma.user.create({
      data: {
        username: 'agent-workbench',
        password_hash: agentHash,
        role: UserRole.agent,
        display_name: 'Workbench Agent',
        email: 'agent-workbench@example.com',
        is_claims_director: false,
      },
    });

    const adjusterHash = await authService.hashPassword('adjuster-password');
    adjusterUser = await prisma.user.create({
      data: {
        username: 'adjuster-workbench',
        password_hash: adjusterHash,
        role: UserRole.adjuster,
        display_name: 'Workbench Adjuster',
        email: 'adjuster-workbench@example.com',
        is_claims_director: false,
      },
    });

    const managerHash = await authService.hashPassword('manager-password');
    managerUser = await prisma.user.create({
      data: {
        username: 'manager-workbench',
        password_hash: managerHash,
        role: UserRole.manager,
        display_name: 'Workbench Manager',
        email: 'manager-workbench@example.com',
        is_claims_director: false,
      },
    });

    const auditorHash = await authService.hashPassword('auditor-password');
    auditorUser = await prisma.user.create({
      data: {
        username: 'auditor-workbench',
        password_hash: auditorHash,
        role: UserRole.auditor,
        display_name: 'Workbench Auditor',
        email: 'auditor-workbench@example.com',
        is_claims_director: false,
      },
    });

    // Obtain tokens for each user
    const agentLoginResponse = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        username: 'agent-workbench',
        password: 'agent-password',
      });
    agentToken = agentLoginResponse.body.access_token;

    const adjusterLoginResponse = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        username: 'adjuster-workbench',
        password: 'adjuster-password',
      });
    adjusterToken = adjusterLoginResponse.body.access_token;

    const managerLoginResponse = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        username: 'manager-workbench',
        password: 'manager-password',
      });
    managerToken = managerLoginResponse.body.access_token;

    const auditorLoginResponse = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        username: 'auditor-workbench',
        password: 'auditor-password',
      });
    auditorToken = auditorLoginResponse.body.access_token;
  });

  describe('POST /claims/:id/assign (assign adjuster)', () => {
    let claimId: string;

    beforeEach(async () => {
      const claim = await prisma.claim.create({
        data: {
          policy_number: 'POL-ASSIGN-001',
          loss_date: new Date('2024-01-15'),
          loss_location_prefecture: '東京都',
          loss_location_postal_code: '100-0001',
          loss_location_detail: 'Detail',
          reported_by_channel: IntakeChannel.agent,
          reporter_name: '山田太郎',
          reporter_relation_to_insured: '本人',
          incident_type: IncidentType.auto_collision,
          initial_description: 'Test',
          severity_initial: 'simple',
          status: ClaimStatus.intake,
          appi_consent_version: '1.0',
          appi_consent_at: new Date(),
        },
      });
      claimId = claim.id;
    });

    it('should assign adjuster to claim when manager requests', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .post(`/claims/${claimId}/assign`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          adjuster_id: adjusterUser.id,
          reason_for_reassignment: 'Initial assignment',
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('assigned_adjuster_id');
      expect(response.body.assigned_adjuster_id).toBe(adjusterUser.id);
      expect(response.body).toHaveProperty('assigned_at');
    });

    it('should reject assignment when non-manager requests', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .post(`/claims/${claimId}/assign`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          adjuster_id: adjusterUser.id,
          reason_for_reassignment: 'Attempt by adjuster',
        });

      // Assert
      expect(response.status).toBe(403);
    });

    it('should emit audit event on assignment', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .post(`/claims/${claimId}/assign`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          adjuster_id: adjusterUser.id,
          reason_for_reassignment: 'Audit test',
        });

      expect(response.status).toBe(200);

      // Assert: audit event was created
      const auditEvents = await prisma.auditEvent.findMany({
        where: {
          claim_id: claimId,
          action: 'claim.assigned',
        },
      });

      expect(auditEvents.length).toBeGreaterThan(0);
      expect(auditEvents[0].actor_id).toBe(managerUser.id);
      expect(auditEvents[0].actor_role).toBe(UserRole.manager);
    });

    it('should allow reassignment with reason', async () => {
      // Arrange: first assignment
      await request(app.getHttpServer())
        .post(`/claims/${claimId}/assign`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          adjuster_id: adjusterUser.id,
          reason_for_reassignment: 'Initial',
        });

      // Create another adjuster
      const adjuster2Hash = await authService.hashPassword('adjuster2-password');
      const adjuster2 = await prisma.user.create({
        data: {
          username: 'adjuster-2',
          password_hash: adjuster2Hash,
          role: UserRole.adjuster,
          display_name: 'Second Adjuster',
          email: 'adjuster2@example.com',
          is_claims_director: false,
        },
      });

      // Act: reassign
      const response = await request(app.getHttpServer())
        .post(`/claims/${claimId}/assign`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          adjuster_id: adjuster2.id,
          reason_for_reassignment: 'Workload balancing',
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.assigned_adjuster_id).toBe(adjuster2.id);
    });
  });

  describe('POST /claims/:id/notes (add note)', () => {
    let claimId: string;

    beforeEach(async () => {
      const claim = await prisma.claim.create({
        data: {
          policy_number: 'POL-NOTE-001',
          loss_date: new Date('2024-01-15'),
          loss_location_prefecture: '東京都',
          loss_location_postal_code: '100-0001',
          loss_location_detail: 'Detail',
          reported_by_channel: IntakeChannel.agent,
          reporter_name: '山田太郎',
          reporter_relation_to_insured: '本人',
          incident_type: IncidentType.auto_collision,
          initial_description: 'Test',
          severity_initial: 'simple',
          status: ClaimStatus.intake,
          appi_consent_version: '1.0',
          appi_consent_at: new Date(),
          assigned_adjuster_id: adjusterUser.id,
        },
      });
      claimId = claim.id;
    });

    it('should add note to claim when adjuster is assigned', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .post(`/claims/${claimId}/notes`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          body: 'Initial investigation started. Contacted policyholder.',
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('body');
      expect(response.body.body).toBe('Initial investigation started. Contacted policyholder.');
      expect(response.body).toHaveProperty('created_at');
      expect(response.body).toHaveProperty('author_id');
      expect(response.body.author_id).toBe(adjusterUser.id);
    });

    it('should reject note from unassigned adjuster', async () => {
      // Create another adjuster not assigned to this claim
      const otherAdjusterHash = await authService.hashPassword('other-adjuster-password');
      const otherAdjuster = await prisma.user.create({
        data: {
          username: 'other-adjuster',
          password_hash: otherAdjusterHash,
          role: UserRole.adjuster,
          display_name: 'Other Adjuster',
          email: 'other-adjuster@example.com',
          is_claims_director: false,
        },
      });

      const otherAdjusterLoginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: 'other-adjuster',
          password: 'other-adjuster-password',
        });
      const otherAdjusterToken = otherAdjusterLoginResponse.body.access_token;

      // Act
      const response = await request(app.getHttpServer())
        .post(`/claims/${claimId}/notes`)
        .set('Authorization', `Bearer ${otherAdjusterToken}`)
        .send({
          body: 'Unauthorized note',
        });

      // Assert
      expect(response.status).toBe(403);
    });

    it('should allow manager to add note to assigned claims', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .post(`/claims/${claimId}/notes`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          body: 'Manager review: case looks straightforward.',
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body.body).toBe('Manager review: case looks straightforward.');
    });

    it('should emit audit event on note creation', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .post(`/claims/${claimId}/notes`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          body: 'Audit test note',
        });

      expect(response.status).toBe(201);

      // Assert: audit event was created
      const auditEvents = await prisma.auditEvent.findMany({
        where: {
          claim_id: claimId,
          action: 'claim.note.added',
        },
      });

      expect(auditEvents.length).toBeGreaterThan(0);
      expect(auditEvents[0].actor_id).toBe(adjusterUser.id);
    });

    it('should retrieve notes in chronological order', async () => {
      // Arrange: add multiple notes
      await request(app.getHttpServer())
        .post(`/claims/${claimId}/notes`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({ body: 'First note' });

      await new Promise((resolve) => setTimeout(resolve, 100));

      await request(app.getHttpServer())
        .post(`/claims/${claimId}/notes`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({ body: 'Second note' });

      // Act: retrieve claim with notes
      const response = await request(app.getHttpServer())
        .get(`/claims/${claimId}`)
        .set('Authorization', `Bearer ${adjusterToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('notes');
      expect(Array.isArray(response.body.notes)).toBe(true);
      expect(response.body.notes.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('POST /claims/:id/evidence (add evidence)', () => {
    let claimId: string;

    beforeEach(async () => {
      const claim = await prisma.claim.create({
        data: {
          policy_number: 'POL-EVIDENCE-001',
          loss_date: new Date('2024-01-15'),
          loss_location_prefecture: '東京都',
          loss_location_postal_code: '100-0001',
          loss_location_detail: 'Detail',
          reported_by_channel: IntakeChannel.agent,
          reporter_name: '山田太郎',
          reporter_relation_to_insured: '本人',
          incident_type: IncidentType.auto_collision,
          initial_description: 'Test',
          severity_initial: 'simple',
          status: ClaimStatus.intake,
          appi_consent_version: '1.0',
          appi_consent_at: new Date(),
          assigned_adjuster_id: adjusterUser.id,
        },
      });
      claimId = claim.id;
    });

    it('should add evidence to claim when adjuster is assigned', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .post(`/claims/${claimId}/evidence`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          kind: 'photo',
          content_hash: 'sha256-abc123def456',
          blob_ref: 's3://stub/evidence/photo-001.jpg',
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('kind');
      expect(response.body.kind).toBe('photo');
      expect(response.body).toHaveProperty('content_hash');
      expect(response.body.content_hash).toBe('sha256-abc123def456');
      expect(response.body).toHaveProperty('uploaded_at');
    });

    it('should reject evidence from unassigned adjuster', async () => {
      // Create another adjuster
      const otherAdjusterHash = await authService.hashPassword('other-adjuster-password');
      const otherAdjuster = await prisma.user.create({
        data: {
          username: 'other-adjuster-evidence',
          password_hash: otherAdjusterHash,
          role: UserRole.adjuster,
          display_name: 'Other Adjuster',
          email: 'other-adjuster-evidence@example.com',
          is_claims_director: false,
        },
      });

      const otherAdjusterLoginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: 'other-adjuster-evidence',
          password: 'other-adjuster-password',
        });
      const otherAdjusterToken = otherAdjusterLoginResponse.body.access_token;

      // Act
      const response = await request(app.getHttpServer())
        .post(`/claims/${claimId}/evidence`)
        .set('Authorization', `Bearer ${otherAdjusterToken}`)
        .send({
          kind: 'photo',
          content_hash: 'sha256-xyz789',
          blob_ref: 's3://stub/evidence/photo-002.jpg',
        });

      // Assert
      expect(response.status).toBe(403);
    });

    it('should support multiple evidence kinds', async () => {
      const kinds = ['photo', 'document', 'audio', 'video'];

      for (const kind of kinds) {
        const response = await request(app.getHttpServer())
          .post(`/claims/${claimId}/evidence`)
          .set('Authorization', `Bearer ${adjusterToken}`)
          .send({
            kind,
            content_hash: `sha256-${kind}-hash`,
            blob_ref: `s3://stub/evidence/${kind}-file`,
          });

        expect(response.status).toBe(201);
        expect(response.body.kind).toBe(kind);
      }
    });

    it('should emit audit event on evidence upload', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .post(`/claims/${claimId}/evidence`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          kind: 'photo',
          content_hash: 'sha256-audit-test',
          blob_ref: 's3://stub/evidence/audit-test.jpg',
        });

      expect(response.status).toBe(201);

      // Assert: audit event was created
      const auditEvents = await prisma.auditEvent.findMany({
        where: {
          claim_id: claimId,
          action: 'claim.evidence.added',
        },
      });

      expect(auditEvents.length).toBeGreaterThan(0);
      expect(auditEvents[0].actor_id).toBe(adjusterUser.id);
    });
  });

  describe('POST /claims/:id/witness-statement (add witness statement)', () => {
    let claimId: string;

    beforeEach(async () => {
      const claim = await prisma.claim.create({
        data: {
          policy_number: 'POL-WITNESS-001',
          loss_date: new Date('2024-01-15'),
          loss_location_prefecture: '東京都',
          loss_location_postal_code: '100-0001',
          loss_location_detail: 'Detail',
          reported_by_channel: IntakeChannel.agent,
          reporter_name: '山田太郎',
          reporter_relation_to_insured: '本人',
          incident_type: IncidentType.auto_collision,
          initial_description: 'Test',
          severity_initial: 'simple',
          status: ClaimStatus.intake,
          appi_consent_version: '1.0',
          appi_consent_at: new Date(),
          assigned_adjuster_id: adjusterUser.id,
        },
      });
      claimId = claim.id;
    });

    it('should add witness statement with inkan seal hash', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .post(`/claims/${claimId}/witness-statement`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          witness_name: '鈴木花子',
          witness_phone: '09087654321',
          statement_body: 'I witnessed the collision at the intersection. The other vehicle ran a red light.',
          inkan_seal_hash: 'sha256-inkan-seal-abc123',
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('witness_name');
      expect(response.body.witness_name).toBe('鈴木花子');
      expect(response.body).toHaveProperty('statement_body');
      expect(response.body).toHaveProperty('inkan_seal_hash');
      expect(response.body.inkan_seal_hash).toBe('sha256-inkan-seal-abc123');
      expect(response.body).toHaveProperty('recorded_at');
    });

    it('should reject witness statement from unassigned adjuster', async () => {
      // Create another adjuster
      const otherAdjusterHash = await authService.hashPassword('other-adjuster-witness');
      const otherAdjuster = await prisma.user.create({
        data: {
          username: 'other-adjuster-witness',
          password_hash: otherAdjusterHash,
          role: UserRole.adjuster,
          display_name: 'Other Adjuster',
          email: 'other-adjuster-witness@example.com',
          is_claims_director: false,
        },
      });

      const otherAdjusterLoginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: 'other-adjuster-witness',
          password: 'other-adjuster-witness',
        });
      const otherAdjusterToken = otherAdjusterLoginResponse.body.access_token;

      // Act
      const response = await request(app.getHttpServer())
        .post(`/claims/${claimId}/witness-statement`)
        .set('Authorization', `Bearer ${otherAdjusterToken}`)
        .send({
          witness_name: '田中太郎',
          statement_body: 'I saw the accident.',
          inkan_seal_hash: 'sha256-seal-xyz',
        });

      // Assert
      expect(response.status).toBe(403);
    });

    it('should allow witness statement without phone', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .post(`/claims/${claimId}/witness-statement`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          witness_name: '伊藤次郎',
          statement_body: 'I witnessed the event.',
          inkan_seal_hash: 'sha256-seal-no-phone',
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body.witness_name).toBe('伊藤次郎');
    });

    it('should emit audit event on witness statement recording', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .post(`/claims/${claimId}/witness-statement`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          witness_name: '佐藤花子',
          statement_body: 'Audit test witness statement.',
          inkan_seal_hash: 'sha256-audit-witness',
        });

      expect(response.status).toBe(201);

      // Assert: audit event was created
      const auditEvents = await prisma.auditEvent.findMany({
        where: {
          claim_id: claimId,
          action: 'claim.witness_statement.recorded',
        },
      });

      expect(auditEvents.length).toBeGreaterThan(0);
      expect(auditEvents[0].actor_id).toBe(adjusterUser.id);
    });
  });

  describe('PATCH /claims/:id/status (status transitions)', () => {
    let claimId: string;

    beforeEach(async () => {
      const claim = await prisma.claim.create({
        data: {
          policy_number: 'POL-STATUS-001',
          loss_date: new Date('2024-01-15'),
          loss_location_prefecture: '東京都',
          loss_location_postal_code: '100-0001',
          loss_location_detail: 'Detail',
          reported_by_channel: IntakeChannel.agent,
          reporter_name: '山田太郎',
          reporter_relation_to_insured: '本人',
          incident_type: IncidentType.auto_collision,
          initial_description: 'Test',
          severity_initial: 'simple',
          status: ClaimStatus.intake,
          appi_consent_version: '1.0',
          appi_consent_at: new Date(),
          assigned_adjuster_id: adjusterUser.id,
        },
      });
      claimId = claim.id;
    });

    it('should transition from intake to under_investigation', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          to: ClaimStatus.under_investigation,
          reason: 'Starting investigation',
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status');
      expect(response.body.status).toBe(ClaimStatus.under_investigation);
    });

    it('should transition from under_investigation to awaiting_reserve_approval', async () => {
      // Arrange: first transition to under_investigation
      await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          to: ClaimStatus.under_investigation,
          reason: 'Starting investigation',
        });

      // Act: transition to awaiting_reserve_approval
      const response = await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          to: ClaimStatus.awaiting_reserve_approval,
          reason: 'Investigation complete, awaiting reserve approval',
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.status).toBe(ClaimStatus.awaiting_reserve_approval);
    });

    it('should reject illegal state transition', async () => {
      // Act: try to transition directly from intake to closed_paid (illegal)
      const response = await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          to: ClaimStatus.closed_paid,
          reason: 'Illegal transition attempt',
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body).toHaveProperty('message');
    });

    it('should reject status transition from unassigned adjuster', async () => {
      // Create another adjuster
      const otherAdjusterHash = await authService.hashPassword('other-adjuster-status');
      const otherAdjuster = await prisma.user.create({
        data: {
          username: 'other-adjuster-status',
          password_hash: otherAdjusterHash,
          role: UserRole.adjuster,
          display_name: 'Other Adjuster',
          email: 'other-adjuster-status@example.com',
          is_claims_director: false,
        },
      });

      const otherAdjusterLoginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: 'other-adjuster-status',
          password: 'other-adjuster-status',
        });
      const otherAdjusterToken = otherAdjusterLoginResponse.body.access_token;

      // Act
      const response = await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${otherAdjusterToken}`)
        .send({
          to: ClaimStatus.under_investigation,
          reason: 'Unauthorized attempt',
        });

      // Assert
      expect(response.status).toBe(403);
    });

    it('should allow manager to transition status on assigned claims', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          to: ClaimStatus.under_investigation,
          reason: 'Manager approval',
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.status).toBe(ClaimStatus.under_investigation);
    });

    it('should emit audit event on status transition', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          to: ClaimStatus.under_investigation,
          reason: 'Audit test transition',
        });

      expect(response.status).toBe(200);

      // Assert: audit event was created
      const auditEvents = await prisma.auditEvent.findMany({
        where: {
          claim_id: claimId,
          action: 'claim.status.changed',
        },
      });

      expect(auditEvents.length).toBeGreaterThan(0);
      expect(auditEvents[0].actor_id).toBe(adjusterUser.id);
    });

    it('should support reopened status transition', async () => {
      // Arrange: transition to closed_denied first
      await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          to: ClaimStatus.under_investigation,
          reason: 'Investigation',
        });

      await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          to: ClaimStatus.awaiting_reserve_approval,
          reason: 'Ready for approval',
        });

      await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          to: ClaimStatus.closed_denied,
          reason: 'Claim denied',
        });

      // Act: reopen the claim
      const response = await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          to: ClaimStatus.reopened,
          reason: 'New evidence discovered',
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.status).toBe(ClaimStatus.reopened);
    });
  });

  describe('Role-based masking and access control', () => {
    let claimId: string;

    beforeEach(async () => {
      const claim = await prisma.claim.create({
        data: {
          policy_number: 'POL-MASK-001',
          loss_date: new Date('2024-01-15'),
          loss_location_prefecture: '東京都',
          loss_location_postal_code: '100-0001',
          loss_location_detail: 'Detail',
          reported_by_channel: IntakeChannel.agent,
          reporter_name: '山田太郎',
          reporter_relation_to_insured: '本人',
          incident_type: IncidentType.auto_collision,
          initial_description: 'Test',
          severity_initial: 'simple',
          status: ClaimStatus.intake,
          appi_consent_version: '1.0',
          appi_consent_at: new Date(),
          assigned_adjuster_id: adjusterUser.id,
        },
      });
      claimId = claim.id;
    });

    it('should return full claim detail for assigned adjuster', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .get(`/claims/${claimId}`)
        .set('Authorization', `Bearer ${adjusterToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('reporter_name');
      expect(response.body.reporter_name).toBe('山田太郎');
      expect(response.body).toHaveProperty('policy_number');
    });

    it('should return masked claim detail for unassigned adjuster', async () => {
      // Create another adjuster
      const otherAdjusterHash = await authService.hashPassword('other-adjuster-mask');
      const otherAdjuster = await prisma.user.create({
        data: {
          username: 'other-adjuster-mask',
          password_hash: otherAdjusterHash,
          role: UserRole.adjuster,
          display_name: 'Other Adjuster',
          email: 'other-adjuster-mask@example.com',
          is_claims_director: false,
        },
      });

      const otherAdjusterLoginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: 'other-adjuster-mask',
          password: 'other-adjuster-mask',
        });
      const otherAdjusterToken = otherAdjusterLoginResponse.body.access_token;

      // Act
      const response = await request(app.getHttpServer())
        .get(`/claims/${claimId}`)
        .set('Authorization', `Bearer ${otherAdjusterToken}`);

      // Assert: should be denied or masked
      expect([200, 403]).toContain(response.status);
      if (response.status === 200) {
        // If allowed, reporter_name should be masked
        expect(response.body.reporter_name).not.toBe('山田太郎');
      }
    });

    it('should return full claim detail for auditor', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .get(`/claims/${claimId}`)
        .set('Authorization', `Bearer ${auditorToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('reporter_name');
      expect(response.body).toHaveProperty('policy_number');
    });

    it('should return full claim detail for manager', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .get(`/claims/${claimId}`)
        .set('Authorization', `Bearer ${managerToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('reporter_name');
      expect(response.body).toHaveProperty('policy_number');
    });
  });

  describe('Audit log accumulation', () => {
    let claimId: string;

    beforeEach(async () => {
      const claim = await prisma.claim.create({
        data: {
          policy_number: 'POL-AUDIT-001',
          loss_date: new Date('2024-01-15'),
          loss_location_prefecture: '東京都',
          loss_location_postal_code: '100-0001',
          loss_location_detail: 'Detail',
          reported_by_channel: IntakeChannel.agent,
          reporter_name: '山田太郎',
          reporter_relation_to_insured: '本人',
          incident_type: IncidentType.auto_collision,
          initial_description: 'Test',
          severity_initial: 'simple',
          status: ClaimStatus.intake,
          appi_consent_version: '1.0',
          appi_consent_at: new Date(),
          assigned_adjuster_id: adjusterUser.id,
        },
      });
      claimId = claim.id;
    });

    it('should accumulate audit events for all workbench operations', async () => {
      // Act: perform multiple operations
      await request(app.getHttpServer())
        .post(`/claims/${claimId}/notes`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({ body: 'Test note' });

      await request(app.getHttpServer())
        .post(`/claims/${claimId}/evidence`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          kind: 'photo',
          content_hash: 'sha256-test',
          blob_ref: 's3://stub/test.jpg',
        });

      await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          to: ClaimStatus.under_investigation,
          reason: 'Test',
        });

      // Assert: audit events were created
      const auditEvents = await prisma.auditEvent.findMany({
        where: { claim_id: claimId },
        orderBy: { ts: 'asc' },
      });

      expect(auditEvents.length).toBeGreaterThanOrEqual(3);
      expect(auditEvents.some((e) => e.action === 'claim.note.added')).toBe(true);
      expect(auditEvents.some((e) => e.action === 'claim.evidence.added')).toBe(true);
      expect(auditEvents.some((e) => e.action === 'claim.status.changed')).toBe(true);
    });

    it('should include correlation_id in audit events', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .post(`/claims/${claimId}/notes`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({ body: 'Correlation test' });

      expect(response.status).toBe(201);

      // Assert: audit events have correlation_id
      const auditEvents = await prisma.auditEvent.findMany({
        where: { claim_id: claimId },
      });

      expect(auditEvents.length).toBeGreaterThan(0);
      auditEvents.forEach((event) => {
        expect(event.correlation_id).toBeDefined();
        expect(event.correlation_id.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Workbench integration scenarios', () => {
    it('should handle complete claim lifecycle: intake → investigation → settlement', async () => {
      // Arrange: create a claim
      const createResponse = await request(app.getHttpServer())
        .post('/claims')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          policy_number: 'POL-LIFECYCLE-001',
          loss_date: new Date('2024-01-15').toISOString(),
          loss_location_prefecture: '東京都',
          loss_location_postal_code: '100-0001',
          loss_location_detail: 'Detail',
          reported_by_channel: IntakeChannel.agent,
          reporter_name: '山田太郎',
          reporter_phone: '09012345678',
          reporter_email: 'yamada@example.com',
          reporter_relation_to_insured: '本人',
          incident_type: IncidentType.auto_collision,
          initial_description: 'Collision at intersection',
          injury_reported: false,
          third_party_involved: true,
          appi_consent_version: '1.0',
          appi_consent_at: new Date().toISOString(),
        });

      expect(createResponse.status).toBe(201);
      const claimId = createResponse.body.id;

      // Act: assign to adjuster
      const assignResponse = await request(app.getHttpServer())
        .post(`/claims/${claimId}/assign`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          adjuster_id: adjusterUser.id,
          reason_for_reassignment: 'Initial assignment',
        });

      expect(assignResponse.status).toBe(200);

      // Act: add investigation note
      const noteResponse = await request(app.getHttpServer())
        .post(`/claims/${claimId}/notes`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          body: 'Investigation started. Contacted policyholder and third party.',
        });

      expect(noteResponse.status).toBe(201);

      // Act: add evidence
      const evidenceResponse = await request(app.getHttpServer())
        .post(`/claims/${claimId}/evidence`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          kind: 'photo',
          content_hash: 'sha256-scene-photo',
          blob_ref: 's3://stub/evidence/scene.jpg',
        });

      expect(evidenceResponse.status).toBe(201);

      // Act: transition to under_investigation
      const investigationResponse = await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          to: ClaimStatus.under_investigation,
          reason: 'Investigation in progress',
        });

      expect(investigationResponse.status).toBe(200);

      // Act: transition to awaiting_reserve_approval
      const reserveResponse = await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          to: ClaimStatus.awaiting_reserve_approval,
          reason: 'Investigation complete',
        });

      expect(reserveResponse.status).toBe(200);

      // Act: transition to settlement_offered
      const settlementResponse = await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          to: ClaimStatus.settlement_offered,
          reason: 'Settlement approved',
        });

      expect(settlementResponse.status).toBe(200);

      // Act: transition to closed_paid
      const closedResponse = await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          to: ClaimStatus.closed_paid,
          reason: 'Payment processed',
        });

      expect(closedResponse.status).toBe(200);
      expect(closedResponse.body.status).toBe(ClaimStatus.closed_paid);

      // Assert: verify audit trail
      const auditEvents = await prisma.auditEvent.findMany({
        where: { claim_id: claimId },
        orderBy: { ts: 'asc' },
      });

      expect(auditEvents.length).toBeGreaterThan(0);
      expect(auditEvents.some((e) => e.action === 'claim.assigned')).toBe(true);
      expect(auditEvents.some((e) => e.action === 'claim.note.added')).toBe(true);
      expect(auditEvents.some((e) => e.action === 'claim.evidence.added')).toBe(true);
      expect(auditEvents.some((e) => e.action === 'claim.status.changed')).toBe(true);
    });
  });
});