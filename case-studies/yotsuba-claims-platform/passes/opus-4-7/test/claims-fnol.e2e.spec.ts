// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// End-to-end tests for the FNOL (First Notice of Loss) intake module.
//
// Covered scenarios (per brief.md acceptance criteria — at least one happy
// path + one auth-denied + one validation-failure per module):
//
//   Happy path:
//     * POST /claims (agent channel) with a well-formed payload returns 201
//       with a Claim envelope, severity_initial populated, APPI consent
//       captured, and an AuditEvent row written.
//     * Each of the four channels (agent / mobile / broker / email) is
//       reachable via its dedicated normaliser endpoint and lands a Claim
//       with the correct `reported_by_channel` discriminator.
//     * Severity classifier yields `catastrophic` for an injury-with-
//       third-party fire_commercial claim.
//
//   Auth-denied:
//     * POST /claims without a bearer token returns 401.
//     * POST /claims with an auditor token returns 403 (read-only role).
//
//   Validation-failure:
//     * `loss_date` outside the policy effective window returns 422.
//     * Missing required field returns 400.
//     * Invalid prefecture returns 400.
//     * Non-agent channels without APPI consent return 422.
//     * Unknown `incident_type` enum returns 400.
//
// These tests boot the real Nest application against the test Postgres
// instance (DATABASE_URL must point at it). Fixture users and claims are
// created in `beforeAll` and torn down in `afterAll` so the suite is
// hermetic and does not depend on `prisma/seed.ts` having been run.
// ─────────────────────────────────────────────────────────────────────────

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';

// Ensure JWT signing is configured before the Nest module is compiled.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'yotsuba-test-secret';
// Provide a deterministic KEK for AES-256-GCM envelope encryption. The
// value must be 32 bytes base64-encoded to match the production format.
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
 * Canonical well-formed FNOL payload. Individual tests clone-and-mutate
 * this to target a specific failure mode while keeping every other field
 * valid; this keeps validation-failure tests narrow and unambiguous.
 */
function baseFnolPayload(): Record<string, unknown> {
  return {
    policy_number: 'POL-FNOL-TEST-0001',
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
  };
}

