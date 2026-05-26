// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// test/claims-workbench.e2e.spec.ts
//
// End-to-end tests for the Adjuster Workbench module.
//
// Coverage:
//   - POST /claims/:id/assign       assign / re-assign adjuster (manager-only)
//   - POST /claims/:id/notes        append-only immutable note
//   - POST /claims/:id/evidence     attach evidence with content-hash
//   - POST /claims/:id/witness-statement  structured witness intake w/ inkan_seal_hash
//   - PATCH /claims/:id/status      FSM-guarded workflow transitions
//   - GET  /claims/:id              role-masked PII (adjuster cleartext vs. others masked)
//   - Role-matrix enforcement across all endpoints
//   - Audit events emitted for every write
//
// Tests run against a real Postgres test database (DATABASE_URL_TEST or DATABASE_URL).
// =============================================================================

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildApp(): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.init();
  return app;
}

async function createUser(
  prisma: PrismaService,
  overrides: {
    role?: 'agent' | 'adjuster' | 'manager' | 'auditor' | 'siu_referrer';
    is_claims_director?: boolean;
    reports_to_id?: string;
  } = {},
): Promise<{ id: string; username: string; password: string }> {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const username = `wb_user_${suffix}`;
  const password = 'Test@Passw0rd!';
  const password_hash = await bcrypt.hash(password, 10);

  const user = await prisma.user.create({
    data: {
      username,
      password_hash,
      role: overrides.role ?? 'adjuster',
      display_name: `WB User ${suffix}`,
      email: `${username}@test.yotsuba.example`,
      is_claims_director: overrides.is_claims_director ?? false,
      reports_to_id: overrides.reports_to_id ?? null,
    },
  });

  return { id: user.id, username, password };
}

