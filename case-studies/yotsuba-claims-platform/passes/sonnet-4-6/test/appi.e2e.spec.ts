// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// test/appi.e2e.spec.ts
//
// End-to-end tests for the APPI compliance module.
//
// Design reference: design.md §3 Module structure (appi/)
// Brief reference:  brief.md §1 APPI compliance hooks
//                   GET /claims/:id/data-subject-export (APPI Article 28)
//                   DELETE /claims/:id/personal-data-anonymise (Article 36)
//
// Test coverage:
//   1. data-subject-export — happy path (auditor role)
//   2. data-subject-export — manager role allowed
//   3. data-subject-export — adjuster role denied (403)
//   4. data-subject-export — non-existent claim (404)
//   5. data-subject-export — export covers all related claims
//   6. data-subject-export — emits an AuditEvent
//   7. anonymise — happy path (manager role)
//   8. anonymise — idempotent (calling twice is safe)
//   9. anonymise — adjuster role denied (403)
//  10. anonymise — non-existent claim (404)
//  11. anonymise — audit trail preserved after anonymisation
//  12. anonymise — PII fields cleared; non-PII fields intact
//  13. anonymise — with full DTO fields accepted
//  14. anonymise — reason too short rejected (400)
// =============================================================================

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { UserRole, ClaimStatus, IntakeChannel, IncidentType, ClaimSeverity } from '@prisma/client';
import * as bcrypt from 'bcrypt';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TokenCache {
  auditor?: string;
  manager?: string;
  adjuster?: string;
  agent?: string;
}

const tokens: TokenCache = {};

async function login(
  app: INestApplication,
  username: string,
  password: string,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ username, password })
    .expect(200);
  return res.body.access_token as string;
}

/**
 * Create a minimal valid claim record directly via Prisma for test isolation.
 * Avoids dependency on the FNOL intake endpoint being fully wired.
 */
async function seedClaim(
  prisma: PrismaService,
  overrides: Partial<{
    policy_number: string;
    reporter_name: string;
    reporter_phone_ct: Buffer;
    reporter_email_ct: Buffer;
    insured_government_id_ct: Buffer;
    bank_account_for_payout_ct: Buffer;
    injury_details_ct: Buffer;
    assigned_adjuster_id: string;
  }> = {},
): Promise<string> {
  const claim = await prisma.claim.create({
    data: {
      policy_number: overrides.policy_number ?? 'POL-TEST-001',
      loss_date: new Date('2024-03-15T10:00:00Z'),
      loss_location_prefecture: '東京都',
      loss_location_postal_code: '100-0001',
      loss_location_detail: '千代田区1-1-1',
      reported_by_channel: IntakeChannel.agent,
      reporter_name: overrides.reporter_name ?? 'テスト 太郎',
      reporter_relation_to_insured: '本人',
      incident_type: IncidentType.auto_collision,
      initial_description: 'テスト用の自動車衝突事故です。',
      injury_reported: false,
      third_party_involved: false,
      severity_initial: ClaimSeverity.simple,
      status: ClaimStatus.intake,
      appi_consent_version: 'v1.0',
      appi_consent_at: new Date('2024-03-15T09:55:00Z'),
      reporter_phone_ct: overrides.reporter_phone_ct ?? null,
      reporter_email_ct: overrides.reporter_email_ct ?? null,
      insured_government_id_ct: overrides.insured_government_id_ct ?? null,
      bank_account_for_payout_ct: overrides.bank_account_for_payout_ct ?? null,
      injury_details_ct: overrides.injury_details_ct ?? null,
      assigned_adjuster_id: overrides.assigned_adjuster_id ?? null,
    },
  });
  return claim.id;
}

/**
 * Create a test user directly via Prisma.
 */