describe('Claims FNOL (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const agent: SeededUser = {
    id: '',
    username: 'fnol_test_agent',
    password: 'AgentPassword1!',
    email: 'fnol_test_agent@yotsuba.test',
    token: '',
  };

  const auditor: SeededUser = {
    id: '',
    username: 'fnol_test_auditor',
    password: 'AuditorPassword2@',
    email: 'fnol_test_auditor@yotsuba.test',
    token: '',
  };

  // Track every claim id we create so we can clean dependent rows in
  // the right order during teardown.
  const createdClaimIds: string[] = [];

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

    // Clean any prior fixtures from a previous failed run. Audit events,
    // notes, evidence, witness statements, and reserves are removed
    // first because they all reference Claim rows via FK.
    await prisma.user.deleteMany({
      where: { username: { in: [agent.username, auditor.username] } },
    });
    await prisma.auditEvent.deleteMany({
      where: { action: { startsWith: 'claim.' } },
    });

    const agentHash = await bcrypt.hash(agent.password, 10);
    const auditorHash = await bcrypt.hash(auditor.password, 10);

    const agentRow = await prisma.user.create({
      data: {
        username: agent.username,
        password_hash: agentHash,
        role: 'agent',
        display_name: 'FNOL Test Agent',
        email: agent.email,
        is_claims_director: false,
      },
    });
    agent.id = agentRow.id;

    const auditorRow = await prisma.user.create({
      data: {
        username: auditor.username,
        password_hash: auditorHash,
        role: 'auditor',
        display_name: 'FNOL Test Auditor',
        email: auditor.email,
        is_claims_director: false,
      },
    });
    auditor.id = auditorRow.id;

    // Mint tokens once and reuse — login is exercised in auth.e2e.spec.ts.
    const agentLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: agent.username, password: agent.password })
      .expect(200);
    agent.token = agentLogin.body.access_token as string;

    const auditorLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: auditor.username, password: auditor.password })
      .expect(200);
    auditor.token = auditorLogin.body.access_token as string;
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
        where: { username: { in: [agent.username, auditor.username] } },
      });
    }
    if (app) {
      await app.close();
    }
  });

  // ─── happy path ────────────────────────────────────────────────────

  describe('POST /claims (happy path)', () => {
    it('creates a claim via the agent channel and writes an audit event', async () => {
      const payload = baseFnolPayload();

      const res = await request(app.getHttpServer())
        .post('/claims')
        .set('Authorization', `Bearer ${agent.token}`)
        .set('X-Correlation-Id', 'corr-fnol-happy-001')
        .send(payload)
        .expect(201);

      expect(res.body).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          policy_number: 'POL-FNOL-TEST-0001',
          reported_by_channel: 'agent',
          incident_type: 'auto_collision',
          status: 'intake',
          severity_initial: expect.stringMatching(
            /^(simple|complex|catastrophic)$/,
          ),
          appi_consent_version: '1.0.0',
        }),
      );

      const claimId = res.body.id as string;
      createdClaimIds.push(claimId);

      // The audit interceptor must have written a claim.created row
      // bound to the correlation id we supplied.
      const audit = await prisma.auditEvent.findFirst({
        where: { claim_id: claimId, action: 'claim.created' },
      });
      expect(audit).not.toBeNull();
      expect(audit?.actor_id).toBe(agent.id);
      expect(audit?.correlation_id).toBe('corr-fnol-happy-001');
      expect(audit?.payload_hash).toMatch(/^[a-f0-9]{64}$/);

      // Sensitive PII (phone/email) must not appear in cleartext in the
      // raw DB row — they live in the `_ct` ciphertext columns.
      const row = await prisma.claim.findUnique({ where: { id: claimId } });
      expect(row).not.toBeNull();
      const serialisedRow = JSON.stringify(row);
      expect(serialisedRow).not.toContain('yamada.taro@example.jp');
      expect(serialisedRow).not.toContain('+81-90-1234-5678');
    });

    it('classifies a fire_commercial claim with injuries as catastrophic', async () => {
      const payload = {
        ...baseFnolPayload(),
        policy_number: 'POL-FNOL-TEST-0002',
        incident_type: 'fire_commercial',
        injury_reported: true,
        third_party_involved: true,
        initial_description:
          '商業ビルで大規模火災発生。複数の負傷者と第三者被害あり。',
      };

      const res = await request(app.getHttpServer())
        .post('/claims')
        .set('Authorization', `Bearer ${agent.token}`)
        .send(payload)
        .expect(201);

      expect(res.body.severity_initial).toBe('catastrophic');
      createdClaimIds.push(res.body.id);
    });

    it('accepts a mobile-channel intake via /claims/mobile', async () => {
      const payload = {
        ...baseFnolPayload(),
        policy_number: 'POL-FNOL-TEST-MOBILE',
        reported_by_channel: 'mobile',
      };

      const res = await request(app.getHttpServer())
        .post('/claims/mobile')
        .set('Authorization', `Bearer ${agent.token}`)
        .send(payload)
        .expect(201);

      expect(res.body.reported_by_channel).toBe('mobile');
      createdClaimIds.push(res.body.id);
    });

    it('accepts a broker-channel intake via /claims/broker', async () => {
      const payload = {
        ...baseFnolPayload(),
        policy_number: 'POL-FNOL-TEST-BROKER',
        reported_by_channel: 'broker',
      };

      const res = await request(app.getHttpServer())
        .post('/claims/broker')
        .set('Authorization', `Bearer ${agent.token}`)
        .send(payload)
        .expect(201);

      expect(res.body.reported_by_channel).toBe('broker');
      createdClaimIds.push(res.body.id);
    });

    it('accepts an email-channel intake via /claims/email-parse', async () => {
      const payload = {
        ...baseFnolPayload(),
        policy_number: 'POL-FNOL-TEST-EMAIL',
        reported_by_channel: 'email',
      };

      const res = await request(app.getHttpServer())
        .post('/claims/email-parse')
        .set('Authorization', `Bearer ${agent.token}`)
        .send(payload)
        .expect(201);

      expect(res.body.reported_by_channel).toBe('email');
      createdClaimIds.push(res.body.id);
    });
  });

  // ─── auth-denied ───────────────────────────────────────────────────

  describe('POST /claims (auth-denied)', () => {
    it('returns 401 when no bearer token is supplied', async () => {
      await request(app.getHttpServer())
        .post('/claims')
        .send(baseFnolPayload())
        .expect(401);
    });

    it('returns 401 when the bearer token is malformed', async () => {
      await request(app.getHttpServer())
        .post('/claims')
        .set('Authorization', 'Bearer not-a-real-jwt')
        .send(baseFnolPayload())
        .expect(401);
    });

    it('returns 403 when an auditor (read-only role) attempts to create a claim', async () => {
      const res = await request(app.getHttpServer())
        .post('/claims')
        .set('Authorization', `Bearer ${auditor.token}`)
        .send(baseFnolPayload())
        .expect(403);

      // Standardised error envelope; no stack traces leaked.
      expect(res.body).not.toHaveProperty('stack');
    });
  });

  // ─── validation-failure ────────────────────────────────────────────

  describe('POST /claims (validation-failure)', () => {
    it('returns 400 when a required field is missing', async () => {
      const payload = baseFnolPayload();
      delete payload.policy_number;

      const res = await request(app.getHttpServer())
        .post('/claims')
        .set('Authorization', `Bearer ${agent.token}`)
        .send(payload)
        .expect(400);

      expect(res.body).not.toHaveProperty('stack');
    });

    it('returns 400 when incident_type is not a known enum value', async () => {
      await request(app.getHttpServer())
        .post('/claims')
        .set('Authorization', `Bearer ${agent.token}`)
        .send({ ...baseFnolPayload(), incident_type: 'meteor_strike' })
        .expect(400);
    });

    it('returns 400 when reported_by_channel is not a known enum value', async () => {
      await request(app.getHttpServer())
        .post('/claims')
        .set('Authorization', `Bearer ${agent.token}`)
        .send({ ...baseFnolPayload(), reported_by_channel: 'carrier_pigeon' })
        .expect(400);
    });

    it('returns 400 when the prefecture is not a valid 都道府県', async () => {
      await request(app.getHttpServer())
        .post('/claims')
        .set('Authorization', `Bearer ${agent.token}`)
        .send({
          ...baseFnolPayload(),
          loss_location_prefecture: 'Atlantis',
        })
        .expect(400);
    });

    it('returns 400 when unknown fields are supplied (whitelist enforcement)', async () => {
      await request(app.getHttpServer())
        .post('/claims')
        .set('Authorization', `Bearer ${agent.token}`)
        .send({ ...baseFnolPayload(), admin_override: true })
        .expect(400);
    });

    it('returns 422 when loss_date falls outside the policy effective window', async () => {
      // The Policy Service stub treats POL-EXPIRED-* as a policy that
      // expired before any 2024 loss date. A loss_date in 2024 must be
      // rejected with a domain-level 422, not a generic 400.
      const payload = {
        ...baseFnolPayload(),
        policy_number: 'POL-EXPIRED-0001',
        loss_date: '2024-06-15T09:30:00.000Z',
      };

      const res = await request(app.getHttpServer())
        .post('/claims')
        .set('Authorization', `Bearer ${agent.token}`)
        .send(payload)
        .expect(422);

      expect(res.body).toEqual(
        expect.objectContaining({
          message: expect.stringMatching(/policy|effective|window|expir/i),
        }),
      );
      expect(res.body).not.toHaveProperty('stack');
    });

    it('returns 422 when a non-agent channel intake omits APPI consent', async () => {
      // Per brief.md §FNOL: "Reject intake if consent is missing for
      // non-agent channels." The agent channel can defer consent because
      // the call-centre agent captures it verbally; mobile/broker/email
      // require an explicit consent record.
      const payload = {
        ...baseFnolPayload(),
        policy_number: 'POL-FNOL-NO-CONSENT',
        reported_by_channel: 'mobile',
      };
      delete payload.appi_consent_version;
      delete payload.appi_consent_at;

      const res = await request(app.getHttpServer())
        .post('/claims/mobile')
        .set('Authorization', `Bearer ${agent.token}`)
        .send(payload)
        .expect(422);

      expect(res.body).toEqual(
        expect.objectContaining({
          message: expect.stringMatching(/appi|consent/i),
        }),
      );
    });
  });
});