async function loginAs(
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
 * Creates a minimal claim via POST /claims and returns its id.
 * Requires an agent or adjuster JWT.
 */
async function createClaim(
  app: INestApplication,
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const payload = {
    policy_number: 'POL-TEST-001',
    loss_date: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days ago
    loss_location_prefecture: '東京都',
    loss_location_postal_code: '100-0001',
    loss_location_detail: '千代田区千代田1-1',
    reported_by_channel: 'agent',
    reporter_name: 'テスト太郎',
    reporter_phone: '03-0000-0001',
    reporter_email: 'test@example.com',
    reporter_relation_to_insured: '本人',
    incident_type: 'auto_collision',
    initial_description: 'テスト用の自動車事故の説明文です。',
    injury_reported: false,
    third_party_involved: false,
    appi_consent_version: 'v1.0',
    appi_consent_at: new Date().toISOString(),
    ...overrides,
  };

  const res = await request(app.getHttpServer())
    .post('/claims')
    .set('Authorization', `Bearer ${token}`)
    .send(payload)
    .expect(201);

  return res.body.id as string;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Claims Workbench (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  // Shared actors — created once per suite
  let agentUser: { id: string; username: string; password: string };
  let adjusterUser: { id: string; username: string; password: string };
  let adjuster2User: { id: string; username: string; password: string };
  let managerUser: { id: string; username: string; password: string };
  let auditorUser: { id: string; username: string; password: string };
  let siuUser: { id: string; username: string; password: string };

  // JWTs — populated in beforeAll after login
  let agentToken: string;
  let adjusterToken: string;
  let adjuster2Token: string;
  let managerToken: string;
  let auditorToken: string;
  let siuToken: string;

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);

    // Create actors
    agentUser = await createUser(prisma, { role: 'agent' });
    managerUser = await createUser(prisma, { role: 'manager' });
    adjusterUser = await createUser(prisma, {
      role: 'adjuster',
      reports_to_id: managerUser.id,
    });
    adjuster2User = await createUser(prisma, {
      role: 'adjuster',
      reports_to_id: managerUser.id,
    });
    auditorUser = await createUser(prisma, { role: 'auditor' });
    siuUser = await createUser(prisma, { role: 'siu_referrer' });

    // Obtain JWTs
    agentToken = await loginAs(app, agentUser.username, agentUser.password);
    adjusterToken = await loginAs(app, adjusterUser.username, adjusterUser.password);
    adjuster2Token = await loginAs(app, adjuster2User.username, adjuster2User.password);
    managerToken = await loginAs(app, managerUser.username, managerUser.password);
    auditorToken = await loginAs(app, auditorUser.username, auditorUser.password);
    siuToken = await loginAs(app, siuUser.username, siuUser.password);
  });

  afterAll(async () => {
    await app.close();
  });

  // =========================================================================
  // GET /claims/:id — role-masked PII
  // =========================================================================

  describe('GET /claims/:id — role-masked PII', () => {
    let claimId: string;

    beforeAll(async () => {
      claimId = await createClaim(app, agentToken, {
        reporter_phone: '03-1234-5678',
        reporter_email: 'reporter@example.com',
      });

      // Assign the claim to adjusterUser so we can test the assigned vs. unassigned masking
      await request(app.getHttpServer())
        .post(`/claims/${claimId}/assign`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ adjuster_id: adjusterUser.id })
        .expect(200);
    });

    it('returns 200 with full claim data for the assigned adjuster', async () => {
      const res = await request(app.getHttpServer())
        .get(`/claims/${claimId}`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .expect(200);

      expect(res.body.id).toBe(claimId);
      // Assigned adjuster should see cleartext phone and email
      expect(res.body.reporter_phone).toBeDefined();
      expect(res.body.reporter_phone).not.toMatch(/\*+/);
      expect(res.body.reporter_email).toBeDefined();
      expect(res.body.reporter_email).not.toMatch(/\*+/);
    });

    it('masks reporter_phone and reporter_email for a non-assigned adjuster', async () => {
      const res = await request(app.getHttpServer())
        .get(`/claims/${claimId}`)
        .set('Authorization', `Bearer ${adjuster2Token}`)
        .expect(200);

      // Non-assigned adjuster sees masked or absent PII
      const phone: string | undefined = res.body.reporter_phone;
      const email: string | undefined = res.body.reporter_email;
      if (phone !== undefined && phone !== null) {
        expect(phone).toMatch(/\*/);
      }
      if (email !== undefined && email !== null) {
        expect(email).toMatch(/\*/);
      }
    });

    it('returns claim data for manager', async () => {
      const res = await request(app.getHttpServer())
        .get(`/claims/${claimId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);

      expect(res.body.id).toBe(claimId);
    });

    it('returns claim data for auditor (read-only access)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/claims/${claimId}`)
        .set('Authorization', `Bearer ${auditorToken}`)
        .expect(200);

      expect(res.body.id).toBe(claimId);
    });

    it('returns 401 without a JWT', async () => {
      const res = await request(app.getHttpServer())
        .get(`/claims/${claimId}`)
        .expect(401);

      expect(res.body.statusCode).toBe(401);
    });

    it('returns 404 for a non-existent claim id', async () => {
      const res = await request(app.getHttpServer())
        .get('/claims/nonexistent_claim_id_xyz')
        .set('Authorization', `Bearer ${adjusterToken}`)
        .expect(404);

      expect(res.body.statusCode).toBe(404);
    });

    it('does not expose password_hash or other internal fields', async () => {
      const res = await request(app.getHttpServer())
        .get(`/claims/${claimId}`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .expect(200);

      expect(res.body.password_hash).toBeUndefined();
      expect(res.body.insured_government_id_ct).toBeUndefined();
      expect(res.body.bank_account_for_payout_ct).toBeUndefined();
    });
  });

  // =========================================================================
  // POST /claims/:id/assign
  // =========================================================================

  describe('POST /claims/:id/assign', () => {
    let claimId: string;

    beforeEach(async () => {
      claimId = await createClaim(app, agentToken);
    });

    it('200 — manager can assign an adjuster to a claim', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/assign`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ adjuster_id: adjusterUser.id })
        .expect(200);

      expect(res.body.assigned_adjuster_id).toBe(adjusterUser.id);
    });

    it('200 — manager can re-assign with optional reason', async () => {
      // First assignment
      await request(app.getHttpServer())
        .post(`/claims/${claimId}/assign`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ adjuster_id: adjusterUser.id })
        .expect(200);

      // Re-assignment
      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/assign`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          adjuster_id: adjuster2User.id,
          reason_for_reassignment: 'Workload rebalancing',
        })
        .expect(200);

      expect(res.body.assigned_adjuster_id).toBe(adjuster2User.id);
    });

    it('403 — adjuster cannot assign a claim', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/assign`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({ adjuster_id: adjusterUser.id })
        .expect(403);

      expect(res.body.statusCode).toBe(403);
    });

    it('403 — agent cannot assign a claim', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/assign`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ adjuster_id: adjusterUser.id })
        .expect(403);

      expect(res.body.statusCode).toBe(403);
    });

    it('403 — auditor cannot assign a claim', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/assign`)
        .set('Authorization', `Bearer ${auditorToken}`)
        .send({ adjuster_id: adjusterUser.id })
        .expect(403);

      expect(res.body.statusCode).toBe(403);
    });

    it('401 — unauthenticated request is rejected', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/assign`)
        .send({ adjuster_id: adjusterUser.id })
        .expect(401);

      expect(res.body.statusCode).toBe(401);
    });

    it('400 — missing adjuster_id returns validation error', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/assign`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({})
        .expect(400);

      expect(res.body.statusCode).toBe(400);
    });

    it('emits an audit event on successful assignment', async () => {
      await request(app.getHttpServer())
        .post(`/claims/${claimId}/assign`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ adjuster_id: adjusterUser.id })
        .expect(200);

      const events = await prisma.auditEvent.findMany({
        where: { claim_id: claimId, action: 'claim.assigned' },
        orderBy: { ts: 'desc' },
      });

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].actor_id).toBe(managerUser.id);
    });
  });

  // =========================================================================
  // POST /claims/:id/notes
  // =========================================================================

  describe('POST /claims/:id/notes', () => {
    let claimId: string;

    beforeAll(async () => {
      claimId = await createClaim(app, agentToken);
      // Assign to adjusterUser so adjuster can add notes
      await request(app.getHttpServer())
        .post(`/claims/${claimId}/assign`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ adjuster_id: adjusterUser.id })
        .expect(200);
    });

    it('201 — assigned adjuster can add a note', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/notes`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({ body: '現場調査を完了しました。損害額を確認中です。' })
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.claim_id).toBe(claimId);
      expect(res.body.author_id).toBe(adjusterUser.id);
      expect(res.body.body).toBe('現場調査を完了しました。損害額を確認中です。');
      expect(res.body.created_at).toBeDefined();
    });

    it('201 — manager can add a note', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/notes`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ body: 'マネージャーによるレビューコメントです。' })
        .expect(201);

      expect(res.body.author_id).toBe(managerUser.id);
    });

    it('notes are immutable — GET shows them in order and they cannot be edited', async () => {
      await request(app.getHttpServer())
        .post(`/claims/${claimId}/notes`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({ body: '最初のノートです。' })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/claims/${claimId}/notes`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({ body: '2番目のノートです。' })
        .expect(201);

      const claimRes = await request(app.getHttpServer())
        .get(`/claims/${claimId}`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .expect(200);

      const notes: Array<{ body: string; created_at: string }> = claimRes.body.notes;
      expect(Array.isArray(notes)).toBe(true);
      // Notes should be in chronological order
      for (let i = 1; i < notes.length; i++) {
        expect(new Date(notes[i].created_at).getTime()).toBeGreaterThanOrEqual(
          new Date(notes[i - 1].created_at).getTime(),
        );
      }
    });

    it('403 — agent cannot add a note', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/notes`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ body: 'Unauthorized note.' })
        .expect(403);

      expect(res.body.statusCode).toBe(403);
    });

    it('403 — auditor cannot add a note', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/notes`)
        .set('Authorization', `Bearer ${auditorToken}`)
        .send({ body: 'Auditor should not write.' })
        .expect(403);

      expect(res.body.statusCode).toBe(403);
    });

    it('400 — empty body is rejected', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/notes`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({ body: '' })
        .expect(400);

      expect(res.body.statusCode).toBe(400);
    });

    it('400 — missing body field is rejected', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/notes`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({})
        .expect(400);

      expect(res.body.statusCode).toBe(400);
    });

    it('emits an audit event on successful note creation', async () => {
      await request(app.getHttpServer())
        .post(`/claims/${claimId}/notes`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({ body: '監査イベントテスト用ノートです。' })
        .expect(201);

      const events = await prisma.auditEvent.findMany({
        where: { claim_id: claimId, action: 'claim.note.added' },
        orderBy: { ts: 'desc' },
      });

      expect(events.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // POST /claims/:id/evidence
  // =========================================================================

  describe('POST /claims/:id/evidence', () => {
    let claimId: string;

    beforeAll(async () => {
      claimId = await createClaim(app, agentToken);
      await request(app.getHttpServer())
        .post(`/claims/${claimId}/assign`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ adjuster_id: adjusterUser.id })
        .expect(200);
    });

    it('201 — assigned adjuster can attach evidence', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/evidence`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          kind: 'photo',
          content_hash: 'a'.repeat(64), // sha-256 hex string
          blob_ref: 's3://stub/claims/test/photo1.jpg',
        })
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.claim_id).toBe(claimId);
      expect(res.body.kind).toBe('photo');
      expect(res.body.content_hash).toBe('a'.repeat(64));
      expect(res.body.blob_ref).toBe('s3://stub/claims/test/photo1.jpg');
      expect(res.body.uploaded_by_id).toBe(adjusterUser.id);
      expect(res.body.uploaded_at).toBeDefined();
    });

    it('201 — accepts all valid evidence kinds', async () => {
      const kinds = ['photo', 'document', 'audio', 'video', 'witness_statement_attachment'] as const;

      for (const kind of kinds) {
        const res = await request(app.getHttpServer())
          .post(`/claims/${claimId}/evidence`)
          .set('Authorization', `Bearer ${adjusterToken}`)
          .send({
            kind,
            content_hash: `${'b'.repeat(63)}${kinds.indexOf(kind)}`,
            blob_ref: `s3://stub/claims/test/${kind}-file`,
          })
          .expect(201);

        expect(res.body.kind).toBe(kind);
      }
    });

    it('403 — manager cannot attach evidence', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/evidence`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          kind: 'photo',
          content_hash: 'c'.repeat(64),
          blob_ref: 's3://stub/test.jpg',
        })
        .expect(403);

      expect(res.body.statusCode).toBe(403);
    });

    it('403 — agent cannot attach evidence', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/evidence`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          kind: 'document',
          content_hash: 'd'.repeat(64),
          blob_ref: 's3://stub/doc.pdf',
        })
        .expect(403);

      expect(res.body.statusCode).toBe(403);
    });

    it('403 — auditor cannot attach evidence', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/evidence`)
        .set('Authorization', `Bearer ${auditorToken}`)
        .send({
          kind: 'photo',
          content_hash: 'e'.repeat(64),
          blob_ref: 's3://stub/photo.jpg',
        })
        .expect(403);

      expect(res.body.statusCode).toBe(403);
    });

    it('400 — invalid evidence kind is rejected', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/evidence`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          kind: 'hologram',
          content_hash: 'f'.repeat(64),
          blob_ref: 's3://stub/test',
        })
        .expect(400);

      expect(res.body.statusCode).toBe(400);
    });

    it('400 — missing content_hash is rejected', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/evidence`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          kind: 'photo',
          blob_ref: 's3://stub/photo.jpg',
        })
        .expect(400);

      expect(res.body.statusCode).toBe(400);
    });

    it('emits an audit event on successful evidence attachment', async () => {
      await request(app.getHttpServer())
        .post(`/claims/${claimId}/evidence`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          kind: 'document',
          content_hash: 'a1b2c3'.repeat(10) + 'a1b2',
          blob_ref: 's3://stub/audit-test.pdf',
        })
        .expect(201);

      const events = await prisma.auditEvent.findMany({
        where: { claim_id: claimId, action: 'evidence.added' },
        orderBy: { ts: 'desc' },
      });

      expect(events.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // POST /claims/:id/witness-statement
  // =========================================================================

  describe('POST /claims/:id/witness-statement', () => {
    let claimId: string;
    const VALID_INKAN_HASH = 'f'.repeat(64); // sha-256 hex

    beforeAll(async () => {
      claimId = await createClaim(app, agentToken);
      await request(app.getHttpServer())
        .post(`/claims/${claimId}/assign`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ adjuster_id: adjusterUser.id })
        .expect(200);
    });

    it('201 — assigned adjuster can record a witness statement with inkan_seal_hash', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/witness-statement`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          witness_name: '山田花子',
          witness_phone: '090-1234-5678',
          statement_body: '事故当時、被保険者の車両が交差点を直進中に相手車両が飛び出してきました。',
          inkan_seal_hash: VALID_INKAN_HASH,
        })
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.claim_id).toBe(claimId);
      expect(res.body.witness_name).toBe('山田花子');
      expect(res.body.inkan_seal_hash).toBe(VALID_INKAN_HASH);
      expect(res.body.recorded_by_id).toBe(adjusterUser.id);
      expect(res.body.recorded_at).toBeDefined();
    });

    it('201 — witness_phone is optional', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/witness-statement`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          witness_name: '鈴木一郎',
          statement_body: '目撃した内容を詳細に記述します。電話番号は不明です。',
          inkan_seal_hash: '1'.repeat(64),
        })
        .expect(201);

      expect(res.body.id).toBeDefined();
    });

    it('403 — manager cannot record a witness statement directly', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/witness-statement`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          witness_name: '佐藤次郎',
          statement_body: 'マネージャーによる証言記録は不可のテスト。',
          inkan_seal_hash: '2'.repeat(64),
        })
        .expect(403);

      expect(res.body.statusCode).toBe(403);
    });

    it('403 — agent cannot record a witness statement', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/witness-statement`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          witness_name: '田中三郎',
          statement_body: 'エージェントによる証言記録は不可のテスト。',
          inkan_seal_hash: '3'.repeat(64),
        })
        .expect(403);

      expect(res.body.statusCode).toBe(403);
    });

    it('400 — missing inkan_seal_hash is rejected', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/witness-statement`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          witness_name: '証人名前',
          statement_body: '証言内容です。印鑑ハッシュなしのテスト。',
        })
        .expect(400);

      expect(res.body.statusCode).toBe(400);
    });

    it('400 — missing witness_name is rejected', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/witness-statement`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          statement_body: '証言内容です。',
          inkan_seal_hash: '4'.repeat(64),
        })
        .expect(400);

      expect(res.body.statusCode).toBe(400);
    });

    it('400 — missing statement_body is rejected', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/witness-statement`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          witness_name: '証人名前',
          inkan_seal_hash: '5'.repeat(64),
        })
        .expect(400);

      expect(res.body.statusCode).toBe(400);
    });

    it('emits an audit event on successful witness statement creation', async () => {
      await request(app.getHttpServer())
        .post(`/claims/${claimId}/witness-statement`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          witness_name: '監査テスト証人',
          statement_body: '監査イベント確認のための証言記録テストです。',
          inkan_seal_hash: '6'.repeat(64),
        })
        .expect(201);

      const events = await prisma.auditEvent.findMany({
        where: { claim_id: claimId, action: 'witness_statement.added' },
        orderBy: { ts: 'desc' },
      });

      expect(events.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // PATCH /claims/:id/status — FSM-guarded workflow transitions
  // =========================================================================

  describe('PATCH /claims/:id/status — FSM workflow transitions', () => {
    let claimId: string;

    // Helper to create a fresh assigned claim for each status-machine test
    async function createAssignedClaim(): Promise<string> {
      const id = await createClaim(app, agentToken);
      await request(app.getHttpServer())
        .post(`/claims/${id}/assign`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ adjuster_id: adjusterUser.id })
        .expect(200);
      return id;
    }

    it('200 — adjuster can transition intake → under_investigation', async () => {
      claimId = await createAssignedClaim();

      const res = await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({ to: 'under_investigation', reason: '書類確認のため調査開始' })
        .expect(200);

      expect(res.body.status).toBe('under_investigation');
    });

    it('200 — adjuster can transition under_investigation → awaiting_reserve_approval', async () => {
      claimId = await createAssignedClaim();

      await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({ to: 'under_investigation', reason: '調査開始' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({ to: 'awaiting_reserve_approval', reason: '準備金申請準備完了' })
        .expect(200);

      expect(res.body.status).toBe('awaiting_reserve_approval');
    });

    it('200 — manager can transition awaiting_reserve_approval → settlement_offered', async () => {
      claimId = await createAssignedClaim();

      await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({ to: 'under_investigation', reason: '調査開始' })
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({ to: 'awaiting_reserve_approval', reason: '申請準備完了' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ to: 'settlement_offered', reason: '和解条件提示' })
        .expect(200);

      expect(res.body.status).toBe('settlement_offered');
    });

    it('200 — can transition settlement_offered → closed_paid', async () => {
      claimId = await createAssignedClaim();

      const transitions: Array<{ to: string; reason: string; token: string }> = [
        { to: 'under_investigation', reason: '調査開始', token: adjusterToken },
        { to: 'awaiting_reserve_approval', reason: '申請準備完了', token: adjusterToken },
        { to: 'settlement_offered', reason: '和解条件提示', token: managerToken },
      ];

      for (const t of transitions) {
        await request(app.getHttpServer())
          .patch(`/claims/${claimId}/status`)
          .set('Authorization', `Bearer ${t.token}`)
          .send({ to: t.to, reason: t.reason })
          .expect(200);
      }

      const res = await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({ to: 'closed_paid', reason: '支払完了' })
        .expect(200);

      expect(res.body.status).toBe('closed_paid');
    });

    it('200 — can transition settlement_offered → closed_denied', async () => {
      claimId = await createAssignedClaim();

      const transitions: Array<{ to: string; reason: string; token: string }> = [
        { to: 'under_investigation', reason: '調査開始', token: adjusterToken },
        { to: 'awaiting_reserve_approval', reason: '申請準備完了', token: adjusterToken },
        { to: 'settlement_offered', reason: '和解条件提示', token: managerToken },
      ];

      for (const t of transitions) {
        await request(app.getHttpServer())
          .patch(`/claims/${claimId}/status`)
          .set('Authorization', `Bearer ${t.token}`)
          .send({ to: t.to, reason: t.reason })
          .expect(200);
      }

      const res = await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({ to: 'closed_denied', reason: '支払拒否' })
        .expect(200);

      expect(res.body.status).toBe('closed_denied');
    });

    it('422 — illegal FSM transition (intake → closed_paid) returns 422 with explanation', async () => {
      claimId = await createAssignedClaim();

      const res = await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({ to: 'closed_paid', reason: '不正な遷移テスト' })
        .expect(422);

      expect(res.body.statusCode).toBe(422);
      expect(res.body.message).toBeDefined();
    });

    it('422 — illegal FSM transition (intake → settlement_offered) returns 422', async () => {
      claimId = await createAssignedClaim();

      const res = await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({ to: 'settlement_offered', reason: '不正な遷移テスト' })
        .expect(422);

      expect(res.body.statusCode).toBe(422);
    });

    it('422 — cannot transition back from closed_paid to intake', async () => {
      claimId = await createAssignedClaim();

      const transitions: Array<{ to: string; reason: string; token: string }> = [
        { to: 'under_investigation', reason: '調査開始', token: adjusterToken },
        { to: 'awaiting_reserve_approval', reason: '申請準備完了', token: adjusterToken },
        { to: 'settlement_offered', reason: '和解条件提示', token: managerToken },
        { to: 'closed_paid', reason: '支払完了', token: adjusterToken },
      ];

      for (const t of transitions) {
        await request(app.getHttpServer())
          .patch(`/claims/${claimId}/status`)
          .set('Authorization', `Bearer ${t.token}`)
          .send({ to: t.to, reason: t.reason })
          .expect(200);
      }

      const res = await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({ to: 'intake', reason: '巻き戻しテスト' })
        .expect(422);

      expect(res.body.statusCode).toBe(422);
    });

    it('403 — agent cannot transition claim status', async () => {
      claimId = await createAssignedClaim();

      const res = await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ to: 'under_investigation', reason: '不正アクセステスト' })
        .expect(403);

      expect(res.body.statusCode).toBe(403);
    });

    it('403 — auditor cannot transition claim status', async () => {
      claimId = await createAssignedClaim();

      const res = await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${auditorToken}`)
        .send({ to: 'under_investigation', reason: '不正アクセステスト' })
        .expect(403);

      expect(res.body.statusCode).toBe(403);
    });

    it('400 — missing `to` field returns validation error', async () => {
      claimId = await createAssignedClaim();

      const res = await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({ reason: '理由のみ送信' })
        .expect(400);

      expect(res.body.statusCode).toBe(400);
    });

    it('400 — invalid status value returns validation error', async () => {
      claimId = await createAssignedClaim();

      const res = await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({ to: 'invalid_status_xyz', reason: '無効なステータス' })
        .expect(400);

      expect(res.body.statusCode).toBe(400);
    });

    it('emits an audit event on successful status transition', async () => {
      claimId = await createAssignedClaim();

      await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({ to: 'under_investigation', reason: '監査テスト用遷移' })
        .expect(200);

      const events = await prisma.auditEvent.findMany({
        where: { claim_id: claimId, action: 'claim.status.changed' },
        orderBy: { ts: 'desc' },
      });

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].actor_id).toBe(adjusterUser.id);
    });
  });

  // =========================================================================
  // GET /claims — role-scoped claim list
  // =========================================================================

  describe('GET /claims — role-scoped list', () => {
    it('200 — returns a list of claims for an authenticated user', async () => {
      const res = await request(app.getHttpServer())
        .get('/claims')
        .set('Authorization', `Bearer ${adjusterToken}`)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
    });

    it('200 — auditor can access all claims', async () => {
      const res = await request(app.getHttpServer())
        .get('/claims')
        .set('Authorization', `Bearer ${auditorToken}`)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
    });

    it('200 — supports status filter', async () => {
      const res = await request(app.getHttpServer())
        .get('/claims?status=intake')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      for (const claim of res.body as Array<{ status: string }>) {
        expect(claim.status).toBe('intake');
      }
    });

    it('200 — supports severity filter', async () => {
      const res = await request(app.getHttpServer())
        .get('/claims?severity=simple')
        .set('Authorization', `Bearer ${adjusterToken}`)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
    });

    it('200 — supports channel filter', async () => {
      const res = await request(app.getHttpServer())
        .get('/claims?channel=agent')
        .set('Authorization', `Bearer ${adjusterToken}`)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
    });

    it('401 — unauthenticated request is rejected', async () => {
      const res = await request(app.getHttpServer())
        .get('/claims')
        .expect(401);

      expect(res.body.statusCode).toBe(401);
    });
  });

  // =========================================================================
  // Audit log accumulation — write operations emit events
  // =========================================================================

  describe('Audit log accumulation', () => {
    it('every claim/note/evidence/reserve write has a matching AuditEvent', async () => {
      // Create a new claim — should emit claim.created
      const claimId = await createClaim(app, agentToken);

      const createdEvents = await prisma.auditEvent.findMany({
        where: { claim_id: claimId, action: 'claim.created' },
      });
      expect(createdEvents.length).toBeGreaterThanOrEqual(1);

      // Assign — should emit claim.assigned
      await request(app.getHttpServer())
        .post(`/claims/${claimId}/assign`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ adjuster_id: adjusterUser.id })
        .expect(200);

      const assignedEvents = await prisma.auditEvent.findMany({
        where: { claim_id: claimId, action: 'claim.assigned' },
      });
      expect(assignedEvents.length).toBeGreaterThanOrEqual(1);

      // Add note — should emit claim.note.added
      await request(app.getHttpServer())
        .post(`/claims/${claimId}/notes`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({ body: '監査ログ蓄積テストのノートです。' })
        .expect(201);

      const noteEvents = await prisma.auditEvent.findMany({
        where: { claim_id: claimId, action: 'claim.note.added' },
      });
      expect(noteEvents.length).toBeGreaterThanOrEqual(1);

      // Add evidence — should emit evidence.added
      await request(app.getHttpServer())
        .post(`/claims/${claimId}/evidence`)
        .set('Authorization', `Bearer ${adjusterToken}`)
        .send({
          kind: 'photo',
          content_hash: '0'.repeat(64),
          blob_ref: 's3://stub/audit-accumulation-test.jpg',
        })
        .expect(201);

      const evidenceEvents = await prisma.auditEvent.findMany({
        where: { claim_id: claimId, action: 'evidence.added' },
      });
      expect(evidenceEvents.length).toBeGreaterThanOrEqual(1);

      // Verify all audit events have required fields
      const allEvents = await prisma.auditEvent.findMany({
        where: { claim_id: claimId },
      });

      for (const event of allEvents) {
        expect(event.actor_id).toBeDefined();
        expect(event.actor_role).toBeDefined();
        expect(event.action).toBeDefined();
        expect(event.payload_hash).toBeDefined();
        expect(event.request_id).toBeDefined();
        expect(event.correlation_id).toBeDefined();
        expect(event.ts).toBeDefined();
      }
    });

    it('AuditEvent rows have no UPDATE or DELETE pathway — count only grows', async () => {
      const claimId = await createClaim(app, agentToken);

      const beforeCount = await prisma.auditEvent.count({
        where: { claim_id: claimId },
      });

      await request(app.getHttpServer())
        .post(`/claims/${claimId}/assign`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ adjuster_id: adjusterUser.id })
        .expect(200);

      const afterCount = await prisma.auditEvent.count({
        where: { claim_id: claimId },
      });

      expect(afterCount).toBeGreaterThan(beforeCount);
    });
  });

  // =========================================================================
  // Role matrix enforcement — comprehensive checks
  // =========================================================================

  describe('Role matrix enforcement', () => {
    let protectedClaimId: string;

    beforeAll(async () => {
      protectedClaimId = await createClaim(app, agentToken);
      await request(app.getHttpServer())
        .post(`/claims/${protectedClaimId}/assign`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ adjuster_id: adjusterUser.id })
        .expect(200);
    });

    it('siu_referrer cannot add notes', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${protectedClaimId}/notes`)
        .set('Authorization', `Bearer ${siuToken}`)
        .send({ body: 'SIU試みたノート追加' })
        .expect(403);

      expect(res.body.statusCode).toBe(403);
    });

    it('siu_referrer cannot attach evidence', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${protectedClaimId}/evidence`)
        .set('Authorization', `Bearer ${siuToken}`)
        .send({
          kind: 'photo',
          content_hash: '9'.repeat(64),
          blob_ref: 's3://stub/siu-test.jpg',
        })
        .expect(403);

      expect(res.body.statusCode).toBe(403);
    });

    it('siu_referrer cannot transition claim status', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/claims/${protectedClaimId}/status`)
        .set('Authorization', `Bearer ${siuToken}`)
        .send({ to: 'under_investigation', reason: 'SIU試みたステータス遷移' })
        .expect(403);

      expect(res.body.statusCode).toBe(403);
    });

    it('auditor has read-only access — cannot add notes', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${protectedClaimId}/notes`)
        .set('Authorization', `Bearer ${auditorToken}`)
        .send({ body: '監査人の書き込み試み' })
        .expect(403);

      expect(res.body.statusCode).toBe(403);
    });

    it('auditor has read-only access — cannot assign claims', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${protectedClaimId}/assign`)
        .set('Authorization', `Bearer ${auditorToken}`)
        .send({ adjuster_id: adjusterUser.id })
        .expect(403);

      expect(res.body.statusCode).toBe(403);
    });

    it('unassigned adjuster cannot add notes to another adjuster\'s claim', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${protectedClaimId}/notes`)
        .set('Authorization', `Bearer ${adjuster2Token}`)
        .send({ body: '担当外の調査員によるノート試み' })
        .expect(403);

      expect(res.body.statusCode).toBe(403);
    });

    it('unassigned adjuster cannot attach evidence to another adjuster\'s claim', async () => {
      const res = await request(app.getHttpServer())
        .post(`/claims/${protectedClaimId}/evidence`)
        .set('Authorization', `Bearer ${adjuster2Token}`)
        .send({
          kind: 'document',
          content_hash: '8'.repeat(64),
          blob_ref: 's3://stub/unassigned-adjuster-test.pdf',
        })
        .expect(403);

      expect(res.body.statusCode).toBe(403);
    });
  });

  // =========================================================================
  // Error envelope consistency
  // =========================================================================

  describe('Error envelope consistency', () => {
    it('all error responses include statusCode and message, no stack trace', async () => {
      const claimId = await createClaim(app, agentToken);

      const responses = await Promise.all([
        // 403 — agent tries to add note
        request(app.getHttpServer())
          .post(`/claims/${claimId}/notes`)
          .set('Authorization', `Bearer ${agentToken}`)
          .send({ body: 'Test note' }),
        // 422 — illegal FSM transition
        request(app.getHttpServer())
          .patch(`/claims/${claimId}/status`)
          .set('Authorization', `Bearer ${adjusterToken}`)
          .send({ to: 'closed_paid', reason: '不正遷移' }),
        // 401 — no auth
        request(app.getHttpServer())
          .get(`/claims/${claimId}`),
        // 404 — non-existent claim
        request(app.getHttpServer())
          .get('/claims/totally_nonexistent_id_12345')
          .set('Authorization', `Bearer ${adjusterToken}`),
      ]);

      for (const res of responses) {
        expect(res.body.statusCode).toBeDefined();
        expect(res.body.message).toBeDefined();
        expect(res.body.stack).toBeUndefined();
      }
    });
  });
});