// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// APPI end-to-end tests — exercise the data-subject export
// (Article 28 disclosure right) and the anonymise gate
// documented in brief.md §Non-functional requirements.
//
// Coverage targets (per acceptance criterion #10 in brief.md):
//   1. Happy path: an auditor pulls a data-subject export and
//      receives every claim the named individual appears on,
//      across both reporter and witness appearances, with
//      special-care PII decrypted inline.
//   2. Auth-denied path: a non-auditor / non-manager role is
//      rejected with 403.
//   3. Validation failure: an empty data_subject_name is
//      rejected with 400.
//   4. Anonymise gate: Track A refuses every caller, including
//      a manager, with 403 (the route exists for surface
//      stability — Track B opens it).
//   5. Witness-only appearance: a subject who is only a
//      witness on a claim gets that claim in the export but
//      with the reporter-side PII columns nulled, so a third
//      party's data is not leaked through the disclosure.
// ─────────────────────────────────────────────────────────────────────────

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { encryptPii } from '../src/common/encryption';

describe('APPI compliance hooks (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  // Tokens minted via /auth/login during beforeAll.
  let auditor_token: string;
  let manager_token: string;
  let adjuster_token: string;
  let agent_token: string;

  // Seeded user ids — captured for assertions.
  let auditor_id: string;
  let manager_id: string;
  let adjuster_id: string;
  let agent_id: string;

  // Seeded claim ids — captured to assert export contents.
  let claim_reporter_1_id: string;
  let claim_reporter_2_id: string;
  let claim_witness_only_id: string;

  const data_subject_name = '山田 太郎';
  const other_reporter_name = '佐藤 花子';

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

    prisma = moduleFixture.get(PrismaService);

    // ── Clean slate for this spec ────────────────────────────
    // Order matters: child tables first.
    await prisma.auditEvent.deleteMany({});
    await prisma.notificationToRegulator.deleteMany({});
    await prisma.reserve.deleteMany({});
    await prisma.witnessStatement.deleteMany({});
    await prisma.evidence.deleteMany({});
    await prisma.claimNote.deleteMany({});
    await prisma.claim.deleteMany({});
    await prisma.user.deleteMany({
      where: {
        username: {
          in: [
            'appi.auditor',
            'appi.manager',
            'appi.adjuster',
            'appi.agent',
          ],
        },
      },
    });

    // ── Seed users via the auth surface so password hashing
    //    matches whatever the production code path uses. We
    //    create them directly in the DB with bcrypt-hashed
    //    passwords mirroring the seed script's convention.
    // ────────────────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const bcrypt = require('bcrypt') as typeof import('bcrypt');
    const password_hash = await bcrypt.hash('Passw0rd!', 10);

    const auditor = await prisma.user.create({
      data: {
        username: 'appi.auditor',
        password_hash,
        role: 'auditor',
        display_name: 'APPI Auditor',
        email: 'appi.auditor@example.test',
      },
    });
    auditor_id = auditor.id;

    const manager = await prisma.user.create({
      data: {
        username: 'appi.manager',
        password_hash,
        role: 'manager',
        display_name: 'APPI Manager',
        email: 'appi.manager@example.test',
      },
    });
    manager_id = manager.id;

    const adjuster = await prisma.user.create({
      data: {
        username: 'appi.adjuster',
        password_hash,
        role: 'adjuster',
        display_name: 'APPI Adjuster',
        email: 'appi.adjuster@example.test',
        reports_to_id: manager.id,
      },
    });
    adjuster_id = adjuster.id;

    const agent = await prisma.user.create({
      data: {
        username: 'appi.agent',
        password_hash,
        role: 'agent',
        display_name: 'APPI Agent',
        email: 'appi.agent@example.test',
      },
    });
    agent_id = agent.id;

    // ── Seed claims ─────────────────────────────────────────
    // Two claims where 山田 太郎 is the reporter, plus one where
    // 佐藤 花子 is the reporter and 山田 太郎 is only a witness.
    // All special-care PII is stored encrypted so the export
    // path is exercised end-to-end.
    const consent_at = new Date('2024-01-15T10:00:00Z');

    const claim_reporter_1 = await prisma.claim.create({
      data: {
        policy_number: 'POL-APPI-001',
        loss_date: new Date('2024-02-01T09:00:00Z'),
        loss_location_prefecture: '東京都',
        loss_location_postal_code: '100-0001',
        loss_location_detail: '千代田区千代田1-1',
        reported_by_channel: 'agent',
        reporter_name: data_subject_name,
        reporter_phone_ct: encryptPii('090-1111-2222'),
        reporter_email_ct: encryptPii('yamada.taro@example.jp'),
        reporter_relation_to_insured: '本人',
        incident_type: 'auto_collision',
        initial_description: 'Rear-ended at a traffic signal.',
        injury_reported: true,
        third_party_involved: true,
        severity_initial: 'complex',
        appi_consent_version: 'v1.0',
        appi_consent_at: consent_at,
        insured_government_id_ct: encryptPii('123456789012'),
        bank_account_for_payout_ct: encryptPii('MUFG-001-1234567'),
        injury_details_ct: encryptPii('Whiplash, cervical strain.'),
        assigned_adjuster_id: adjuster_id,
      },
    });
    claim_reporter_1_id = claim_reporter_1.id;

    const claim_reporter_2 = await prisma.claim.create({
      data: {
        policy_number: 'POL-APPI-002',
        loss_date: new Date('2024-03-12T14:30:00Z'),
        loss_location_prefecture: '大阪府',
        loss_location_postal_code: '530-0001',
        loss_location_detail: '大阪市北区梅田2-2',
        reported_by_channel: 'mobile',
        reporter_name: data_subject_name,
        reporter_phone_ct: encryptPii('090-1111-2222'),
        reporter_email_ct: encryptPii('yamada.taro@example.jp'),
        reporter_relation_to_insured: '本人',
        incident_type: 'fire_residential',
        initial_description: 'Kitchen fire, contained to one room.',
        injury_reported: false,
        third_party_involved: false,
        severity_initial: 'simple',
        appi_consent_version: 'v1.0',
        appi_consent_at: consent_at,
      },
    });
    claim_reporter_2_id = claim_reporter_2.id;

    const claim_witness_only = await prisma.claim.create({
      data: {
        policy_number: 'POL-APPI-003',
        loss_date: new Date('2024-04-05T18:00:00Z'),
        loss_location_prefecture: '神奈川県',
        loss_location_postal_code: '220-0011',
        loss_location_detail: '横浜市西区高島3-3',
        reported_by_channel: 'broker',
        reporter_name: other_reporter_name,
        reporter_phone_ct: encryptPii('080-9999-8888'),
        reporter_email_ct: encryptPii('sato.hanako@example.jp'),
        reporter_relation_to_insured: '本人',
        incident_type: 'auto_property_damage',
        initial_description: 'Parking lot scrape; another driver involved.',
        injury_reported: false,
        third_party_involved: true,
        severity_initial: 'simple',
        appi_consent_version: 'v1.0',
        appi_consent_at: consent_at,
      },
    });
    claim_witness_only_id = claim_witness_only.id;

    // 山田 太郎 appears as a witness on 佐藤 花子's claim.
    await prisma.witnessStatement.create({
      data: {
        claim_id: claim_witness_only.id,
        witness_name: data_subject_name,
        witness_phone_ct: encryptPii('090-1111-2222'),
        statement_body:
          'I was walking past and saw the blue sedan reverse into the parked car.',
        inkan_seal_hash:
          '0000000000000000000000000000000000000000000000000000000000000001',
        recorded_by_id: adjuster_id,
      },
    });

    // A second witness on the reporter-1 claim — a *different*
    // individual, to confirm the export filters witness rows by
    // name and does not over-disclose other witnesses' data.
    await prisma.witnessStatement.create({
      data: {
        claim_id: claim_reporter_1.id,
        witness_name: '田中 一郎',
        witness_phone_ct: encryptPii('070-3333-4444'),
        statement_body: 'Saw the rear-end collision from the sidewalk.',
        inkan_seal_hash:
          '0000000000000000000000000000000000000000000000000000000000000002',
        recorded_by_id: adjuster_id,
      },
    });

    // ── Mint tokens ─────────────────────────────────────────
    auditor_token = await login('appi.auditor');
    manager_token = await login('appi.manager');
    adjuster_token = await login('appi.adjuster');
    agent_token = await login('appi.agent');
  });

  afterAll(async () => {
    // Best-effort cleanup; the next spec's beforeAll will also
    // truncate so a failed teardown here doesn't cascade.
    try {
      await prisma.auditEvent.deleteMany({});
      await prisma.witnessStatement.deleteMany({});
      await prisma.claim.deleteMany({
        where: {
          id: {
            in: [
              claim_reporter_1_id,
              claim_reporter_2_id,
              claim_witness_only_id,
            ],
          },
        },
      });
      await prisma.user.deleteMany({
        where: {
          id: { in: [auditor_id, manager_id, adjuster_id, agent_id] },
        },
      });
    } finally {
      await app.close();
    }
  });

  // Helper: POST /auth/login → access_token.
  async function login(username: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username, password: 'Passw0rd!' })
      .expect(201);
    expect(res.body.access_token).toBeDefined();
    return res.body.access_token as string;
  }

  // ─────────────────────────────────────────────────────────
  // Data-subject export — happy path
  // ─────────────────────────────────────────────────────────

  describe('GET /claims/:id/data-subject-export — APPI Article 28', () => {
    it('returns every claim the data subject appears on, with decrypted special-care PII', async () => {
      const res = await request(app.getHttpServer())
        .get(`/claims/${claim_reporter_1_id}/data-subject-export`)
        .query({ data_subject_name })
        .set('Authorization', `Bearer ${auditor_token}`)
        .expect(200);

      expect(res.body).toMatchObject({
        appi_article: 'Article 28',
        data_subject_name,
        requested_by_role: 'auditor',
        requested_by_actor_id: auditor_id,
      });
      expect(typeof res.body.generated_at).toBe('string');
      expect(res.body.record_count).toBe(3);
      expect(Array.isArray(res.body.records)).toBe(true);
      expect(res.body.records).toHaveLength(3);

      // Two reporter-side records, one witness-only.
      const by_appearance = res.body.records.reduce(
        (acc: Record<string, number>, r: { appearance: string }) => {
          acc[r.appearance] = (acc[r.appearance] ?? 0) + 1;
          return acc;
        },
        {},
      );
      expect(by_appearance.reporter).toBe(2);
      expect(by_appearance.witness).toBe(1);

      // Reporter-side record contains decrypted special-care PII.
      const reporter_record = res.body.records.find(
        (r: { claim_id: string }) => r.claim_id === claim_reporter_1_id,
      );
      expect(reporter_record).toBeDefined();
      expect(reporter_record.appearance).toBe('reporter');
      expect(reporter_record.reporter_name).toBe(data_subject_name);
      expect(reporter_record.reporter_phone).toBe('090-1111-2222');
      expect(reporter_record.reporter_email).toBe('yamada.taro@example.jp');
      expect(reporter_record.insured_government_id).toBe('123456789012');
      expect(reporter_record.bank_account_for_payout).toBe(
        'MUFG-001-1234567',
      );
      expect(reporter_record.injury_details).toBe(
        'Whiplash, cervical strain.',
      );
      expect(reporter_record.loss_location).toEqual({
        prefecture: '東京都',
        postal_code: '100-0001',
        detail: '千代田区千代田1-1',
      });

      // Reporter-side witness statements filter to the subject
      // only — the 田中 一郎 witness must not appear.
      expect(Array.isArray(reporter_record.witness_statements)).toBe(true);
      for (const w of reporter_record.witness_statements) {
        expect(w.witness_name).toBe(data_subject_name);
      }
    });

    it('witness-only appearance does not leak the third-party reporter PII', async () => {
      const res = await request(app.getHttpServer())
        .get(`/claims/${claim_witness_only_id}/data-subject-export`)
        .query({ data_subject_name })
        .set('Authorization', `Bearer ${auditor_token}`)
        .expect(200);

      const witness_record = res.body.records.find(
        (r: { claim_id: string; appearance: string }) =>
          r.claim_id === claim_witness_only_id && r.appearance === 'witness',
      );
      expect(witness_record).toBeDefined();

      // The reporter on this claim is 佐藤 花子 — none of her
      // PII may appear in 山田 太郎's export.
      expect(witness_record.reporter_name).toBeNull();
      expect(witness_record.reporter_phone).toBeNull();
      expect(witness_record.reporter_email).toBeNull();
      expect(witness_record.insured_government_id).toBeNull();
      expect(witness_record.bank_account_for_payout).toBeNull();
      expect(witness_record.injury_details).toBeNull();
      expect(witness_record.loss_location).toBeNull();

      // The subject's own witness statement is present and
      // decrypted.
      expect(witness_record.witness_statements).toHaveLength(1);
      expect(witness_record.witness_statements[0].witness_name).toBe(
        data_subject_name,
      );
      expect(witness_record.witness_statements[0].witness_phone).toBe(
        '090-1111-2222',
      );
    });

    it('manager role is permitted to pull a data-subject export', async () => {
      const res = await request(app.getHttpServer())
        .get(`/claims/${claim_reporter_1_id}/data-subject-export`)
        .query({ data_subject_name })
        .set('Authorization', `Bearer ${manager_token}`)
        .expect(200);

      expect(res.body.requested_by_role).toBe('manager');
      expect(res.body.record_count).toBe(3);
    });

    // ── Auth-denied path ──────────────────────────────────
    it('rejects an adjuster with 403', async () => {
      await request(app.getHttpServer())
        .get(`/claims/${claim_reporter_1_id}/data-subject-export`)
        .query({ data_subject_name })
        .set('Authorization', `Bearer ${adjuster_token}`)
        .expect(403);
    });

    it('rejects an agent with 403', async () => {
      await request(app.getHttpServer())
        .get(`/claims/${claim_reporter_1_id}/data-subject-export`)
        .query({ data_subject_name })
        .set('Authorization', `Bearer ${agent_token}`)
        .expect(403);
    });

    it('rejects an unauthenticated request with 401', async () => {
      await request(app.getHttpServer())
        .get(`/claims/${claim_reporter_1_id}/data-subject-export`)
        .query({ data_subject_name })
        .expect(401);
    });

    // ── Validation failure ────────────────────────────────
    it('rejects an empty data_subject_name with 400', async () => {
      const res = await request(app.getHttpServer())
        .get(`/claims/${claim_reporter_1_id}/data-subject-export`)
        .query({ data_subject_name: '   ' })
        .set('Authorization', `Bearer ${auditor_token}`)
        .expect(400);

      expect(res.body).toBeDefined();
    });

    it('rejects a missing data_subject_name with 400', async () => {
      await request(app.getHttpServer())
        .get(`/claims/${claim_reporter_1_id}/data-subject-export`)
        .set('Authorization', `Bearer ${auditor_token}`)
        .expect(400);
    });
  });

  // ─────────────────────────────────────────────────────────
  // Anonymise — Track A gate (no role authorised)
  // ─────────────────────────────────────────────────────────

  describe('DELETE /claims/:id/personal-data-anonymise — Track A gate', () => {
    const valid_body = {
      reason:
        'Data subject erasure request received via legal channel; verified.',
      data_subject_name,
      appi_request_reference: 'APPI-TEST-0001',
      acknowledge_irreversible: true,
    };

    it('rejects a manager with 403 (Track A enables no role)', async () => {
      await request(app.getHttpServer())
        .delete(`/claims/${claim_reporter_1_id}/personal-data-anonymise`)
        .set('Authorization', `Bearer ${manager_token}`)
        .send(valid_body)
        .expect(403);
    });

    it('rejects an auditor with 403', async () => {
      await request(app.getHttpServer())
        .delete(`/claims/${claim_reporter_1_id}/personal-data-anonymise`)
        .set('Authorization', `Bearer ${auditor_token}`)
        .send(valid_body)
        .expect(403);
    });

    it('rejects an adjuster with 403', async () => {
      await request(app.getHttpServer())
        .delete(`/claims/${claim_reporter_1_id}/personal-data-anonymise`)
        .set('Authorization', `Bearer ${adjuster_token}`)
        .send(valid_body)
        .expect(403);
    });

    it('rejects an unauthenticated request with 401', async () => {
      await request(app.getHttpServer())
        .delete(`/claims/${claim_reporter_1_id}/personal-data-anonymise`)
        .send(valid_body)
        .expect(401);
    });

    it('confirms the claim PII is still intact after the gate rejects (no partial side-effects)', async () => {
      const claim = await prisma.claim.findUnique({
        where: { id: claim_reporter_1_id },
      });
      expect(claim).not.toBeNull();
      expect(claim!.reporter_name).toBe(data_subject_name);
      expect(claim!.reporter_phone_ct).not.toBeNull();
      expect(claim!.insured_government_id_ct).not.toBeNull();
    });
  });
});