async function seedUser(
  prisma: PrismaService,
  opts: {
    username: string;
    role: UserRole;
    is_claims_director?: boolean;
  },
): Promise<string> {
  const password_hash = await bcrypt.hash('Test1234!', 10);
  const user = await prisma.user.create({
    data: {
      username: opts.username,
      password_hash,
      role: opts.role,
      display_name: opts.username,
      email: `${opts.username}@yotsuba-test.local`,
      is_claims_director: opts.is_claims_director ?? false,
    },
  });
  return user.id;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('APPI compliance (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  // User IDs
  let auditorId: string;
  let managerId: string;
  let adjusterId: string;
  let agentId: string;

  // Claim IDs
  let primaryClaimId: string;
  let relatedClaimId: string;
  let unrelatedClaimId: string;

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: false,
        transform: true,
      }),
    );
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);

    // Seed test users with unique usernames to avoid collisions with seed data
    const ts = Date.now();
    auditorId = await seedUser(prisma, {
      username: `appi_auditor_${ts}`,
      role: UserRole.auditor,
    });
    managerId = await seedUser(prisma, {
      username: `appi_manager_${ts}`,
      role: UserRole.manager,
    });
    adjusterId = await seedUser(prisma, {
      username: `appi_adjuster_${ts}`,
      role: UserRole.adjuster,
    });
    agentId = await seedUser(prisma, {
      username: `appi_agent_${ts}`,
      role: UserRole.agent,
    });

    // Acquire JWTs
    tokens.auditor = await login(app, `appi_auditor_${ts}`, 'Test1234!');
    tokens.manager = await login(app, `appi_manager_${ts}`, 'Test1234!');
    tokens.adjuster = await login(app, `appi_adjuster_${ts}`, 'Test1234!');
    tokens.agent = await login(app, `appi_agent_${ts}`, 'Test1234!');

    // Seed claims
    // primaryClaimId and relatedClaimId share reporter_name and policy_number
    primaryClaimId = await seedClaim(prisma, {
      policy_number: `POL-APPI-${ts}`,
      reporter_name: `テスト 太郎 ${ts}`,
      assigned_adjuster_id: adjusterId,
    });
    relatedClaimId = await seedClaim(prisma, {
      policy_number: `POL-APPI-${ts}`, // same policy — should appear in export
      reporter_name: `テスト 太郎 ${ts}`, // same reporter — should appear in export
      assigned_adjuster_id: adjusterId,
    });
    unrelatedClaimId = await seedClaim(prisma, {
      policy_number: `POL-OTHER-${ts}`,
      reporter_name: `別 花子 ${ts}`,
    });
  });

  afterAll(async () => {
    // Clean up test data in dependency order
    await prisma.auditEvent.deleteMany({
      where: {
        claim_id: { in: [primaryClaimId, relatedClaimId, unrelatedClaimId] },
      },
    });
    await prisma.witnessStatement.deleteMany({
      where: {
        claim_id: { in: [primaryClaimId, relatedClaimId, unrelatedClaimId] },
      },
    });
    await prisma.claimNote.deleteMany({
      where: {
        claim_id: { in: [primaryClaimId, relatedClaimId, unrelatedClaimId] },
      },
    });
    await prisma.claim.deleteMany({
      where: {
        id: { in: [primaryClaimId, relatedClaimId, unrelatedClaimId] },
      },
    });
    await prisma.user.deleteMany({
      where: {
        id: { in: [auditorId, managerId, adjusterId, agentId] },
      },
    });
    await app.close();
  });

  // ---------------------------------------------------------------------------
  // data-subject-export
  // ---------------------------------------------------------------------------

  describe('GET /claims/:id/data-subject-export', () => {
    it('TC-APPI-01: auditor can export data-subject information (happy path)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/claims/${primaryClaimId}/data-subject-export`)
        .set('Authorization', `Bearer ${tokens.auditor}`)
        .expect(200);

      expect(res.body).toMatchObject({
        identified_by: { claim_id: primaryClaimId },
        total_claims_found: expect.any(Number),
        claims: expect.any(Array),
        export_generated_at: expect.any(String),
      });

      expect(res.body.total_claims_found).toBeGreaterThanOrEqual(1);
      expect(res.body.claims.length).toBeGreaterThanOrEqual(1);
    });

    it('TC-APPI-02: manager role is permitted to access data-subject export', async () => {
      const res = await request(app.getHttpServer())
        .get(`/claims/${primaryClaimId}/data-subject-export`)
        .set('Authorization', `Bearer ${tokens.manager}`)
        .expect(200);

      expect(res.body.identified_by.claim_id).toBe(primaryClaimId);
    });

    it('TC-APPI-03: adjuster role is denied access (403)', async () => {
      await request(app.getHttpServer())
        .get(`/claims/${primaryClaimId}/data-subject-export`)
        .set('Authorization', `Bearer ${tokens.adjuster}`)
        .expect(403);
    });

    it('TC-APPI-04: agent role is denied access (403)', async () => {
      await request(app.getHttpServer())
        .get(`/claims/${primaryClaimId}/data-subject-export`)
        .set('Authorization', `Bearer ${tokens.agent}`)
        .expect(403);
    });

    it('TC-APPI-05: unauthenticated request is denied (401)', async () => {
      await request(app.getHttpServer())
        .get(`/claims/${primaryClaimId}/data-subject-export`)
        .expect(401);
    });

    it('TC-APPI-06: returns 404 for non-existent claim', async () => {
      const nonExistentId = 'clm_nonexistent_00000000000000';
      await request(app.getHttpServer())
        .get(`/claims/${nonExistentId}/data-subject-export`)
        .set('Authorization', `Bearer ${tokens.auditor}`)
        .expect(404);
    });

    it('TC-APPI-07: export covers all claims sharing reporter_name and policy_number', async () => {
      const res = await request(app.getHttpServer())
        .get(`/claims/${primaryClaimId}/data-subject-export`)
        .set('Authorization', `Bearer ${tokens.auditor}`)
        .expect(200);

      const claimIds: string[] = res.body.claims.map((c: { claim_id: string }) => c.claim_id);

      // Both primaryClaimId and relatedClaimId share reporter_name + policy_number
      expect(claimIds).toContain(primaryClaimId);
      expect(claimIds).toContain(relatedClaimId);

      // Unrelated claim should NOT appear
      expect(claimIds).not.toContain(unrelatedClaimId);

      // total_claims_found must match the claims array length
      expect(res.body.total_claims_found).toBe(res.body.claims.length);
    });

    it('TC-APPI-08: each claim record in the export contains required APPI fields', async () => {
      const res = await request(app.getHttpServer())
        .get(`/claims/${primaryClaimId}/data-subject-export`)
        .set('Authorization', `Bearer ${tokens.auditor}`)
        .expect(200);

      const claimRecord = res.body.claims.find(
        (c: { claim_id: string }) => c.claim_id === primaryClaimId,
      );

      expect(claimRecord).toBeDefined();
      expect(claimRecord).toMatchObject({
        claim_id: primaryClaimId,
        policy_number: expect.any(String),
        loss_date: expect.any(String),
        loss_location_prefecture: expect.any(String),
        loss_location_postal_code: expect.any(String),
        loss_location_detail: expect.any(String),
        reported_by_channel: expect.any(String),
        reporter_name: expect.any(String),
        reporter_relation_to_insured: expect.any(String),
        incident_type: expect.any(String),
        initial_description: expect.any(String),
        appi_consent_version: expect.any(String),
        appi_consent_at: expect.any(String),
        notes: expect.any(Array),
        witness_statements: expect.any(Array),
        created_at: expect.any(String),
        updated_at: expect.any(String),
      });
    });

    it('TC-APPI-09: export emits an AuditEvent for the operation', async () => {
      // Capture audit count before
      const countBefore = await prisma.auditEvent.count({
        where: {
          claim_id: primaryClaimId,
          action: 'appi.data_subject_export',
        },
      });

      await request(app.getHttpServer())
        .get(`/claims/${primaryClaimId}/data-subject-export`)
        .set('Authorization', `Bearer ${tokens.auditor}`)
        .expect(200);

      const countAfter = await prisma.auditEvent.count({
        where: {
          claim_id: primaryClaimId,
          action: 'appi.data_subject_export',
        },
      });

      expect(countAfter).toBe(countBefore + 1);
    });

    it('TC-APPI-10: export_generated_at is a valid ISO 8601 timestamp', async () => {
      const res = await request(app.getHttpServer())
        .get(`/claims/${primaryClaimId}/data-subject-export`)
        .set('Authorization', `Bearer ${tokens.auditor}`)
        .expect(200);

      const generatedAt = res.body.export_generated_at;
      expect(typeof generatedAt).toBe('string');
      expect(new Date(generatedAt).toISOString()).toBe(generatedAt);
    });
  });

  // ---------------------------------------------------------------------------
  // PII anonymisation
  // ---------------------------------------------------------------------------

  describe('DELETE /claims/:id/personal-data-anonymise', () => {
    // Use a dedicated claim per anonymisation test to ensure isolation
    let anonClaimId: string;

    beforeEach(async () => {
      // Fresh claim for each anonymisation test
      const ts = Date.now();
      anonClaimId = await seedClaim(prisma, {
        policy_number: `POL-ANON-${ts}`,
        reporter_name: `匿名化テスト 次郎 ${ts}`,
        assigned_adjuster_id: adjusterId,
      });
    });

    afterEach(async () => {
      // Clean up
      await prisma.auditEvent.deleteMany({ where: { claim_id: anonClaimId } });
      await prisma.witnessStatement.deleteMany({ where: { claim_id: anonClaimId } });
      await prisma.claimNote.deleteMany({ where: { claim_id: anonClaimId } });
      await prisma.claim.deleteMany({ where: { id: anonClaimId } });
    });

    it('TC-APPI-11: manager can anonymise a claim (happy path)', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/claims/${anonClaimId}/personal-data-anonymise`)
        .set('Authorization', `Bearer ${tokens.manager}`)
        .send({})
        .expect(200);

      expect(res.body).toMatchObject({
        claim_id: anonClaimId,
        anonymised_at: expect.any(String),
        fields_cleared: expect.any(Array),
        audit_event_id: expect.any(String),
      });

      expect(res.body.fields_cleared.length).toBeGreaterThan(0);
    });

    it('TC-APPI-12: adjuster role is denied anonymisation (403)', async () => {
      await request(app.getHttpServer())
        .delete(`/claims/${anonClaimId}/personal-data-anonymise`)
        .set('Authorization', `Bearer ${tokens.adjuster}`)
        .send({})
        .expect(403);
    });

    it('TC-APPI-13: auditor role is denied anonymisation (403)', async () => {
      await request(app.getHttpServer())
        .delete(`/claims/${anonClaimId}/personal-data-anonymise`)
        .set('Authorization', `Bearer ${tokens.auditor}`)
        .send({})
        .expect(403);
    });

    it('TC-APPI-14: agent role is denied anonymisation (403)', async () => {
      await request(app.getHttpServer())
        .delete(`/claims/${anonClaimId}/personal-data-anonymise`)
        .set('Authorization', `Bearer ${tokens.agent}`)
        .send({})
        .expect(403);
    });

    it('TC-APPI-15: unauthenticated request is denied (401)', async () => {
      await request(app.getHttpServer())
        .delete(`/claims/${anonClaimId}/personal-data-anonymise`)
        .send({})
        .expect(401);
    });

    it('TC-APPI-16: returns 404 for non-existent claim', async () => {
      const nonExistentId = 'clm_nonexistent_99999999999999';
      await request(app.getHttpServer())
        .delete(`/claims/${nonExistentId}/personal-data-anonymise`)
        .set('Authorization', `Bearer ${tokens.manager}`)
        .send({})
        .expect(404);
    });

    it('TC-APPI-17: standard PII fields are overwritten with ANONYMISED marker after anonymisation', async () => {
      await request(app.getHttpServer())
        .delete(`/claims/${anonClaimId}/personal-data-anonymise`)
        .set('Authorization', `Bearer ${tokens.manager}`)
        .send({ reason: 'Data-subject erasure request ref DS-TEST-001.' })
        .expect(200);

      const claim = await prisma.claim.findUniqueOrThrow({
        where: { id: anonClaimId },
      });

      expect(claim.reporter_name).toBe('[ANONYMISED]');
      expect(claim.reporter_relation_to_insured).toBe('[ANONYMISED]');
      expect(claim.initial_description).toBe('[ANONYMISED]');
      expect(claim.loss_location_detail).toBe('[ANONYMISED]');
    });

    it('TC-APPI-18: special-care encrypted blobs are nulled after anonymisation', async () => {
      await request(app.getHttpServer())
        .delete(`/claims/${anonClaimId}/personal-data-anonymise`)
        .set('Authorization', `Bearer ${tokens.manager}`)
        .send({ reason: 'Data-subject erasure request ref DS-TEST-002.' })
        .expect(200);

      const claim = await prisma.claim.findUniqueOrThrow({
        where: { id: anonClaimId },
      });

      expect(claim.reporter_phone_ct).toBeNull();
      expect(claim.reporter_email_ct).toBeNull();
      expect(claim.insured_government_id_ct).toBeNull();
      expect(claim.bank_account_for_payout_ct).toBeNull();
      expect(claim.injury_details_ct).toBeNull();
    });

    it('TC-APPI-19: non-PII fields are preserved after anonymisation', async () => {
      // Capture original non-PII data
      const originalClaim = await prisma.claim.findUniqueOrThrow({
        where: { id: anonClaimId },
      });

      await request(app.getHttpServer())
        .delete(`/claims/${anonClaimId}/personal-data-anonymise`)
        .set('Authorization', `Bearer ${tokens.manager}`)
        .send({ reason: 'Data-subject erasure request ref DS-TEST-003.' })
        .expect(200);

      const anonymisedClaim = await prisma.claim.findUniqueOrThrow({
        where: { id: anonClaimId },
      });

      // Non-PII structural fields must be unchanged
      expect(anonymisedClaim.policy_number).toBe(originalClaim.policy_number);
      expect(anonymisedClaim.loss_date.toISOString()).toBe(
        originalClaim.loss_date.toISOString(),
      );
      expect(anonymisedClaim.loss_location_prefecture).toBe(
        originalClaim.loss_location_prefecture,
      );
      expect(anonymisedClaim.loss_location_postal_code).toBe(
        originalClaim.loss_location_postal_code,
      );
      expect(anonymisedClaim.incident_type).toBe(originalClaim.incident_type);
      expect(anonymisedClaim.severity_initial).toBe(originalClaim.severity_initial);
      expect(anonymisedClaim.status).toBe(originalClaim.status);
      expect(anonymisedClaim.appi_consent_version).toBe(originalClaim.appi_consent_version);
    });

    it('TC-APPI-20: audit trail is preserved and still queryable after anonymisation', async () => {
      // Emit an audit event on the claim before anonymisation
      await prisma.auditEvent.create({
        data: {
          actor_id: auditorId,
          actor_role: UserRole.auditor,
          action: 'claim.viewed',
          claim_id: anonClaimId,
          target_id: anonClaimId,
          payload_hash: 'sha256-test-hash-preserved',
          request_id: 'req-test-000',
          correlation_id: 'corr-test-000',
        },
      });

      await request(app.getHttpServer())
        .delete(`/claims/${anonClaimId}/personal-data-anonymise`)
        .set('Authorization', `Bearer ${tokens.manager}`)
        .send({ reason: 'Data-subject erasure request ref DS-TEST-004.' })
        .expect(200);

      // Audit events must still exist — immutability is unconditional (ADR-002)
      const auditCount = await prisma.auditEvent.count({
        where: { claim_id: anonClaimId },
      });

      // At least the pre-existing audit event + the anonymisation event
      expect(auditCount).toBeGreaterThanOrEqual(2);

      // The original audit event must be unchanged
      const originalAuditEvent = await prisma.auditEvent.findFirst({
        where: {
          claim_id: anonClaimId,
          action: 'claim.viewed',
        },
      });
      expect(originalAuditEvent).not.toBeNull();
      expect(originalAuditEvent!.payload_hash).toBe('sha256-test-hash-preserved');
    });

    it('TC-APPI-21: anonymisation emits an AuditEvent with action appi.pii_anonymised', async () => {
      const countBefore = await prisma.auditEvent.count({
        where: {
          claim_id: anonClaimId,
          action: 'appi.pii_anonymised',
        },
      });

      await request(app.getHttpServer())
        .delete(`/claims/${anonClaimId}/personal-data-anonymise`)
        .set('Authorization', `Bearer ${tokens.manager}`)
        .send({ reason: 'Data-subject erasure request ref DS-TEST-005.' })
        .expect(200);

      const countAfter = await prisma.auditEvent.count({
        where: {
          claim_id: anonClaimId,
          action: 'appi.pii_anonymised',
        },
      });

      expect(countAfter).toBe(countBefore + 1);
    });

    it('TC-APPI-22: anonymisation is idempotent — second call succeeds and emits another audit event', async () => {
      const body = { reason: 'Data-subject erasure request ref DS-TEST-006.' };

      // First call
      await request(app.getHttpServer())
        .delete(`/claims/${anonClaimId}/personal-data-anonymise`)
        .set('Authorization', `Bearer ${tokens.manager}`)
        .send(body)
        .expect(200);

      // Second call should also succeed (idempotent)
      const res = await request(app.getHttpServer())
        .delete(`/claims/${anonClaimId}/personal-data-anonymise`)
        .set('Authorization', `Bearer ${tokens.manager}`)
        .send(body)
        .expect(200);

      expect(res.body.claim_id).toBe(anonClaimId);

      // Both calls must have emitted audit events
      const auditCount = await prisma.auditEvent.count({
        where: {
          claim_id: anonClaimId,
          action: 'appi.pii_anonymised',
        },
      });
      expect(auditCount).toBeGreaterThanOrEqual(2);
    });

    it('TC-APPI-23: accepts full DTO body with reason, requestor_identity, and contact email', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/claims/${anonClaimId}/personal-data-anonymise`)
        .set('Authorization', `Bearer ${tokens.manager}`)
        .send({
          reason: 'Data-subject erasure request ref DS-TEST-007 received via compliance portal.',
          requestor_identity: 'Compliance Officer — Tanaka Keiko (emp-00441)',
          data_subject_contact_email: 'tanaka.ichiro@example.com',
        })
        .expect(200);

      expect(res.body.claim_id).toBe(anonClaimId);
      expect(res.body.audit_event_id).toBeDefined();
    });

    it('TC-APPI-24: rejects reason that is too short (validation failure)', async () => {
      await request(app.getHttpServer())
        .delete(`/claims/${anonClaimId}/personal-data-anonymise`)
        .set('Authorization', `Bearer ${tokens.manager}`)
        .send({
          reason: 'short', // less than 10 chars
        })
        .expect(400);
    });

    it('TC-APPI-25: rejects invalid data_subject_contact_email (validation failure)', async () => {
      await request(app.getHttpServer())
        .delete(`/claims/${anonClaimId}/personal-data-anonymise`)
        .set('Authorization', `Bearer ${tokens.manager}`)
        .send({
          reason: 'Data-subject erasure request ref DS-TEST-008.',
          data_subject_contact_email: 'not-a-valid-email',
        })
        .expect(400);
    });

    it('TC-APPI-26: anonymisation also clears witness statement PII when present', async () => {
      // Add a witness statement directly
      await prisma.witnessStatement.create({
        data: {
          claim_id: anonClaimId,
          witness_name: 'テスト 証人',
          statement_body: '目撃した内容です。',
          inkan_seal_hash: 'sha256-test-inkan-hash-001',
          recorded_by_id: adjusterId,
          witness_phone_ct: null,
        },
      });

      await request(app.getHttpServer())
        .delete(`/claims/${anonClaimId}/personal-data-anonymise`)
        .set('Authorization', `Bearer ${tokens.manager}`)
        .send({ reason: 'Data-subject erasure request ref DS-TEST-009.' })
        .expect(200);

      const witnesses = await prisma.witnessStatement.findMany({
        where: { claim_id: anonClaimId },
      });

      for (const ws of witnesses) {
        expect(ws.witness_name).toBe('[ANONYMISED]');
        expect(ws.statement_body).toBe('[ANONYMISED]');
        expect(ws.witness_phone_ct).toBeNull();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-concern: after anonymisation, data-subject export reflects redaction
  // ---------------------------------------------------------------------------

  describe('Cross-concern: export after anonymisation', () => {
    let crossClaimId: string;

    beforeAll(async () => {
      const ts = Date.now() + 1;
      crossClaimId = await seedClaim(prisma, {
        policy_number: `POL-CROSS-${ts}`,
        reporter_name: `クロスチェック 三郎 ${ts}`,
      });
    });

    afterAll(async () => {
      await prisma.auditEvent.deleteMany({ where: { claim_id: crossClaimId } });
      await prisma.witnessStatement.deleteMany({ where: { claim_id: crossClaimId } });
      await prisma.claimNote.deleteMany({ where: { claim_id: crossClaimId } });
      await prisma.claim.deleteMany({ where: { id: crossClaimId } });
    });

    it('TC-APPI-27: data-subject export after anonymisation shows ANONYMISED markers for PII fields', async () => {
      // Anonymise
      await request(app.getHttpServer())
        .delete(`/claims/${crossClaimId}/personal-data-anonymise`)
        .set('Authorization', `Bearer ${tokens.manager}`)
        .send({ reason: 'Cross-concern test erasure request DS-TEST-010.' })
        .expect(200);

      // Export — should reflect the anonymised state
      const res = await request(app.getHttpServer())
        .get(`/claims/${crossClaimId}/data-subject-export`)
        .set('Authorization', `Bearer ${tokens.auditor}`)
        .expect(200);

      const claimRecord = res.body.claims.find(
        (c: { claim_id: string }) => c.claim_id === crossClaimId,
      );

      expect(claimRecord).toBeDefined();
      expect(claimRecord.reporter_name).toBe('[ANONYMISED]');
    });
  });
});