import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { AuthService } from '../src/auth/auth.service';
import { UserRole, IntakeChannel, IncidentType, ClaimSeverity } from '@prisma/client';

describe('Claims FNOL (e2e)', () => {
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
        username: 'agent-fnol',
        password_hash: agentHash,
        role: UserRole.agent,
        display_name: 'FNOL Agent',
        email: 'agent-fnol@example.com',
        is_claims_director: false,
      },
    });

    const adjusterHash = await authService.hashPassword('adjuster-password');
    adjusterUser = await prisma.user.create({
      data: {
        username: 'adjuster-fnol',
        password_hash: adjusterHash,
        role: UserRole.adjuster,
        display_name: 'FNOL Adjuster',
        email: 'adjuster-fnol@example.com',
        is_claims_director: false,
      },
    });

    const managerHash = await authService.hashPassword('manager-password');
    managerUser = await prisma.user.create({
      data: {
        username: 'manager-fnol',
        password_hash: managerHash,
        role: UserRole.manager,
        display_name: 'FNOL Manager',
        email: 'manager-fnol@example.com',
        is_claims_director: false,
      },
    });

    const auditorHash = await authService.hashPassword('auditor-password');
    auditorUser = await prisma.user.create({
      data: {
        username: 'auditor-fnol',
        password_hash: auditorHash,
        role: UserRole.auditor,
        display_name: 'FNOL Auditor',
        email: 'auditor-fnol@example.com',
        is_claims_director: false,
      },
    });

    // Obtain tokens for each user
    const agentLoginResponse = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        username: 'agent-fnol',
        password: 'agent-password',
      });
    agentToken = agentLoginResponse.body.access_token;

    const adjusterLoginResponse = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        username: 'adjuster-fnol',
        password: 'adjuster-password',
      });
    adjusterToken = adjusterLoginResponse.body.access_token;

    const managerLoginResponse = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        username: 'manager-fnol',
        password: 'manager-password',
      });
    managerToken = managerLoginResponse.body.access_token;

    const auditorLoginResponse = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        username: 'auditor-fnol',
        password: 'auditor-password',
      });
    auditorToken = auditorLoginResponse.body.access_token;
  });

  describe('POST /claims (FNOL intake)', () => {
    it('should create a claim with valid payload from agent', async () => {
      // Arrange
      const payload = {
        policy_number: 'POL-2024-001',
        loss_date: new Date('2024-01-15').toISOString(),
        loss_location_prefecture: '東京都',
        loss_location_postal_code: '100-0001',
        loss_location_detail: '1-1-1 Chiyoda, Chiyoda Ward',
        reported_by_channel: IntakeChannel.agent,
        reporter_name: '山田太郎',
        reporter_phone: '09012345678',
        reporter_email: 'yamada@example.com',
        reporter_relation_to_insured: '本人',
        incident_type: IncidentType.auto_collision,
        initial_description: 'Collision at intersection',
        injury_reported: false,
        third_party_involved: true,
        police_report_number: 'POL-2024-12345',
        appi_consent_version: '1.0',
        appi_consent_at: new Date().toISOString(),
      };

      // Act
      const response = await request(app.getHttpServer())
        .post('/claims')
        .set('Authorization', `Bearer ${agentToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('policy_number');
      expect(response.body.policy_number).toBe('POL-2024-001');
      expect(response.body).toHaveProperty('incident_type');
      expect(response.body.incident_type).toBe(IncidentType.auto_collision);
      expect(response.body).toHaveProperty('status');
      expect(response.body.status).toBe('intake');
      expect(response.body).toHaveProperty('severity_initial');
      expect(response.body.severity_initial).toBe(ClaimSeverity.simple);
      expect(response.body).toHaveProperty('reported_by_channel');
      expect(response.body.reported_by_channel).toBe(IntakeChannel.agent);
      expect(response.body).toHaveProperty('created_at');
    });

    it('should reject claim without APPI consent', async () => {
      // Arrange
      const payload = {
        policy_number: 'POL-2024-002',
        loss_date: new Date('2024-01-15').toISOString(),
        loss_location_prefecture: '東京都',
        loss_location_postal_code: '100-0001',
        loss_location_detail: '1-1-1 Chiyoda',
        reported_by_channel: IntakeChannel.mobile,
        reporter_name: '田中花子',
        reporter_phone: '09087654321',
        reporter_email: 'tanaka@example.com',
        reporter_relation_to_insured: '本人',
        incident_type: IncidentType.fire_residential,
        initial_description: 'Fire in residential building',
        injury_reported: false,
        third_party_involved: false,
        // Missing appi_consent_version and appi_consent_at
      };

      // Act
      const response = await request(app.getHttpServer())
        .post('/claims')
        .set('Authorization', `Bearer ${agentToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('message');
    });

    it('should reject claim with loss_date before policy effective date', async () => {
      // Arrange
      const payload = {
        policy_number: 'POL-2024-003',
        loss_date: new Date('2023-01-01').toISOString(), // Before policy start
        loss_location_prefecture: '大阪府',
        loss_location_postal_code: '530-0001',
        loss_location_detail: 'Osaka detail',
        reported_by_channel: IntakeChannel.agent,
        reporter_name: '佐藤次郎',
        reporter_phone: '09011111111',
        reporter_email: 'sato@example.com',
        reporter_relation_to_insured: '本人',
        incident_type: IncidentType.marine_cargo,
        initial_description: 'Marine cargo loss',
        injury_reported: false,
        third_party_involved: false,
        appi_consent_version: '1.0',
        appi_consent_at: new Date().toISOString(),
      };

      // Act
      const response = await request(app.getHttpServer())
        .post('/claims')
        .set('Authorization', `Bearer ${agentToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('message');
    });

    it('should reject claim with invalid prefecture', async () => {
      // Arrange
      const payload = {
        policy_number: 'POL-2024-004',
        loss_date: new Date('2024-01-15').toISOString(),
        loss_location_prefecture: 'InvalidPrefecture',
        loss_location_postal_code: '100-0001',
        loss_location_detail: 'Detail',
        reported_by_channel: IntakeChannel.agent,
        reporter_name: 'Test User',
        reporter_phone: '09012345678',
        reporter_email: 'test@example.com',
        reporter_relation_to_insured: '本人',
        incident_type: IncidentType.auto_collision,
        initial_description: 'Test',
        injury_reported: false,
        third_party_involved: false,
        appi_consent_version: '1.0',
        appi_consent_at: new Date().toISOString(),
      };

      // Act
      const response = await request(app.getHttpServer())
        .post('/claims')
        .set('Authorization', `Bearer ${agentToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('message');
    });

    it('should reject claim without authorization', async () => {
      // Arrange
      const payload = {
        policy_number: 'POL-2024-005',
        loss_date: new Date('2024-01-15').toISOString(),
        loss_location_prefecture: '東京都',
        loss_location_postal_code: '100-0001',
        loss_location_detail: 'Detail',
        reported_by_channel: IntakeChannel.agent,
        reporter_name: 'Test',
        reporter_phone: '09012345678',
        reporter_email: 'test@example.com',
        reporter_relation_to_insured: '本人',
        incident_type: IncidentType.auto_collision,
        initial_description: 'Test',
        injury_reported: false,
        third_party_involved: false,
        appi_consent_version: '1.0',
        appi_consent_at: new Date().toISOString(),
      };

      // Act
      const response = await request(app.getHttpServer())
        .post('/claims')
        .send(payload);

      // Assert
      expect(response.status).toBe(401);
    });

    it('should classify severity as simple for low-value auto collision', async () => {
      // Arrange
      const payload = {
        policy_number: 'POL-2024-006',
        loss_date: new Date('2024-01-15').toISOString(),
        loss_location_prefecture: '東京都',
        loss_location_postal_code: '100-0001',
        loss_location_detail: 'Detail',
        reported_by_channel: IntakeChannel.agent,
        reporter_name: 'Test',
        reporter_phone: '09012345678',
        reporter_email: 'test@example.com',
        reporter_relation_to_insured: '本人',
        incident_type: IncidentType.auto_collision,
        initial_description: 'Minor collision',
        injury_reported: false,
        third_party_involved: false,
        appi_consent_version: '1.0',
        appi_consent_at: new Date().toISOString(),
      };

      // Act
      const response = await request(app.getHttpServer())
        .post('/claims')
        .set('Authorization', `Bearer ${agentToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(201);
      expect(response.body.severity_initial).toBe(ClaimSeverity.simple);
    });

    it('should classify severity as complex for injury claim', async () => {
      // Arrange
      const payload = {
        policy_number: 'POL-2024-007',
        loss_date: new Date('2024-01-15').toISOString(),
        loss_location_prefecture: '東京都',
        loss_location_postal_code: '100-0001',
        loss_location_detail: 'Detail',
        reported_by_channel: IntakeChannel.agent,
        reporter_name: 'Test',
        reporter_phone: '09012345678',
        reporter_email: 'test@example.com',
        reporter_relation_to_insured: '本人',
        incident_type: IncidentType.auto_collision,
        initial_description: 'Collision with injury',
        injury_reported: true,
        third_party_involved: true,
        appi_consent_version: '1.0',
        appi_consent_at: new Date().toISOString(),
      };

      // Act
      const response = await request(app.getHttpServer())
        .post('/claims')
        .set('Authorization', `Bearer ${agentToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(201);
      expect(response.body.severity_initial).toBe(ClaimSeverity.complex);
    });

    it('should emit audit event on claim creation', async () => {
      // Arrange
      const payload = {
        policy_number: 'POL-2024-008',
        loss_date: new Date('2024-01-15').toISOString(),
        loss_location_prefecture: '東京都',
        loss_location_postal_code: '100-0001',
        loss_location_detail: 'Detail',
        reported_by_channel: IntakeChannel.agent,
        reporter_name: 'Test',
        reporter_phone: '09012345678',
        reporter_email: 'test@example.com',
        reporter_relation_to_insured: '本人',
        incident_type: IncidentType.auto_collision,
        initial_description: 'Test',
        injury_reported: false,
        third_party_involved: false,
        appi_consent_version: '1.0',
        appi_consent_at: new Date().toISOString(),
      };

      // Act
      const response = await request(app.getHttpServer())
        .post('/claims')
        .set('Authorization', `Bearer ${agentToken}`)
        .send(payload);

      expect(response.status).toBe(201);
      const claimId = response.body.id;

      // Assert: audit event was created
      const auditEvents = await prisma.auditEvent.findMany({
        where: {
          claim_id: claimId,
          action: 'claim.created',
        },
      });

      expect(auditEvents.length).toBeGreaterThan(0);
      expect(auditEvents[0].actor_id).toBe(agentUser.id);
      expect(auditEvents[0].actor_role).toBe(UserRole.agent);
    });

    it('should store APPI consent version and timestamp', async () => {
      // Arrange
      const consentVersion = '2.0';
      const consentTime = new Date('2024-01-15T10:00:00Z');
      const payload = {
        policy_number: 'POL-2024-009',
        loss_date: new Date('2024-01-15').toISOString(),
        loss_location_prefecture: '東京都',
        loss_location_postal_code: '100-0001',
        loss_location_detail: 'Detail',
        reported_by_channel: IntakeChannel.agent,
        reporter_name: 'Test',
        reporter_phone: '09012345678',
        reporter_email: 'test@example.com',
        reporter_relation_to_insured: '本人',
        incident_type: IncidentType.auto_collision,
        initial_description: 'Test',
        injury_reported: false,
        third_party_involved: false,
        appi_consent_version: consentVersion,
        appi_consent_at: consentTime.toISOString(),
      };

      // Act
      const response = await request(app.getHttpServer())
        .post('/claims')
        .set('Authorization', `Bearer ${agentToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(201);
      expect(response.body.appi_consent_version).toBe(consentVersion);
      expect(response.body.appi_consent_at).toBeDefined();
    });
  });

  describe('POST /claims/mobile (mobile channel)', () => {
    it('should create claim via mobile channel with APPI consent', async () => {
      // Arrange
      const payload = {
        policy_number: 'POL-2024-100',
        loss_date: new Date('2024-01-15').toISOString(),
        loss_location_prefecture: '大阪府',
        loss_location_postal_code: '530-0001',
        loss_location_detail: 'Osaka detail',
        reporter_name: '鈴木花子',
        reporter_phone: '09099999999',
        reporter_email: 'suzuki@example.com',
        reporter_relation_to_insured: '本人',
        incident_type: IncidentType.fire_residential,
        initial_description: 'Fire in home',
        injury_reported: false,
        third_party_involved: false,
        appi_consent_version: '1.0',
        appi_consent_at: new Date().toISOString(),
      };

      // Act
      const response = await request(app.getHttpServer())
        .post('/claims/mobile')
        .set('Authorization', `Bearer ${agentToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(201);
      expect(response.body.reported_by_channel).toBe(IntakeChannel.mobile);
      expect(response.body.incident_type).toBe(IncidentType.fire_residential);
    });

    it('should reject mobile claim without APPI consent', async () => {
      // Arrange
      const payload = {
        policy_number: 'POL-2024-101',
        loss_date: new Date('2024-01-15').toISOString(),
        loss_location_prefecture: '大阪府',
        loss_location_postal_code: '530-0001',
        loss_location_detail: 'Detail',
        reporter_name: 'Test',
        reporter_phone: '09012345678',
        reporter_email: 'test@example.com',
        reporter_relation_to_insured: '本人',
        incident_type: IncidentType.fire_residential,
        initial_description: 'Fire',
        injury_reported: false,
        third_party_involved: false,
        // Missing APPI consent
      };

      // Act
      const response = await request(app.getHttpServer())
        .post('/claims/mobile')
        .set('Authorization', `Bearer ${agentToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(400);
    });
  });

  describe('POST /claims/broker (broker channel)', () => {
    it('should create claim via broker channel', async () => {
      // Arrange
      const payload = {
        policy_number: 'POL-2024-200',
        loss_date: new Date('2024-01-15').toISOString(),
        loss_location_prefecture: '京都府',
        loss_location_postal_code: '600-0001',
        loss_location_detail: 'Kyoto detail',
        reporter_name: '伊藤太郎',
        reporter_phone: '09088888888',
        reporter_email: 'ito@example.com',
        reporter_relation_to_insured: '代理店',
        incident_type: IncidentType.liability_premises,
        initial_description: 'Premises liability',
        injury_reported: true,
        third_party_involved: true,
        appi_consent_version: '1.0',
        appi_consent_at: new Date().toISOString(),
      };

      // Act
      const response = await request(app.getHttpServer())
        .post('/claims/broker')
        .set('Authorization', `Bearer ${agentToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(201);
      expect(response.body.reported_by_channel).toBe(IntakeChannel.broker);
      expect(response.body.incident_type).toBe(IncidentType.liability_premises);
    });
  });

  describe('POST /claims/email-parse (email channel)', () => {
    it('should create claim via email channel with idempotency', async () => {
      // Arrange
      const messageId = 'msg-2024-001@example.com';
      const payload = {
        policy_number: 'POL-2024-300',
        loss_date: new Date('2024-01-15').toISOString(),
        loss_location_prefecture: '福岡県',
        loss_location_postal_code: '810-0001',
        loss_location_detail: 'Fukuoka detail',
        reporter_name: '高橋次郎',
        reporter_phone: '09077777777',
        reporter_email: 'takahashi@example.com',
        reporter_relation_to_insured: '本人',
        incident_type: IncidentType.personal_accident,
        initial_description: 'Personal accident',
        injury_reported: true,
        third_party_involved: false,
        message_id: messageId,
        appi_consent_version: '1.0',
        appi_consent_at: new Date().toISOString(),
      };

      // Act: first submission
      const response1 = await request(app.getHttpServer())
        .post('/claims/email-parse')
        .set('Authorization', `Bearer ${agentToken}`)
        .send(payload);

      expect(response1.status).toBe(201);
      const claimId1 = response1.body.id;

      // Act: second submission with same message_id (should be idempotent)
      const response2 = await request(app.getHttpServer())
        .post('/claims/email-parse')
        .set('Authorization', `Bearer ${agentToken}`)
        .send(payload);

      // Assert: should return same claim or 409 conflict
      expect([201, 409]).toContain(response2.status);
      if (response2.status === 201) {
        expect(response2.body.id).toBe(claimId1);
      }
    });
  });

  describe('GET /claims (list with role-based filtering)', () => {
    beforeEach(async () => {
      // Create multiple claims for filtering tests
      await prisma.claim.create({
        data: {
          policy_number: 'POL-LIST-001',
          loss_date: new Date('2024-01-15'),
          loss_location_prefecture: '東京都',
          loss_location_postal_code: '100-0001',
          loss_location_detail: 'Detail',
          reported_by_channel: IntakeChannel.agent,
          reporter_name: 'Test 1',
          reporter_relation_to_insured: '本人',
          incident_type: IncidentType.auto_collision,
          initial_description: 'Test',
          severity_initial: ClaimSeverity.simple,
          status: 'intake',
          appi_consent_version: '1.0',
          appi_consent_at: new Date(),
        },
      });

      await prisma.claim.create({
        data: {
          policy_number: 'POL-LIST-002',
          loss_date: new Date('2024-01-16'),
          loss_location_prefecture: '大阪府',
          loss_location_postal_code: '530-0001',
          loss_location_detail: 'Detail',
          reported_by_channel: IntakeChannel.mobile,
          reporter_name: 'Test 2',
          reporter_relation_to_insured: '本人',
          incident_type: IncidentType.fire_residential,
          initial_description: 'Test',
          severity_initial: ClaimSeverity.complex,
          status: 'under_investigation',
          appi_consent_version: '1.0',
          appi_consent_at: new Date(),
        },
      });
    });

    it('should list claims for auditor without role restrictions', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .get('/claims')
        .set('Authorization', `Bearer ${auditorToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThanOrEqual(2);
    });

    it('should filter claims by status', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .get('/claims?status=intake')
        .set('Authorization', `Bearer ${auditorToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.every((c: any) => c.status === 'intake')).toBe(true);
    });

    it('should filter claims by severity', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .get('/claims?severity=complex')
        .set('Authorization', `Bearer ${auditorToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.every((c: any) => c.severity_initial === ClaimSeverity.complex)).toBe(true);
    });

    it('should filter claims by channel', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .get('/claims?channel=mobile')
        .set('Authorization', `Bearer ${auditorToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.every((c: any) => c.reported_by_channel === IntakeChannel.mobile)).toBe(true);
    });

    it('should reject list request without authorization', async () => {
      // Act
      const response = await request(app.getHttpServer()).get('/claims');

      // Assert
      expect(response.status).toBe(401);
    });
  });

  describe('GET /claims/:id (claim detail with role-based masking)', () => {
    let claimId: string;

    beforeEach(async () => {
      const claim = await prisma.claim.create({
        data: {
          policy_number: 'POL-DETAIL-001',
          loss_date: new Date('2024-01-15'),
          loss_location_prefecture: '東京都',
          loss_location_postal_code: '100-0001',
          loss_location_detail: 'Detail',
          reported_by_channel: IntakeChannel.agent,
          reporter_name: '山田太郎',
          reporter_relation_to_insured: '本人',
          incident_type: IncidentType.auto_collision,
          initial_description: 'Test',
          severity_initial: ClaimSeverity.simple,
          status: 'intake',
          appi_consent_version: '1.0',
          appi_consent_at: new Date(),
        },
      });
      claimId = claim.id;
    });

    it('should return claim detail for authorized user', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .get(`/claims/${claimId}`)
        .set('Authorization', `Bearer ${auditorToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('id');
      expect(response.body.id).toBe(claimId);
      expect(response.body).toHaveProperty('policy_number');
      expect(response.body).toHaveProperty('incident_type');
      expect(response.body).toHaveProperty('status');
    });

    it('should return 401 for unauthorized user', async () => {
      // Act
      const response = await request(app.getHttpServer()).get(`/claims/${claimId}`);

      // Assert
      expect(response.status).toBe(401);
    });

    it('should return 404 for non-existent claim', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .get('/claims/nonexistent-id')
        .set('Authorization', `Bearer ${auditorToken}`);

      // Assert
      expect(response.status).toBe(404);
    });
  });

  describe('Validation and error handling', () => {
    it('should reject claim with missing required fields', async () => {
      // Arrange: missing incident_type
      const payload = {
        policy_number: 'POL-2024-VAL-001',
        loss_date: new Date('2024-01-15').toISOString(),
        loss_location_prefecture: '東京都',
        loss_location_postal_code: '100-0001',
        loss_location_detail: 'Detail',
        reported_by_channel: IntakeChannel.agent,
        reporter_name: 'Test',
        reporter_phone: '09012345678',
        reporter_email: 'test@example.com',
        reporter_relation_to_insured: '本人',
        // Missing incident_type
        initial_description: 'Test',
        injury_reported: false,
        third_party_involved: false,
        appi_consent_version: '1.0',
        appi_consent_at: new Date().toISOString(),
      };

      // Act
      const response = await request(app.getHttpServer())
        .post('/claims')
        .set('Authorization', `Bearer ${agentToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('message');
    });

    it('should reject claim with invalid incident_type', async () => {
      // Arrange
      const payload = {
        policy_number: 'POL-2024-VAL-002',
        loss_date: new Date('2024-01-15').toISOString(),
        loss_location_prefecture: '東京都',
        loss_location_postal_code: '100-0001',
        loss_location_detail: 'Detail',
        reported_by_channel: IntakeChannel.agent,
        reporter_name: 'Test',
        reporter_phone: '09012345678',
        reporter_email: 'test@example.com',
        reporter_relation_to_insured: '本人',
        incident_type: 'invalid_type',
        initial_description: 'Test',
        injury_reported: false,
        third_party_involved: false,
        appi_consent_version: '1.0',
        appi_consent_at: new Date().toISOString(),
      };

      // Act
      const response = await request(app.getHttpServer())
        .post('/claims')
        .set('Authorization', `Bearer ${agentToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(400);
    });

    it('should reject claim with invalid channel', async () => {
      // Arrange
      const payload = {
        policy_number: 'POL-2024-VAL-003',
        loss_date: new Date('2024-01-15').toISOString(),
        loss_location_prefecture: '東京都',
        loss_location_postal_code: '100-0001',
        loss_location_detail: 'Detail',
        reported_by_channel: 'invalid_channel',
        reporter_name: 'Test',
        reporter_phone: '09012345678',
        reporter_email: 'test@example.com',
        reporter_relation_to_insured: '本人',
        incident_type: IncidentType.auto_collision,
        initial_description: 'Test',
        injury_reported: false,
        third_party_involved: false,
        appi_consent_version: '1.0',
        appi_consent_at: new Date().toISOString(),
      };

      // Act
      const response = await request(app.getHttpServer())
        .post('/claims')
        .set('Authorization', `Bearer ${agentToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(400);
    });
  });

  describe('APPI consent and data protection', () => {
    it('should store APPI consent details for audit trail', async () => {
      // Arrange
      const consentVersion = '1.5';
      const consentTime = new Date('2024-01-15T12:00:00Z');
      const payload = {
        policy_number: 'POL-2024-APPI-001',
        loss_date: new Date('2024-01-15').toISOString(),
        loss_location_prefecture: '東京都',
        loss_location_postal_code: '100-0001',
        loss_location_detail: 'Detail',
        reported_by_channel: IntakeChannel.agent,
        reporter_name: 'Test',
        reporter_phone: '09012345678',
        reporter_email: 'test@example.com',
        reporter_relation_to_insured: '本人',
        incident_type: IncidentType.auto_collision,
        initial_description: 'Test',
        injury_reported: false,
        third_party_involved: false,
        appi_consent_version: consentVersion,
        appi_consent_at: consentTime.toISOString(),
      };

      // Act
      const response = await request(app.getHttpServer())
        .post('/claims')
        .set('Authorization', `Bearer ${agentToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(201);
      const claimId = response.body.id;

      // Verify in database
      const claim = await prisma.claim.findUnique({
        where: { id: claimId },
      });

      expect(claim?.appi_consent_version).toBe(consentVersion);
      expect(claim?.appi_consent_at).toBeDefined();
    });
  });

  describe('Incident type coverage', () => {
    const incidentTypes = [
      IncidentType.auto_collision,
      IncidentType.auto_property_damage,
      IncidentType.fire_residential,
      IncidentType.fire_commercial,
      IncidentType.marine_cargo,
      IncidentType.liability_premises,
      IncidentType.personal_accident,
    ];

    incidentTypes.forEach((incidentType) => {
      it(`should accept claim with incident_type=${incidentType}`, async () => {
        // Arrange
        const payload = {
          policy_number: `POL-2024-TYPE-${incidentType}`,
          loss_date: new Date('2024-01-15').toISOString(),
          loss_location_prefecture: '東京都',
          loss_location_postal_code: '100-0001',
          loss_location_detail: 'Detail',
          reported_by_channel: IntakeChannel.agent,
          reporter_name: 'Test',
          reporter_phone: '09012345678',
          reporter_email: 'test@example.com',
          reporter_relation_to_insured: '本人',
          incident_type: incidentType,
          initial_description: 'Test',
          injury_reported: false,
          third_party_involved: false,
          appi_consent_version: '1.0',
          appi_consent_at: new Date().toISOString(),
        };

        // Act
        const response = await request(app.getHttpServer())
          .post('/claims')
          .set('Authorization', `Bearer ${agentToken}`)
          .send(payload);

        // Assert
        expect(response.status).toBe(201);
        expect(response.body.incident_type).toBe(incidentType);
      });
    });
  });
});