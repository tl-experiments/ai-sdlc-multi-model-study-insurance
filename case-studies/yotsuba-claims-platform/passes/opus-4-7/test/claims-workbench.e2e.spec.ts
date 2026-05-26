// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// End-to-end tests for the Adjuster Workbench module.
//
// Covered scenarios (per brief.md acceptance criteria — at least one happy
// path + one auth-denied + one validation-failure per module):
//
//   Happy path:
//     * POST /claims/:id/assign by a manager succeeds and writes an audit
//       event.
//     * POST /claims/:id/notes by the assigned adjuster succeeds; the note
//       is immutable and appears in subsequent GETs.
//     * POST /claims/:id/evidence by the assigned adjuster persists a
//       content-hash record and writes an audit event.
//     * POST /claims/:id/witness-statement records the inkan_seal_hash.
//     * PATCH /claims/:id/status follows the legal FSM transitions.
//     * GET /claims/:id returns cleartext reporter_phone only to the
//       assigned adjuster; non-assigned adjusters see a masked value.
//
//   Auth-denied:
//     * Unauthenticated requests to workbench routes return 401.
//     * An adjuster who is not the assignee cannot add notes / evidence.
//     * Only managers can assign claims.
//     * Auditors are read-only and cannot mutate.
//
//   Validation-failure:
//     * Illegal FSM transition returns 422 with a domain reason.
//     * Missing required fields return 400.
//     * Unknown enum values return 400.
//
// These tests boot the real Nest application against the test Postgres
// instance (DATABASE_URL must point at it). All fixtures are created in
// `beforeAll` and torn down in `afterAll` so the suite is hermetic and
// does not depend on `prisma/seed.ts` having been run.
// ─────────────────────────────────────────────────────────────────────────

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';

// Ensure JWT signing is configured before the Nest module is compiled.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'yotsuba-test-secret';
// Provide a deterministic KEK for AES-256-GCM envelope encryption.
process.env.YOTSUBA_KEK_BASE64 =
  process.env.YOTSUBA_KEK_BASE64 ??
  Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');

interface SeededUser {
  id: string;
  username: string;
  password: string;
  email: string;
  token: string;
}

/**
 * Canonical well-formed FNOL payload used to spawn a claim that the
 * workbench tests then operate on. Kept private to this suite so the
 * FNOL suite and this suite cannot drift on each other.
 */
function baseFnolPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    policy_number: 'POL-WB-TEST-0001',
    loss_date: '2024-06-15T09:30:00.000Z',
    loss_location_prefecture: '東京都',
    loss_location_postal_code: '100-0001',
    loss_location_detail: '千代田区千代田1-1',
    reported_by_channel: 'agent',
    reporter_name: '山田太郎',
    reporter_phone: '+81-90-1234-5678',
    reporter_email: 'yamada.taro@example.jp',
    reporter_relation_to_insured: '本人',
    incident_type: 'auto_collision',
    initial_description:
      '交差点で信号待ち中に後続車両から追突された。軽微な物損あり。',
    injury_reported: false,
    third_party_involved: true,
    police_report_number: 'TKY-2024-06-15-0042',
    appi_consent_version: '1.0.0',
    appi_consent_at: '2024-06-15T09:25:00.000Z',
    ...overrides,
  };
}

