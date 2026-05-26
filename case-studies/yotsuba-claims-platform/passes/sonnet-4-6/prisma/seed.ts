// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// prisma/seed.ts
// Populates: 1 admin(manager), 2 managers, 5 adjusters, 1 auditor,
//            1 siu_referrer, 3 claims-director-able managers,
//            20 sample claims spanning all incident_type + workflow states.
// =============================================================================

import { PrismaClient, UserRole, IntakeChannel, IncidentType, ClaimSeverity, ClaimStatus, ReserveCategory, ApprovalStatus, EvidenceKind } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function hash(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function fakeEncrypted(plaintext: string): Buffer {
  // In POC: store a deterministic fake encrypted blob.
  // Production would use encryption.ts AES-256-GCM.
  const prefix = Buffer.from('FAKE_ENC:');
  const payload = Buffer.from(plaintext, 'utf8');
  return Buffer.concat([prefix, payload]);
}

function randomDate(from: Date, to: Date): Date {
  const diff = to.getTime() - from.getTime();
  return new Date(from.getTime() + Math.random() * diff);
}

const POLICY_EFFECTIVE_DATE = new Date('2023-01-01T00:00:00Z');
const POLICY_EXPIRY_DATE    = new Date('2025-12-31T23:59:59Z');

// All 47 prefectures — used for validation parity with the API
const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
  '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];

function prefecture(i: number): string {
  return PREFECTURES[i % PREFECTURES.length];
}

// ---------------------------------------------------------------------------
// Main seed
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('🌱  Seeding Yotsuba Claims Platform...');

  // ── 0. clean slate (order matters for FK constraints) ──────────────────────
  await prisma.notificationToRegulator.deleteMany();
  await prisma.auditEvent.deleteMany();
  await prisma.reserve.deleteMany();
  await prisma.witnessStatement.deleteMany();
  await prisma.evidence.deleteMany();
  await prisma.claimNote.deleteMany();
  await prisma.claim.deleteMany();
  await prisma.user.deleteMany();

  // ── 1. Users ───────────────────────────────────────────────────────────────

  // 1a. Admin manager (super manager with director flag)
  const adminManager = await prisma.user.create({
    data: {
      username:          'admin',
      password_hash:     await hash('Admin1234!'),
      role:              UserRole.manager,
      display_name:      'Tanaka Hiroshi (Admin)',
      email:             'admin@yotsuba-ins.example',
      is_claims_director: true,
    },
  });

  // 1b. 3 claims-director-able managers
  const director1 = await prisma.user.create({
    data: {
      username:          'director_suzuki',
      password_hash:     await hash('Director1234!'),
      role:              UserRole.manager,
      display_name:      'Suzuki Kenji (Director)',
      email:             'director.suzuki@yotsuba-ins.example',
      is_claims_director: true,
      reports_to_id:     adminManager.id,
    },
  });

  const director2 = await prisma.user.create({
    data: {
      username:          'director_yamamoto',
      password_hash:     await hash('Director1234!'),
      role:              UserRole.manager,
      display_name:      'Yamamoto Ayako (Director)',
      email:             'director.yamamoto@yotsuba-ins.example',
      is_claims_director: true,
      reports_to_id:     adminManager.id,
    },
  });

  const director3 = await prisma.user.create({
    data: {
      username:          'director_nakamura',
      password_hash:     await hash('Director1234!'),
      role:              UserRole.manager,
      display_name:      'Nakamura Taro (Director)',
      email:             'director.nakamura@yotsuba-ins.example',
      is_claims_director: true,
      reports_to_id:     adminManager.id,
    },
  });

  // 1c. 2 regular managers (not claims-director)
  const manager1 = await prisma.user.create({
    data: {
      username:          'manager_kobayashi',
      password_hash:     await hash('Manager1234!'),
      role:              UserRole.manager,
      display_name:      'Kobayashi Yuki',
      email:             'manager.kobayashi@yotsuba-ins.example',
      is_claims_director: false,
      reports_to_id:     director1.id,
    },
  });

  const manager2 = await prisma.user.create({
    data: {
      username:          'manager_ito',
      password_hash:     await hash('Manager1234!'),
      role:              UserRole.manager,
      display_name:      'Ito Masako',
      email:             'manager.ito@yotsuba-ins.example',
      is_claims_director: false,
      reports_to_id:     director2.id,
    },
  });

  // 1d. 5 adjusters
  const adjuster1 = await prisma.user.create({
    data: {
      username:          'adjuster_sato',
      password_hash:     await hash('Adjuster1234!'),
      role:              UserRole.adjuster,
      display_name:      'Sato Ryo',
      email:             'adjuster.sato@yotsuba-ins.example',
      reports_to_id:     manager1.id,
    },
  });

  const adjuster2 = await prisma.user.create({
    data: {
      username:          'adjuster_watanabe',
      password_hash:     await hash('Adjuster1234!'),
      role:              UserRole.adjuster,
      display_name:      'Watanabe Nao',
      email:             'adjuster.watanabe@yotsuba-ins.example',
      reports_to_id:     manager1.id,
    },
  });

  const adjuster3 = await prisma.user.create({
    data: {
      username:          'adjuster_kato',
      password_hash:     await hash('Adjuster1234!'),
      role:              UserRole.adjuster,
      display_name:      'Kato Shingo',
      email:             'adjuster.kato@yotsuba-ins.example',
      reports_to_id:     manager2.id,
    },
  });

  const adjuster4 = await prisma.user.create({
    data: {
      username:          'adjuster_tanaka',
      password_hash:     await hash('Adjuster1234!'),
      role:              UserRole.adjuster,
      display_name:      'Tanaka Miki',
      email:             'adjuster.tanaka@yotsuba-ins.example',
      reports_to_id:     manager2.id,
    },
  });

  const adjuster5 = await prisma.user.create({
    data: {
      username:          'adjuster_inoue',
      password_hash:     await hash('Adjuster1234!'),
      role:              UserRole.adjuster,
      display_name:      'Inoue Kenji',
      email:             'adjuster.inoue@yotsuba-ins.example',
      reports_to_id:     director3.id,
    },
  });

  // 1e. 1 auditor
  const auditor = await prisma.user.create({
    data: {
      username:          'auditor_hayashi',
      password_hash:     await hash('Auditor1234!'),
      role:              UserRole.auditor,
      display_name:      'Hayashi Tomoko (Auditor)',
      email:             'auditor.hayashi@yotsuba-ins.example',
    },
  });

  // 1f. 1 SIU referrer
  const siuReferrer = await prisma.user.create({
    data: {
      username:          'siu_matsumoto',
      password_hash:     await hash('SIU1234!'),
      role:              UserRole.siu_referrer,
      display_name:      'Matsumoto Daisuke (SIU)',
      email:             'siu.matsumoto@yotsuba-ins.example',
    },
  });

  // 1g. 1 agent (for FNOL intake)
  const agent1 = await prisma.user.create({
    data: {
      username:          'agent_kimura',
      password_hash:     await hash('Agent1234!'),
      role:              UserRole.agent,
      display_name:      'Kimura Hanako',
      email:             'agent.kimura@yotsuba-ins.example',
    },
  });

  console.log('✅  Users created:', {
    adminManager: adminManager.username,
    directors: [director1.username, director2.username, director3.username],
    managers:  [manager1.username, manager2.username],
    adjusters: [adjuster1.username, adjuster2.username, adjuster3.username, adjuster4.username, adjuster5.username],
    auditor:   auditor.username,
    siu:       siuReferrer.username,
    agent:     agent1.username,
  });

  // ── 2. Sample claims (20) spanning all incident_type + all ClaimStatus ──────
  //
  // Incident types (7):  auto_collision, auto_property_damage, fire_residential,
  //                      fire_commercial, marine_cargo, liability_premises, personal_accident
  // Statuses     (7):   intake, under_investigation, awaiting_reserve_approval,
  //                      settlement_offered, closed_paid, closed_denied, reopened
  // Channels     (4):   agent, mobile, broker, email
  //
  // Distribution:
  //   Claims 1–7   → each incident_type once, status cycling
  //   Claims 8–14  → repeat incident_type cycle, status cycling differently
  //   Claims 15–20 → mixed, ensuring all statuses appear at least twice

  const INCIDENT_TYPES: IncidentType[] = [
    IncidentType.auto_collision,
    IncidentType.auto_property_damage,
    IncidentType.fire_residential,
    IncidentType.fire_commercial,
    IncidentType.marine_cargo,
    IncidentType.liability_premises,
    IncidentType.personal_accident,
  ];

  const STATUSES: ClaimStatus[] = [
    ClaimStatus.intake,
    ClaimStatus.under_investigation,
    ClaimStatus.awaiting_reserve_approval,
    ClaimStatus.settlement_offered,
    ClaimStatus.closed_paid,
    ClaimStatus.closed_denied,
    ClaimStatus.reopened,
  ];

  const CHANNELS: IntakeChannel[] = [
    IntakeChannel.agent,
    IntakeChannel.mobile,
    IntakeChannel.broker,
    IntakeChannel.email,
  ];

  const SEVERITIES: ClaimSeverity[] = [
    ClaimSeverity.simple,
    ClaimSeverity.complex,
    ClaimSeverity.catastrophic,
  ];

  const RELATIONS = ['本人', '家族', '代理店', '事故相手方'];

  const ADJUSTERS = [adjuster1, adjuster2, adjuster3, adjuster4, adjuster5];

  interface ClaimSeed {
    incidentType: IncidentType;
    status: ClaimStatus;
    channel: IntakeChannel;
    severity: ClaimSeverity;
    adjusterIdx: number | null;
    injuryReported: boolean;
    thirdPartyInvolved: boolean;
    policeReportNumber: string | null;
    lossAmountHint: string;
    prefectureIdx: number;
    descriptionSuffix: string;
  }

  const CLAIM_SEEDS: ClaimSeed[] = [
    // ── Block 1: one per incident_type, cycling statuses ─────────────────────
    {
      incidentType: IncidentType.auto_collision,
      status: ClaimStatus.intake,
      channel: IntakeChannel.agent,
      severity: ClaimSeverity.simple,
      adjusterIdx: null,
      injuryReported: false,
      thirdPartyInvolved: false,
      policeReportNumber: null,
      lossAmountHint: '車両衝突事故。軽微な損傷。',
      prefectureIdx: 12,  // 東京都
      descriptionSuffix: '駐車場内での軽微な接触事故です。',
    },
    {
      incidentType: IncidentType.auto_property_damage,
      status: ClaimStatus.under_investigation,
      channel: IntakeChannel.mobile,
      severity: ClaimSeverity.complex,
      adjusterIdx: 0,
      injuryReported: false,
      thirdPartyInvolved: true,
      policeReportNumber: 'P-2024-001234',
      lossAmountHint: '自動車物損事故。第三者関与。',
      prefectureIdx: 13,  // 神奈川県
      descriptionSuffix: '国道上での追突事故。相手方車両に損傷あり。',
    },
    {
      incidentType: IncidentType.fire_residential,
      status: ClaimStatus.awaiting_reserve_approval,
      channel: IntakeChannel.broker,
      severity: ClaimSeverity.catastrophic,
      adjusterIdx: 1,
      injuryReported: true,
      thirdPartyInvolved: false,
      policeReportNumber: 'P-2024-002345',
      lossAmountHint: '住宅火災。全焼の恐れ。',
      prefectureIdx: 26,  // 大阪府
      descriptionSuffix: '深夜に住宅が出火。1名が軽傷を負った。',
    },
    {
      incidentType: IncidentType.fire_commercial,
      status: ClaimStatus.settlement_offered,
      channel: IntakeChannel.email,
      severity: ClaimSeverity.catastrophic,
      adjusterIdx: 2,
      injuryReported: false,
      thirdPartyInvolved: true,
      policeReportNumber: 'P-2024-003456',
      lossAmountHint: '商業施設火災。営業損害発生。',
      prefectureIdx: 22,  // 愛知県
      descriptionSuffix: '倉庫から出火。隣接建物にも延焼。',
    },
    {
      incidentType: IncidentType.marine_cargo,
      status: ClaimStatus.closed_paid,
      channel: IntakeChannel.agent,
      severity: ClaimSeverity.complex,
      adjusterIdx: 3,
      injuryReported: false,
      thirdPartyInvolved: false,
      policeReportNumber: null,
      lossAmountHint: '海上貨物損害。輸入品濡れ損。',
      prefectureIdx: 39,  // 福岡県
      descriptionSuffix: '輸入コンテナ内の電子部品が海水により損傷。',
    },
    {
      incidentType: IncidentType.liability_premises,
      status: ClaimStatus.closed_denied,
      channel: IntakeChannel.mobile,
      severity: ClaimSeverity.simple,
      adjusterIdx: 4,
      injuryReported: true,
      thirdPartyInvolved: true,
      policeReportNumber: 'P-2024-004567',
      lossAmountHint: '施設賠償。来客転倒事故。',
      prefectureIdx: 6,   // 福島県
      descriptionSuffix: '店舗内で来客が転倒。骨折の申告あり。',
    },
    {
      incidentType: IncidentType.personal_accident,
      status: ClaimStatus.reopened,
      channel: IntakeChannel.broker,
      severity: ClaimSeverity.complex,
      adjusterIdx: 0,
      injuryReported: true,
      thirdPartyInvolved: false,
      policeReportNumber: null,
      lossAmountHint: '傷害事故。労災との重複確認中。',
      prefectureIdx: 3,   // 宮城県
      descriptionSuffix: '工場内作業中に負傷。労災との調整が必要。',
    },
    // ── Block 2: repeat incident_types with different statuses ───────────────
    {
      incidentType: IncidentType.auto_collision,
      status: ClaimStatus.under_investigation,
      channel: IntakeChannel.email,
      severity: ClaimSeverity.catastrophic,
      adjusterIdx: 1,
      injuryReported: true,
      thirdPartyInvolved: true,
      policeReportNumber: 'P-2024-005678',
      lossAmountHint: '高速道路での多重衝突。重傷者あり。',
      prefectureIdx: 10,  // 埼玉県
      descriptionSuffix: '高速道路上で4台が絡む事故。2名が重傷。',
    },
    {
      incidentType: IncidentType.auto_property_damage,
      status: ClaimStatus.awaiting_reserve_approval,
      channel: IntakeChannel.agent,
      severity: ClaimSeverity.simple,
      adjusterIdx: 2,
      injuryReported: false,
      thirdPartyInvolved: false,
      policeReportNumber: null,
      lossAmountHint: '自損事故。ガードレール衝突。',
      prefectureIdx: 19,  // 長野県
      descriptionSuffix: '山道でガードレールに接触。フロントバンパー損傷。',
    },
    {
      incidentType: IncidentType.fire_residential,
      status: ClaimStatus.settlement_offered,
      channel: IntakeChannel.mobile,
      severity: ClaimSeverity.complex,
      adjusterIdx: 3,
      injuryReported: false,
      thirdPartyInvolved: false,
      policeReportNumber: 'P-2024-006789',
      lossAmountHint: '台所火災。部分焼。',
      prefectureIdx: 25,  // 京都府
      descriptionSuffix: '台所からの出火。キッチン周辺が焼損。',
    },
    {
      incidentType: IncidentType.fire_commercial,
      status: ClaimStatus.closed_paid,
      channel: IntakeChannel.broker,
      severity: ClaimSeverity.complex,
      adjusterIdx: 4,
      injuryReported: false,
      thirdPartyInvolved: false,
      policeReportNumber: null,
      lossAmountHint: '事務所火災。電気系統の漏電。',
      prefectureIdx: 1,   // 青森県
      descriptionSuffix: '事務所の電気設備から出火。備品に損害。',
    },
    {
      incidentType: IncidentType.marine_cargo,
      status: ClaimStatus.closed_denied,
      channel: IntakeChannel.email,
      severity: ClaimSeverity.simple,
      adjusterIdx: 0,
      injuryReported: false,
      thirdPartyInvolved: false,
      policeReportNumber: null,
      lossAmountHint: '輸出貨物の盗難申告。証拠不十分。',
      prefectureIdx: 27,  // 兵庫県
      descriptionSuffix: '港湾コンテナヤードでの盗難申告。監視カメラ映像なし。',
    },
    {
      incidentType: IncidentType.liability_premises,
      status: ClaimStatus.reopened,
      channel: IntakeChannel.agent,
      severity: ClaimSeverity.complex,
      adjusterIdx: 1,
      injuryReported: true,
      thirdPartyInvolved: true,
      policeReportNumber: 'P-2024-007890',
      lossAmountHint: '施設賠償再開。追加治療費請求。',
      prefectureIdx: 32,  // 岡山県
      descriptionSuffix: '以前クローズされた施設事故案件が再申告。追加治療費の請求。',
    },
    {
      incidentType: IncidentType.personal_accident,
      status: ClaimStatus.intake,
      channel: IntakeChannel.mobile,
      severity: ClaimSeverity.simple,
      adjusterIdx: null,
      injuryReported: true,
      thirdPartyInvolved: false,
      policeReportNumber: null,
      lossAmountHint: 'スポーツ中の骨折。',
      prefectureIdx: 46,  // 沖縄県
      descriptionSuffix: 'マリンスポーツ中に転倒。左腕骨折の診断。',
    },
    // ── Block 3: ensure all statuses appear at least twice ───────────────────
    {
      incidentType: IncidentType.auto_collision,
      status: ClaimStatus.closed_paid,
      channel: IntakeChannel.agent,
      severity: ClaimSeverity.simple,
      adjusterIdx: 2,
      injuryReported: false,
      thirdPartyInvolved: false,
      policeReportNumber: null,
      lossAmountHint: '自動車修理完了。示談成立。',
      prefectureIdx: 11,  // 千葉県
      descriptionSuffix: '交差点での接触事故。修理費の支払い完了。',
    },
    {
      incidentType: IncidentType.fire_residential,
      status: ClaimStatus.intake,
      channel: IntakeChannel.broker,
      severity: ClaimSeverity.catastrophic,
      adjusterIdx: null,
      injuryReported: true,
      thirdPartyInvolved: true,
      policeReportNumber: 'P-2024-008901',
      lossAmountHint: 'アパート火災。複数世帯に被害。',
      prefectureIdx: 5,   // 山形県
      descriptionSuffix: '木造アパートの1階から出火。3世帯が被災。',
    },
    {
      incidentType: IncidentType.marine_cargo,
      status: ClaimStatus.under_investigation,
      channel: IntakeChannel.email,
      severity: ClaimSeverity.complex,
      adjusterIdx: 3,
      injuryReported: false,
      thirdPartyInvolved: false,
      policeReportNumber: null,
      lossAmountHint: '冷蔵コンテナ故障による食品損害。',
      prefectureIdx: 38,  // 高知県
      descriptionSuffix: '冷凍コンテナの温度管理不良。水産物5トンが廃棄。',
    },
    {
      incidentType: IncidentType.liability_premises,
      status: ClaimStatus.settlement_offered,
      channel: IntakeChannel.agent,
      severity: ClaimSeverity.complex,
      adjusterIdx: 4,
      injuryReported: true,
      thirdPartyInvolved: true,
      policeReportNumber: null,
      lossAmountHint: '商業ビル内エレベーター事故。',
      prefectureIdx: 12,  // 東京都
      descriptionSuffix: 'エレベーター扉の誤作動により来客が転倒負傷。',
    },
    {
      incidentType: IncidentType.personal_accident,
      status: ClaimStatus.awaiting_reserve_approval,
      channel: IntakeChannel.mobile,
      severity: ClaimSeverity.catastrophic,
      adjusterIdx: 0,
      injuryReported: true,
      thirdPartyInvolved: false,
      policeReportNumber: 'P-2024-009012',
      lossAmountHint: '業務中の重大事故。後遺障害認定申請中。',
      prefectureIdx: 22,  // 愛知県
      descriptionSuffix: '建設現場での落下事故。脊椎損傷の疑いあり。後遺障害認定手続き中。',
    },
    {
      incidentType: IncidentType.auto_property_damage,
      status: ClaimStatus.closed_denied,
      channel: IntakeChannel.broker,
      severity: ClaimSeverity.simple,
      adjusterIdx: 1,
      injuryReported: false,
      thirdPartyInvolved: false,
      policeReportNumber: null,
      lossAmountHint: 'ひき逃げ被害申告。免責事由該当。',
      prefectureIdx: 33,  // 広島県
      descriptionSuffix: 'ひき逃げ被害の申告。免責条項に該当するため支払不可。',
    },
  ];

  const createdClaims: Array<{ id: string; status: ClaimStatus; adjusterIdx: number | null }> = [];

  for (let i = 0; i < CLAIM_SEEDS.length; i++) {
    const seed = CLAIM_SEEDS[i];
    const policyNum = `YH-${String(2023 + (i % 3)).padStart(4, '0')}-${String(100000 + i).padStart(6, '0')}`;
    const lossDate = randomDate(
      new Date('2024-01-01T00:00:00Z'),
      new Date('2024-11-30T23:59:59Z'),
    );
    const adjuster = seed.adjusterIdx !== null ? ADJUSTERS[seed.adjusterIdx] : null;

    const claim = await prisma.claim.create({
      data: {
        policy_number:               policyNum,
        loss_date:                   lossDate,
        loss_location_prefecture:    prefecture(seed.prefectureIdx),
        loss_location_postal_code:   `${String(100 + seed.prefectureIdx).padStart(3, '0')}-${String(1000 + i).padStart(4, '0')}`,
        loss_location_detail:        `${prefecture(seed.prefectureIdx)}市内 サンプル通り ${i + 1}丁目${i + 1}番地`,
        reported_by_channel:         seed.channel,
        reporter_name:               `申告者 ${i + 1}号`,
        reporter_phone_ct:           fakeEncrypted(`090-${String(1000 + i).padStart(4, '0')}-${String(2000 + i).padStart(4, '0')}`),
        reporter_email_ct:           fakeEncrypted(`reporter${i + 1}@example.jp`),
        reporter_relation_to_insured: RELATIONS[i % RELATIONS.length],
        incident_type:               seed.incidentType,
        initial_description:         `${seed.lossAmountHint} ${seed.descriptionSuffix}`,
        injury_reported:             seed.injuryReported,
        third_party_involved:        seed.thirdPartyInvolved,
        police_report_number:        seed.policeReportNumber,
        severity_initial:            seed.severity,
        status:                      seed.status,
        appi_consent_version:        '2024-01',
        appi_consent_at:             new Date(lossDate.getTime() + 3600_000),
        assigned_adjuster_id:        adjuster?.id ?? null,
        insured_government_id_ct:    fakeEncrypted(`MY-${String(10000000 + i).padStart(8, '0')}`),
        bank_account_for_payout_ct:  fakeEncrypted(`0001-${String(1000000 + i).padStart(7, '0')}`),
        injury_details_ct:           seed.injuryReported
          ? fakeEncrypted(`傷害詳細 claim ${i + 1}: ${seed.descriptionSuffix}`)
          : null,
      },
    });

    createdClaims.push({ id: claim.id, status: seed.status, adjusterIdx: seed.adjusterIdx });

    // Add a note to non-intake claims
    if (seed.status !== ClaimStatus.intake) {
      const noteAuthor = adjuster ?? manager1;
      await prisma.claimNote.create({
        data: {
          claim_id:   claim.id,
          author_id:  noteAuthor.id,
          body:       `初期調査メモ: ${seed.descriptionSuffix} 事案番号 ${claim.id.slice(0, 8)} の調査を開始しました。`,
        },
      });
    }

    // Add evidence to investigation+ claims
    if (
      seed.status === ClaimStatus.under_investigation ||
      seed.status === ClaimStatus.awaiting_reserve_approval ||
      seed.status === ClaimStatus.settlement_offered ||
      seed.status === ClaimStatus.closed_paid ||
      seed.status === ClaimStatus.reopened
    ) {
      const uploader = adjuster ?? adjuster1;
      const evidenceKinds: EvidenceKind[] = [EvidenceKind.photo, EvidenceKind.document];
      for (let e = 0; e < 2; e++) {
        const blobName = `claim-${claim.id}-evidence-${e}.${e === 0 ? 'jpg' : 'pdf'}`;
        await prisma.evidence.create({
          data: {
            claim_id:       claim.id,
            kind:           evidenceKinds[e],
            content_hash:   sha256(`${claim.id}-evidence-${e}-seed`),
            blob_ref:       `s3://yotsuba-claims-evidence/seed/${blobName}`,
            uploaded_by_id: uploader.id,
          },
        });
      }
    }

    // Add witness statement to relevant claims
    if (seed.thirdPartyInvolved && adjuster) {
      const statementBody = `${seed.descriptionSuffix} 目撃者証言: 事故発生時、現場に居合わせ状況を目撃しました。`;
      const sealInput     = `${statementBody}:${claim.id}:${new Date().toISOString()}`;
      await prisma.witnessStatement.create({
        data: {
          claim_id:         claim.id,
          witness_name:     `目撃者 ${i + 1}号`,
          witness_phone_ct: fakeEncrypted(`080-${String(3000 + i).padStart(4, '0')}-${String(4000 + i).padStart(4, '0')}`),
          statement_body:   statementBody,
          inkan_seal_hash:  sha256(sealInput),
          recorded_by_id:   adjuster.id,
        },
      });
    }
  }

  console.log(`✅  ${createdClaims.length} claims created`);

  // ── 3. Reserves ────────────────────────────────────────────────────────────
  //
  // Add reserves to claims in awaiting_reserve_approval, settlement_offered,
  // closed_paid, and reopened states. Vary amounts to exercise all approval tiers.

  const RESERVE_CATEGORIES: ReserveCategory[] = [
    ReserveCategory.loss_paid,
    ReserveCategory.loss_unpaid,
    ReserveCategory.alae,
    ReserveCategory.ulae,
  ];

  // Map of (status -> reserve config)
  const RESERVE_CONFIGS: Partial<Record<ClaimStatus, { yen: string; status: ApprovalStatus; needsDirector: boolean }>> = {
    [ClaimStatus.awaiting_reserve_approval]: { yen: '500000',     status: ApprovalStatus.pending,  needsDirector: false  },
    [ClaimStatus.settlement_offered]:        { yen: '3000000',    status: ApprovalStatus.approved, needsDirector: false  },
    [ClaimStatus.closed_paid]:               { yen: '800000',     status: ApprovalStatus.approved, needsDirector: false  },
    [ClaimStatus.closed_denied]:             { yen: '200000',     status: ApprovalStatus.rejected, needsDirector: false  },
    [ClaimStatus.reopened]:                  { yen: '15000000',   status: ApprovalStatus.approved, needsDirector: true   },
    [ClaimStatus.under_investigation]:       { yen: '120000000',  status: ApprovalStatus.pending,  needsDirector: false  },
  };

  const createdReserves: Array<{ id: string; claimId: string; yen: string; status: ApprovalStatus }> = [];

  for (let i = 0; i < createdClaims.length; i++) {
    const { id: claimId, status, adjusterIdx } = createdClaims[i];
    const config = RESERVE_CONFIGS[status];
    if (!config) continue;

    const proposedBy  = adjusterIdx !== null ? ADJUSTERS[adjusterIdx] : adjuster1;
    const approvedBy  = manager1;
    const directorBy  = director1;
    const cat         = RESERVE_CATEGORIES[i % RESERVE_CATEGORIES.length];
    const justification = `準備金設定理由: ${INCIDENT_TYPES[i % INCIDENT_TYPES.length]} の損害見積もりに基づき、損害額を算定しました。調査結果および現地確認を踏まえて提案します。`;

    const reserve = await prisma.reserve.create({
      data: {
        claim_id:                 claimId,
        category:                 cat,
        proposed_yen:             config.yen,
        prior_yen:                String(Math.floor(Number(config.yen) * 0.8)),
        justification:            justification,
        proposed_by_id:           proposedBy.id,
        approval_status:          config.status,
        approved_by_id:           config.status === ApprovalStatus.approved ? approvedBy.id : null,
        approved_at:              config.status === ApprovalStatus.approved ? new Date() : null,
        director_approved_by_id:  config.needsDirector && config.status === ApprovalStatus.approved ? directorBy.id : null,
        director_approved_at:     config.needsDirector && config.status === ApprovalStatus.approved ? new Date() : null,
        reason_for_rejection:     config.status === ApprovalStatus.rejected ? '提出書類が不十分です。追加資料を提出してください。' : null,
      },
    });

    createdReserves.push({ id: reserve.id, claimId, yen: config.yen, status: config.status });

    // JFSA threshold notification for reserves >= ¥100M
    if (BigInt(config.yen) >= BigInt('100000000')) {
      await prisma.notificationToRegulator.create({
        data: {
          kind:         'jfsa_reserve_threshold',
          claim_id:     claimId,
          reserve_id:   reserve.id,
          amount_yen:   config.yen,
          triggered_at: new Date(),
          sent_at:      null,
        },
      });
      console.log(`  ⚠️   JFSA notification created for reserve ${reserve.id} (¥${config.yen})`);
    }
  }

  console.log(`✅  ${createdReserves.length} reserves created`);

  // ── 4. Audit events ────────────────────────────────────────────────────────
  //
  // Seed representative audit events for each claim creation and key actions.

  const SEED_CORRELATION_ID = 'seed-correlation-0000000000000000';
  const SEED_REQUEST_ID     = 'seed-request-00000000000000000000';

  // Claim created events
  for (let i = 0; i < createdClaims.length; i++) {
    const { id: claimId } = createdClaims[i];
    const actorUser = i < 5 ? agent1 : manager1;
    const payload   = { claimId, action: 'claim.created', seed: true, index: i };

    await prisma.auditEvent.create({
      data: {
        actor_id:       actorUser.id,
        actor_role:     actorUser.role,
        action:         'claim.created',
        claim_id:       claimId,
        target_id:      claimId,
        payload_hash:   sha256(JSON.stringify(payload)),
        request_id:     `${SEED_REQUEST_ID}-${i}`,
        correlation_id: `${SEED_CORRELATION_ID}-${i}`,
      },
    });
  }

  // Reserve proposed events
  for (let i = 0; i < createdReserves.length; i++) {
    const { id: reserveId, claimId } = createdReserves[i];
    const adjuster = ADJUSTERS[i % ADJUSTERS.length];
    const payload  = { reserveId, claimId, action: 'reserve.proposed', seed: true };

    await prisma.auditEvent.create({
      data: {
        actor_id:       adjuster.id,
        actor_role:     adjuster.role,
        action:         'reserve.proposed',
        claim_id:       claimId,
        target_id:      reserveId,
        payload_hash:   sha256(JSON.stringify(payload)),
        request_id:     `${SEED_REQUEST_ID}-res-${i}`,
        correlation_id: `${SEED_CORRELATION_ID}-res-${i}`,
      },
    });
  }

  // Reserve approved events (for approved reserves)
  const approvedReserves = createdReserves.filter(r => r.status === ApprovalStatus.approved);
  for (let i = 0; i < approvedReserves.length; i++) {
    const { id: reserveId, claimId } = approvedReserves[i];
    const payload = { reserveId, claimId, action: 'reserve.approved', seed: true };

    await prisma.auditEvent.create({
      data: {
        actor_id:       manager1.id,
        actor_role:     manager1.role,
        action:         'reserve.approved',
        claim_id:       claimId,
        target_id:      reserveId,
        payload_hash:   sha256(JSON.stringify(payload)),
        request_id:     `${SEED_REQUEST_ID}-appr-${i}`,
        correlation_id: `${SEED_CORRELATION_ID}-appr-${i}`,
      },
    });
  }

  // Login audit event for admin
  await prisma.auditEvent.create({
    data: {
      actor_id:       adminManager.id,
      actor_role:     adminManager.role,
      action:         'auth.login',
      claim_id:       null,
      target_id:      adminManager.id,
      payload_hash:   sha256(JSON.stringify({ actor: adminManager.id, action: 'auth.login', seed: true })),
      request_id:     `${SEED_REQUEST_ID}-login-admin`,
      correlation_id: `${SEED_CORRELATION_ID}-login-admin`,
    },
  });

  const totalAuditEvents = await prisma.auditEvent.count();
  console.log(`✅  ${totalAuditEvents} audit events created`);

  // ── 5. Summary ─────────────────────────────────────────────────────────────
  const userCount    = await prisma.user.count();
  const claimCount   = await prisma.claim.count();
  const reserveCount = await prisma.reserve.count();
  const jfsaCount    = await prisma.notificationToRegulator.count();
  const noteCount    = await prisma.claimNote.count();
  const evidCount    = await prisma.evidence.count();
  const witnessCount = await prisma.witnessStatement.count();

  console.log('\n🎉  Seed complete!');
  console.log(`    Users:                ${userCount}`);
  console.log(`    Claims:               ${claimCount}`);
  console.log(`    Reserves:             ${reserveCount}`);
  console.log(`    JFSA notifications:   ${jfsaCount}`);
  console.log(`    Claim notes:          ${noteCount}`);
  console.log(`    Evidence records:     ${evidCount}`);
  console.log(`    Witness statements:   ${witnessCount}`);
  console.log(`    Audit events:         ${totalAuditEvents}`);
  console.log('\n📋  Login credentials (all roles):');
  console.log('    admin            / Admin1234!      (manager + claims_director)');
  console.log('    director_suzuki  / Director1234!   (manager + claims_director)');
  console.log('    director_yamamoto/ Director1234!   (manager + claims_director)');
  console.log('    director_nakamura/ Director1234!   (manager + claims_director)');
  console.log('    manager_kobayashi/ Manager1234!    (manager)');
  console.log('    manager_ito      / Manager1234!    (manager)');
  console.log('    adjuster_sato    / Adjuster1234!   (adjuster)');
  console.log('    adjuster_watanabe/ Adjuster1234!   (adjuster)');
  console.log('    adjuster_kato    / Adjuster1234!   (adjuster)');
  console.log('    adjuster_tanaka  / Adjuster1234!   (adjuster)');
  console.log('    adjuster_inoue   / Adjuster1234!   (adjuster)');
  console.log('    auditor_hayashi  / Auditor1234!    (auditor)');
  console.log('    siu_matsumoto    / SIU1234!        (siu_referrer)');
  console.log('    agent_kimura     / Agent1234!      (agent)');
}

main()
  .catch((err: unknown) => {
    console.error('❌  Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });