import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, BadRequestException } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { User, UserRole, Claim, IncidentType, IntakeChannel, ClaimSeverity } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';

describe('APPI Module (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;

  let auditor: User;
  let manager: User;
  let adjuster: User;
  let agent: User;

  let testClaim: Claim;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    jwtService = moduleFixture.get<JwtService>(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Clean up test data
    await prisma.auditEvent.deleteMany({});
    await prisma.witnessStatement.deleteMany({});
    await prisma.evidence.deleteMany({});
    await prisma.claimNote.deleteMany({});
    await prisma.reserve.deleteMany({});
    await prisma.claim.deleteMany({});
    await prisma.user.deleteMany({});

    // Create test users
    auditor = await prisma.user.create({
      data: {
        username: 'auditor-appi',
        password_hash: 'hashed-password',
        role: UserRole.auditor,
        display_name: 'Auditor APPI',
        email: 'auditor@test.local',
      },
    });

    manager = await prisma.user.create({
      data: {
        username: 'manager-appi',
        password_hash: 'hashed-password',
        role: UserRole.manager,
        display_name: 'Manager APPI',
        email: 'manager@test.local',
      },
    });

    adjuster = await prisma.user.create({
      data: {
        username: 'adjuster-appi',
        password_hash: 'hashed-password',
        role: UserRole.adjuster,
        display_name: 'Adjuster APPI',
        email: 'adjuster@test.local',
      },
    });

    agent = await prisma.user.create({
      data: {
        username: 'agent-appi',
        password_hash: 'hashed-password',
        role: UserRole.agent,
        display_name: 'Agent APPI',
        email: 'agent@test.local',
      },
    });

    // Create a test claim with PII
    testClaim = await prisma.claim.create({
      data: {
        policy_number: 'POL-APPI-001',
        loss_date: new Date('2024-01-15'),
        loss_location_prefecture: '東京都',
        loss_location_postal_code: '100-0001',
        loss_location_detail: '東京都千代田区丸の内1-1-1',
        reported_by_channel: IntakeChannel.agent,
        reporter_name: 'Test Reporter',
        reporter_phone_ct: null,
        reporter_email_ct: null,
        reporter_relation_to_insured: '本人',
        incident_type: IncidentType.auto_collision,
        initial_description: 'Test collision incident',
        injury_reported: false,
        third_party_involved: false,
        police_report_number: null,
        severity_initial: ClaimSeverity.simple,
        appi_consent_version: '1.0',
        appi_consent_at: new Date(),
        assigned_adjuster_id: adjuster.id,
        insured_government_id_ct: null,
        bank_account_for_payout_ct: null,
        injury_details_ct: null,
      },
    });
  });

  describe('GET /claims/:id/data-subject-export', () => {
    it('should allow auditor to export data-subject information', async () => {
      const token = jwtService.sign({
        sub: auditor.id,
        username: auditor.username,
        role: auditor.role,
      });

      const response = await request(app.getHttpServer())
        .get(`/claims/${testClaim.id}/data-subject-export`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.body).toHaveProperty('export_timestamp');
      expect(response.body).toHaveProperty('exported_by', auditor.username);
      expect(response.body).toHaveProperty('exported_by_role', UserRole.auditor);
      expect(response.body).toHaveProperty('claim');
      expect(response.body.claim).toHaveProperty('id', testClaim.id);
      expect(response.body.claim).toHaveProperty('policy_number', 'POL-APPI-001');
      expect(response.body.claim).toHaveProperty('reporter');
      expect(response.body.claim.reporter).toHaveProperty('name', 'Test Reporter');
      expect(response.body).toHaveProperty('notes');
      expect(response.body).toHaveProperty('evidence');
      expect(response.body).toHaveProperty('witness_statements');
      expect(response.body).toHaveProperty('reserves');
      expect(response.body).toHaveProperty('audit_trail');
    });

    it('should allow manager to export data-subject information for assigned claims', async () => {
      const token = jwtService.sign({
        sub: manager.id,
        username: manager.username,
        role: manager.role,
      });

      const response = await request(app.getHttpServer())
        .get(`/claims/${testClaim.id}/data-subject-export`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.body).toHaveProperty('claim');
      expect(response.body.claim).toHaveProperty('id', testClaim.id);
    });

    it('should deny adjuster access to data-subject-export', async () => {
      const token = jwtService.sign({
        sub: adjuster.id,
        username: adjuster.username,
        role: adjuster.role,
      });

      await request(app.getHttpServer())
        .get(`/claims/${testClaim.id}/data-subject-export`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('should deny agent access to data-subject-export', async () => {
      const token = jwtService.sign({
        sub: agent.id,
        username: agent.username,
        role: agent.role,
      });

      await request(app.getHttpServer())
        .get(`/claims/${testClaim.id}/data-subject-export`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('should return 404 for non-existent claim', async () => {
      const token = jwtService.sign({
        sub: auditor.id,
        username: auditor.username,
        role: auditor.role,
      });

      await request(app.getHttpServer())
        .get('/claims/nonexistent-claim-id/data-subject-export')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });

    it('should include all claim relationships in export', async () => {
      // Add a note to the claim
      await prisma.claimNote.create({
        data: {
          claim_id: testClaim.id,
          author_id: adjuster.id,
          body: 'Test note for export',
        },
      });

      // Add evidence
      await prisma.evidence.create({
        data: {
          claim_id: testClaim.id,
          kind: 'photo',
          content_hash: 'abc123def456',
          blob_ref: 's3://stub/evidence-001',
          uploaded_by_id: adjuster.id,
        },
      });

      // Add witness statement
      await prisma.witnessStatement.create({
        data: {
          claim_id: testClaim.id,
          witness_name: 'Test Witness',
          witness_phone_ct: null,
          statement_body: 'I witnessed the incident',
          inkan_seal_hash: 'seal-hash-001',
          recorded_by_id: adjuster.id,
        },
      });

      const token = jwtService.sign({
        sub: auditor.id,
        username: auditor.username,
        role: auditor.role,
      });

      const response = await request(app.getHttpServer())
        .get(`/claims/${testClaim.id}/data-subject-export`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.body.notes).toHaveLength(1);
      expect(response.body.notes[0]).toHaveProperty('body', 'Test note for export');
      expect(response.body.evidence).toHaveLength(1);
      expect(response.body.evidence[0]).toHaveProperty('kind', 'photo');
      expect(response.body.witness_statements).toHaveLength(1);
      expect(response.body.witness_statements[0]).toHaveProperty('witness_name', 'Test Witness');
    });
  });

  describe('POST /claims/:id/personal-data-anonymise', () => {
    it('should allow manager to anonymise personal data', async () => {
      const token = jwtService.sign({
        sub: manager.id,
        username: manager.username,
        role: manager.role,
      });

      const response = await request(app.getHttpServer())
        .post(`/claims/${testClaim.id}/personal-data-anonymise`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          reason: 'Data subject requested deletion per APPI Article 17 compliance requirements',
        })
        .expect(200);

      expect(response.body).toHaveProperty('id', testClaim.id);
      expect(response.body).toHaveProperty('anonymised_at');
      expect(response.body).toHaveProperty('anonymised_by', manager.username);
      expect(response.body).toHaveProperty('reason');
      expect(response.body).toHaveProperty('fields_redacted');
      expect(response.body.fields_redacted).toContain('reporter_name');
      expect(response.body.fields_redacted).toContain('reporter_phone');
      expect(response.body.fields_redacted).toContain('reporter_email');
      expect(response.body.fields_redacted).toContain('insured_government_id');
      expect(response.body.fields_redacted).toContain('bank_account_for_payout');
      expect(response.body.fields_redacted).toContain('injury_details');
    });

    it('should reject anonymisation with reason < 50 characters', async () => {
      const token = jwtService.sign({
        sub: manager.id,
        username: manager.username,
        role: manager.role,
      });

      await request(app.getHttpServer())
        .post(`/claims/${testClaim.id}/personal-data-anonymise`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          reason: 'Short reason',
        })
        .expect(400);
    });

    it('should deny adjuster access to anonymise', async () => {
      const token = jwtService.sign({
        sub: adjuster.id,
        username: adjuster.username,
        role: adjuster.role,
      });

      await request(app.getHttpServer())
        .post(`/claims/${testClaim.id}/personal-data-anonymise`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          reason: 'Data subject requested deletion per APPI Article 17 compliance requirements',
        })
        .expect(403);
    });

    it('should deny agent access to anonymise', async () => {
      const token = jwtService.sign({
        sub: agent.id,
        username: agent.username,
        role: agent.role,
      });

      await request(app.getHttpServer())
        .post(`/claims/${testClaim.id}/personal-data-anonymise`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          reason: 'Data subject requested deletion per APPI Article 17 compliance requirements',
        })
        .expect(403);
    });

    it('should return 404 for non-existent claim', async () => {
      const token = jwtService.sign({
        sub: manager.id,
        username: manager.username,
        role: manager.role,
      });

      await request(app.getHttpServer())
        .post('/claims/nonexistent-claim-id/personal-data-anonymise')
        .set('Authorization', `Bearer ${token}`)
        .send({
          reason: 'Data subject requested deletion per APPI Article 17 compliance requirements',
        })
        .expect(400);
    });

    it('should redact reporter_name after anonymisation', async () => {
      const token = jwtService.sign({
        sub: manager.id,
        username: manager.username,
        role: manager.role,
      });

      await request(app.getHttpServer())
        .post(`/claims/${testClaim.id}/personal-data-anonymise`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          reason: 'Data subject requested deletion per APPI Article 17 compliance requirements',
        })
        .expect(200);

      // Verify the claim was updated
      const updatedClaim = await prisma.claim.findUnique({
        where: { id: testClaim.id },
      });

      expect(updatedClaim?.reporter_name).toBe('[REDACTED]');
      expect(updatedClaim?.reporter_phone_ct).toBeNull();
      expect(updatedClaim?.reporter_email_ct).toBeNull();
      expect(updatedClaim?.insured_government_id_ct).toBeNull();
      expect(updatedClaim?.bank_account_for_payout_ct).toBeNull();
      expect(updatedClaim?.injury_details_ct).toBeNull();
    });

    it('should emit audit event for anonymisation', async () => {
      const token = jwtService.sign({
        sub: manager.id,
        username: manager.username,
        role: manager.role,
      });

      await request(app.getHttpServer())
        .post(`/claims/${testClaim.id}/personal-data-anonymise`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          reason: 'Data subject requested deletion per APPI Article 17 compliance requirements',
        })
        .expect(200);

      // Verify audit event was created
      const auditEvents = await prisma.auditEvent.findMany({
        where: {
          claim_id: testClaim.id,
          action: 'claim.anonymised',
        },
      });

      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0]).toHaveProperty('actor_id', manager.id);
      expect(auditEvents[0]).toHaveProperty('actor_role', UserRole.manager);
    });

    it('should redact witness phone numbers after anonymisation', async () => {
      // Add a witness statement with phone
      await prisma.witnessStatement.create({
        data: {
          claim_id: testClaim.id,
          witness_name: 'Test Witness',
          witness_phone_ct: Buffer.from('encrypted-phone'),
          statement_body: 'I witnessed the incident',
          inkan_seal_hash: 'seal-hash-001',
          recorded_by_id: adjuster.id,
        },
      });

      const token = jwtService.sign({
        sub: manager.id,
        username: manager.username,
        role: manager.role,
      });

      await request(app.getHttpServer())
        .post(`/claims/${testClaim.id}/personal-data-anonymise`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          reason: 'Data subject requested deletion per APPI Article 17 compliance requirements',
        })
        .expect(200);

      // Verify witness phone was redacted
      const witnesses = await prisma.witnessStatement.findMany({
        where: { claim_id: testClaim.id },
      });

      expect(witnesses).toHaveLength(1);
      expect(witnesses[0].witness_phone_ct).toBeNull();
    });
  });

  describe('APPI compliance integration', () => {
    it('should preserve audit trail after anonymisation', async () => {
      // Create an audit event before anonymisation
      await prisma.auditEvent.create({
        data: {
          actor_id: adjuster.id,
          actor_role: UserRole.adjuster,
          action: 'claim.note.added',
          claim_id: testClaim.id,
          payload_hash: 'test-hash-001',
          request_id: 'req-001',
          correlation_id: 'corr-001',
        },
      });

      const token = jwtService.sign({
        sub: manager.id,
        username: manager.username,
        role: manager.role,
      });

      // Anonymise the claim
      await request(app.getHttpServer())
        .post(`/claims/${testClaim.id}/personal-data-anonymise`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          reason: 'Data subject requested deletion per APPI Article 17 compliance requirements',
        })
        .expect(200);

      // Verify audit trail is preserved
      const auditEvents = await prisma.auditEvent.findMany({
        where: { claim_id: testClaim.id },
      });

      expect(auditEvents.length).toBeGreaterThanOrEqual(2);
      const noteEvent = auditEvents.find((ae) => ae.action === 'claim.note.added');
      expect(noteEvent).toBeDefined();
    });

    it('should make anonymised data unavailable in subsequent exports', async () => {
      const token = jwtService.sign({
        sub: manager.id,
        username: manager.username,
        role: manager.role,
      });

      // Anonymise the claim
      await request(app.getHttpServer())
        .post(`/claims/${testClaim.id}/personal-data-anonymise`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          reason: 'Data subject requested deletion per APPI Article 17 compliance requirements',
        })
        .expect(200);

      // Export data as auditor
      const auditorToken = jwtService.sign({
        sub: auditor.id,
        username: auditor.username,
        role: auditor.role,
      });

      const response = await request(app.getHttpServer())
        .get(`/claims/${testClaim.id}/data-subject-export`)
        .set('Authorization', `Bearer ${auditorToken}`)
        .expect(200);

      expect(response.body.claim.reporter.name).toBe('[REDACTED]');
      expect(response.body.claim.reporter.phone).toBeNull();
      expect(response.body.claim.reporter.email).toBeNull();
      expect(response.body.claim.insured_government_id).toBeNull();
      expect(response.body.claim.bank_account_for_payout).toBeNull();
      expect(response.body.claim.injury_details).toBeNull();
    });
  });
});