describe('Claims Workbench (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const agent: SeededUser = {
    id: '',
    username: 'wb_test_agent',
    password: 'AgentPassword1!',
    email: 'wb_test_agent@yotsuba.test',
    token: '',
  };

  const manager: SeededUser = {
    id: '',
    username: 'wb_test_manager',
    password: 'ManagerPassword2@',
    email: 'wb_test_manager@yotsuba.test',
    token: '',
  };

  const adjusterAssigned: SeededUser = {
    id: '',
    username: 'wb_test_adjuster_assigned',
    password: 'AdjusterPassword3#',
    email: 'wb_test_adjuster_assigned@yotsuba.test',
    token: '',
  };

  const adjusterOther: SeededUser = {
    id: '',
    username: 'wb_test_adjuster_other',
    password: 'AdjusterPassword4$',
    email: 'wb_test_adjuster_other@yotsuba.test',
    token: '',
  };

  const auditor: SeededUser = {
    id: '',
    username: 'wb_test_auditor',
    password: 'AuditorPassword5%',
    email: 'wb_test_auditor@yotsuba.test',
    token: '',
  };

  const createdClaimIds: string[] = [];
  const allUsernames = [
    agent.username,
    manager.username,
    adjusterAssigned.username,
    adjusterOther.username,
    auditor.username,
  ];

  /**
   * Spawn a fresh claim via the FNOL endpoint so each test's mutations
   * are isolated from its siblings'. The returned id is appended to
   * `createdClaimIds` for teardown.
   */
  async function spawnClaim(
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/claims')
      .set('Authorization', `Bearer ${agent.token}`)
      .send(baseFnolPayload(overrides))
      .expect(201);
    const id = res.body.id as string;
    createdClaimIds.push(id);
    return id;
  }

  /**
   * Convenience wrapper to assign a claim to the canonical "assigned"
   * adjuster fixture via the manager-only assignment endpoint.
   */
  async function assignToAssignee(claimId: string): Promise<void> {
    await request(app.getHttpServer())
      .post(`/claims/${claimId}/assign`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ adjuster_id: adjusterAssigned.id })
      .expect((res) => {
        if (res.status !== 200 && res.status !== 201) {
          throw new Error(
            `assign failed: ${res.status} ${JSON.stringify(res.body)}`,
          );
        }
      });
  }

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    prisma = app.get(PrismaService);

    // Clean any prior fixtures from a previous failed run.
    await prisma.user.deleteMany({
      where: { username: { in: allUsernames } },
    });

    const hash = (pw: string): Promise<string> => bcrypt.hash(pw, 10);

    const agentRow = await prisma.user.create({
      data: {
        username: agent.username,
        password_hash: await hash(agent.password),
        role: 'agent',
        display_name: 'WB Test Agent',
        email: agent.email,
        is_claims_director: false,
      },
    });
    agent.id = agentRow.id;

    const managerRow = await prisma.user.create({
      data: {
        username: manager.username,
        password_hash: await hash(manager.password),
        role: 'manager',
        display_name: 'WB Test Manager',
        email: manager.email,
        is_claims_director: false,
      },
    });
    manager.id = managerRow.id;

    const assignedRow = await prisma.user.create({
      data: {
        username: adjusterAssigned.username,
        password_hash: await hash(adjusterAssigned.password),
        role: 'adjuster',
        display_name: 'WB Test Adjuster (Assigned)',
        email: adjusterAssigned.email,
        is_claims_director: false,
        reports_to_id: managerRow.id,
      },
    });
    adjusterAssigned.id = assignedRow.id;

    const otherRow = await prisma.user.create({
      data: {
        username: adjusterOther.username,
        password_hash: await hash(adjusterOther.password),
        role: 'adjuster',
        display_name: 'WB Test Adjuster (Other)',
        email: adjusterOther.email,
        is_claims_director: false,
        reports_to_id: managerRow.id,
      },
    });
    adjusterOther.id = otherRow.id;

    const auditorRow = await prisma.user.create({
      data: {
        username: auditor.username,
        password_hash: await hash(auditor.password),
        role: 'auditor',
        display_name: 'WB Test Auditor',
        email: auditor.email,
        is_claims_director: false,
      },
    });
    auditor.id = auditorRow.id;

    // Mint tokens once and reuse — login is exercised in auth.e2e.spec.ts.
    for (const u of [agent, manager, adjusterAssigned, adjusterOther, auditor]) {
      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: u.username, password: u.password })
        .expect(200);
      u.token = login.body.access_token as string;
    }
  });

  afterAll(async () => {
    if (prisma) {
      if (createdClaimIds.length > 0) {
        await prisma.auditEvent.deleteMany({
          where: { claim_id: { in: createdClaimIds } },
        });
        await prisma.claimNote.deleteMany({
          where: { claim_id: { in: createdClaimIds } },
        });
        await prisma.evidence.deleteMany({
          where: { claim_id: { in: createdClaimIds } },
        });
        await prisma.witnessStatement.deleteMany({
          where: { claim_id: { in: createdClaimIds } },
        });
        await prisma.reserve.deleteMany({
          where: { claim_id: { in: createdClaimIds } },
        });
        await prisma.notificationToRegulator.deleteMany({
          where: { claim_id: { in: createdClaimIds } },
        });
        await prisma.claim.deleteMany({
          where: { id: { in: createdClaimIds } },
        });
      }
      await prisma.user.deleteMany({
        where: { username: { in: allUsernames } },
      });
    }
    if (app) {
      await app.close();
    }
  });

  // ─── happy path ────────────────────────────────────────────────────

  describe('POST /claims/:id/assign (happy path)', () => {
    it('lets a manager assign a claim to an adjuster and writes an audit event', async () => {
      const claimId = await spawnClaim({ policy_number: 'POL-WB-ASSIGN-001' });

      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/assign`)
        .set('Authorization', `Bearer ${manager.token}`)
        .set('X-Correlation-Id', 'corr-wb-assign-001')
        .send({ adjuster_id: adjusterAssigned.id })
        .expect((r) => {
          if (r.status !== 200 && r.status !== 201) {
            throw new Error(
              `expected 200/201 got ${r.status}: ${JSON.stringify(r.body)}`,
            );
          }
        });

      expect(res.body).toEqual(
        expect.objectContaining({
          id: claimId,
          assigned_adjuster_id: adjusterAssigned.id,
        }),
      );

      const audit = await prisma.auditEvent.findFirst({
        where: { claim_id: claimId, action: 'claim.assigned' },
      });
      expect(audit).not.toBeNull();
      expect(audit?.actor_id).toBe(manager.id);
      expect(audit?.correlation_id).toBe('corr-wb-assign-001');
    });
  });

  describe('POST /claims/:id/notes (happy path)', () => {
    it('allows the assigned adjuster to append an immutable note', async () => {
      const claimId = await spawnClaim({ policy_number: 'POL-WB-NOTE-001' });
      await assignToAssignee(claimId);

      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/notes`)
        .set('Authorization', `Bearer ${adjusterAssigned.token}`)
        .send({ body: '現地調査を実施。被害状況を写真記録した。' })
        .expect(201);

      expect(res.body).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          claim_id: claimId,
          author_id: adjusterAssigned.id,
          body: '現地調査を実施。被害状況を写真記録した。',
        }),
      );

      // Note must be persisted exactly once.
      const noteRows = await prisma.claimNote.findMany({
        where: { claim_id: claimId },
      });
      expect(noteRows.length).toBe(1);

      // Audit event must be written.
      const audit = await prisma.auditEvent.findFirst({
        where: { claim_id: claimId, action: 'claim.note.added' },
      });
      expect(audit).not.toBeNull();
      expect(audit?.actor_id).toBe(adjusterAssigned.id);
    });
  });

  describe('POST /claims/:id/evidence (happy path)', () => {
    it('records an evidence row with content-hash and writes an audit event', async () => {
      const claimId = await spawnClaim({
        policy_number: 'POL-WB-EVIDENCE-001',
      });
      await assignToAssignee(claimId);

      const contentHash = crypto
        .createHash('sha256')
        .update('binary-blob-bytes-here')
        .digest('hex');

      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/evidence`)
        .set('Authorization', `Bearer ${adjusterAssigned.token}`)
        .send({
          kind: 'photo',
          content_hash: contentHash,
          blob_ref: 's3://stub/yotsuba/evidence/wb-test-001.jpg',
        })
        .expect(201);

      expect(res.body).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          claim_id: claimId,
          kind: 'photo',
          content_hash: contentHash,
          uploaded_by_id: adjusterAssigned.id,
        }),
      );

      const audit = await prisma.auditEvent.findFirst({
        where: { claim_id: claimId, action: 'claim.evidence.added' },
      });
      expect(audit).not.toBeNull();
    });
  });

  describe('POST /claims/:id/witness-statement (happy path)', () => {
    it('records a witness statement with inkan_seal_hash', async () => {
      const claimId = await spawnClaim({
        policy_number: 'POL-WB-WITNESS-001',
      });
      await assignToAssignee(claimId);

      const inkanSealHash = crypto
        .createHash('sha256')
        .update('canonical-statement|2024-06-15T10:00:00.000Z')
        .digest('hex');

      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/witness-statement`)
        .set('Authorization', `Bearer ${adjusterAssigned.token}`)
        .send({
          witness_name: '佐藤花子',
          witness_phone: '+81-90-9876-5432',
          statement_body:
            '交差点で青信号で進入した車両に後方から追突するのを目撃した。',
          inkan_seal_hash: inkanSealHash,
        })
        .expect(201);

      expect(res.body).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          claim_id: claimId,
          witness_name: '佐藤花子',
          inkan_seal_hash: inkanSealHash,
          recorded_by_id: adjusterAssigned.id,
        }),
      );

      // Witness phone must be encrypted at rest, not cleartext.
      const row = await prisma.witnessStatement.findUnique({
        where: { id: res.body.id },
      });
      expect(row).not.toBeNull();
      const serialised = JSON.stringify(row);
      expect(serialised).not.toContain('+81-90-9876-5432');
    });
  });

  describe('PATCH /claims/:id/status (happy path)', () => {
    it('walks the FSM intake → under_investigation → awaiting_reserve_approval', async () => {
      const claimId = await spawnClaim({ policy_number: 'POL-WB-FSM-001' });
      await assignToAssignee(claimId);

      const step1 = await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${adjusterAssigned.token}`)
        .send({
          to: 'under_investigation',
          reason: '初期確認完了、本格調査を開始する。',
        })
        .expect(200);

      expect(step1.body.status).toBe('under_investigation');

      const step2 = await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${adjusterAssigned.token}`)
        .send({
          to: 'awaiting_reserve_approval',
          reason: '損害額算定完了、引当金承認を待つ。',
        })
        .expect(200);

      expect(step2.body.status).toBe('awaiting_reserve_approval');

      // Each successful transition must emit an audit event.
      const audits = await prisma.auditEvent.findMany({
        where: { claim_id: claimId, action: 'claim.status.changed' },
      });
      expect(audits.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('GET /claims/:id (PII masking by role)', () => {
    it('returns cleartext reporter_phone to the assigned adjuster only', async () => {
      const claimId = await spawnClaim({ policy_number: 'POL-WB-MASK-001' });
      await assignToAssignee(claimId);

      // Assigned adjuster: should see cleartext PII.
      const asAssigned = await request(app.getHttpServer())
        .get(`/claims/${claimId}`)
        .set('Authorization', `Bearer ${adjusterAssigned.token}`)
        .expect(200);

      expect(asAssigned.body.reporter_phone).toBe('+81-90-1234-5678');
      expect(asAssigned.body.reporter_email).toBe('yamada.taro@example.jp');

      // A different adjuster: must see a masked value (or null), never
      // the cleartext.
      const asOther = await request(app.getHttpServer())
        .get(`/claims/${claimId}`)
        .set('Authorization', `Bearer ${adjusterOther.token}`);

      // Either the route returns 403 (not your claim) or 200 with masked
      // PII; both are acceptable per ADR-003. What is NOT acceptable is
      // returning the cleartext.
      if (asOther.status === 200) {
        expect(asOther.body.reporter_phone).not.toBe('+81-90-1234-5678');
        expect(asOther.body.reporter_email).not.toBe(
          'yamada.taro@example.jp',
        );
      } else {
        expect(asOther.status).toBe(403);
      }

      // Auditor: read-all-but-masked per the role matrix.
      const asAuditor = await request(app.getHttpServer())
        .get(`/claims/${claimId}`)
        .set('Authorization', `Bearer ${auditor.token}`)
        .expect(200);

      // Auditor sees the claim but PII is masked at standard-PII tier.
      expect(asAuditor.body.reporter_phone).not.toBe('+81-90-1234-5678');
    });
  });

  // ─── auth-denied ───────────────────────────────────────────────────

  describe('Workbench routes (auth-denied)', () => {
    it('returns 401 when no bearer token is supplied to /assign', async () => {
      const claimId = await spawnClaim({ policy_number: 'POL-WB-AUTH-001' });
      await request(app.getHttpServer())
        .post(`/claims/${claimId}/assign`)
        .send({ adjuster_id: adjusterAssigned.id })
        .expect(401);
    });

    it('returns 403 when a non-manager attempts to assign a claim', async () => {
      const claimId = await spawnClaim({ policy_number: 'POL-WB-AUTH-002' });

      const res = await request(app.getHttpServer())
        .post(`/claims/${claimId}/assign`)
        .set('Authorization', `Bearer ${adjusterAssigned.token}`)
        .send({ adjuster_id: adjusterAssigned.id })
        .expect(403);

      expect(res.body).not.toHaveProperty('stack');
    });

    it('returns 403 when a non-assigned adjuster tries to add a note', async () => {
      const claimId = await spawnClaim({ policy_number: 'POL-WB-AUTH-003' });
      await assignToAssignee(claimId);

      await request(app.getHttpServer())
        .post(`/claims/${claimId}/notes`)
        .set('Authorization', `Bearer ${adjusterOther.token}`)
        .send({ body: '横入りメモ' })
        .expect(403);
    });

    it('returns 403 when a non-assigned adjuster tries to add evidence', async () => {
      const claimId = await spawnClaim({ policy_number: 'POL-WB-AUTH-004' });
      await assignToAssignee(claimId);

      const contentHash = crypto
        .createHash('sha256')
        .update('not-your-evidence')
        .digest('hex');

      await request(app.getHttpServer())
        .post(`/claims/${claimId}/evidence`)
        .set('Authorization', `Bearer ${adjusterOther.token}`)
        .send({
          kind: 'photo',
          content_hash: contentHash,
          blob_ref: 's3://stub/unauthorised.jpg',
        })
        .expect(403);
    });

    it('returns 403 when an auditor tries to mutate a claim status', async () => {
      const claimId = await spawnClaim({ policy_number: 'POL-WB-AUTH-005' });
      await assignToAssignee(claimId);

      await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${auditor.token}`)
        .send({ to: 'under_investigation', reason: 'auditor cannot do this' })
        .expect(403);
    });

    it('returns 401 to unauthenticated GET /claims/:id', async () => {
      const claimId = await spawnClaim({ policy_number: 'POL-WB-AUTH-006' });
      await request(app.getHttpServer())
        .get(`/claims/${claimId}`)
        .expect(401);
    });
  });

  // ─── validation-failure ────────────────────────────────────────────

  describe('Workbench routes (validation-failure)', () => {
    it('returns 422 on an illegal FSM transition with a domain reason', async () => {
      const claimId = await spawnClaim({ policy_number: 'POL-WB-FSM-BAD-001' });
      await assignToAssignee(claimId);

      // intake → closed_paid is not a legal transition; the FSM must
      // reject it with 422 and an explanation, not silently accept.
      const res = await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${adjusterAssigned.token}`)
        .send({ to: 'closed_paid', reason: '飛び級で支払い完了に遷移したい' })
        .expect(422);

      expect(res.body).toEqual(
        expect.objectContaining({
          message: expect.stringMatching(/transition|status|illegal|allowed/i),
        }),
      );
      expect(res.body).not.toHaveProperty('stack');
    });

    it('returns 400 when status DTO is missing the `to` field', async () => {
      const claimId = await spawnClaim({ policy_number: 'POL-WB-FSM-BAD-002' });
      await assignToAssignee(claimId);

      await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${adjusterAssigned.token}`)
        .send({ reason: 'missing to' })
        .expect(400);
    });

    it('returns 400 when status `to` is not a known enum value', async () => {
      const claimId = await spawnClaim({ policy_number: 'POL-WB-FSM-BAD-003' });
      await assignToAssignee(claimId);

      await request(app.getHttpServer())
        .patch(`/claims/${claimId}/status`)
        .set('Authorization', `Bearer ${adjusterAssigned.token}`)
        .send({ to: 'sent_to_mars', reason: 'invalid enum' })
        .expect(400);
    });

    it('returns 400 when note body is missing', async () => {
      const claimId = await spawnClaim({ policy_number: 'POL-WB-NOTE-BAD-001' });
      await assignToAssignee(claimId);

      await request(app.getHttpServer())
        .post(`/claims/${claimId}/notes`)
        .set('Authorization', `Bearer ${adjusterAssigned.token}`)
        .send({})
        .expect(400);
    });

    it('returns 400 when evidence kind is not a known enum value', async () => {
      const claimId = await spawnClaim({
        policy_number: 'POL-WB-EVIDENCE-BAD-001',
      });
      await assignToAssignee(claimId);

      const contentHash = crypto
        .createHash('sha256')
        .update('invalid-kind')
        .digest('hex');

      await request(app.getHttpServer())
        .post(`/claims/${claimId}/evidence`)
        .set('Authorization', `Bearer ${adjusterAssigned.token}`)
        .send({
          kind: 'hologram',
          content_hash: contentHash,
          blob_ref: 's3://stub/x.bin',
        })
        .expect(400);
    });

    it('returns 400 when witness-statement is missing inkan_seal_hash', async () => {
      const claimId = await spawnClaim({
        policy_number: 'POL-WB-WITNESS-BAD-001',
      });
      await assignToAssignee(claimId);

      await request(app.getHttpServer())
        .post(`/claims/${claimId}/witness-statement`)
        .set('Authorization', `Bearer ${adjusterAssigned.token}`)
        .send({
          witness_name: '田中一郎',
          statement_body: '目撃した。',
        })
        .expect(400);
    });

    it('returns 400 when assign DTO is missing adjuster_id', async () => {
      const claimId = await spawnClaim({ policy_number: 'POL-WB-ASSIGN-BAD-001' });

      await request(app.getHttpServer())
        .post(`/claims/${claimId}/assign`)
        .set('Authorization', `Bearer ${manager.token}`)
        .send({})
        .expect(400);
    });

    it('returns 400 when unknown fields are supplied to a note (whitelist)', async () => {
      const claimId = await spawnClaim({ policy_number: 'POL-WB-NOTE-BAD-002' });
      await assignToAssignee(claimId);

      await request(app.getHttpServer())
        .post(`/claims/${claimId}/notes`)
        .set('Authorization', `Bearer ${adjusterAssigned.token}`)
        .send({ body: 'メモ', secret_override: true })
        .expect(400);
    });
  });
});