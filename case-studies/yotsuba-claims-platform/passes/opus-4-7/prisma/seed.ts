// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// Prisma seed script.
//
// Populates the database with the cast of users and a representative
// portfolio of claims required by the brief's acceptance criteria:
//
//   * 1 admin-tier manager (also a claims-director)
//   * 2 plain managers (one of whom is a claims-director, plus a third
//     manager flagged as claims-director — yielding 3 director-capable
//     managers in total per AC #4)
//   * 5 adjusters reporting to one of the managers
//   * 1 auditor
//   * 1 SIU referrer
//   * 20 sample claims spanning every IncidentType and every
//     ClaimStatus, with notes / evidence / witnesses / reserves
//     sprinkled across them so the Workbench has something to render.
//
// The script is idempotent: a re-run wipes the existing rows in
// dependency-safe order and reseeds. Run with `npm run prisma:seed`.
// ─────────────────────────────────────────────────────────────────────────

import {
  ApprovalStatus,
  ClaimSeverity,
  ClaimStatus,
  EvidenceKind,
  IncidentType,
  IntakeChannel,
  PrismaClient,
  ReserveCategory,
  UserRole,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';

import { encryptString } from '../src/common/encryption';

const prisma = new PrismaClient();

// ─── helpers ─────────────────────────────────────────────────────────────

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS ?? '12');
const CONSENT_VERSION = process.env.APPI_CONSENT_VERSION ?? 'appi-2024-01';

async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function payloadHash(payload: unknown): string {
  return sha256Hex(JSON.stringify(payload));
}

function yen(amount: number): string {
  // Decimal(15,0) accepts string; we keep yen integral.
  return Math.round(amount).toString();
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

// ─── reset (idempotent re-seed) ──────────────────────────────────────────

async function reset(): Promise<void> {
  // Order matters: child tables first.
  await prisma.auditEvent.deleteMany();
  await prisma.notificationToRegulator.deleteMany();
  await prisma.reserve.deleteMany();
  await prisma.witnessStatement.deleteMany();
  await prisma.evidence.deleteMany();
  await prisma.claimNote.deleteMany();
  await prisma.claim.deleteMany();
  await prisma.user.deleteMany();
}

// ─── users ───────────────────────────────────────────────────────────────

interface SeededUsers {
  admin: { id: string };
  managers: { id: string; username: string }[];
  directors: { id: string; username: string }[]; // subset of managers w/ is_claims_director
  adjusters: { id: string; username: string }[];
  auditor: { id: string };
  siu: { id: string };
  agent: { id: string };
}

async function seedUsers(): Promise<SeededUsers> {
  const defaultPassword = await hashPassword('password123');

  // 1 admin — modelled as a manager with claims-director powers.
  const admin = await prisma.user.create({
    data: {
      username: 'admin',
      password_hash: defaultPassword,
      role: UserRole.manager,
      display_name: 'Admin Manager (管理者)',
      email: 'admin@yotsuba.example.co.jp',
      is_claims_director: true,
    },
  });

  // 2 additional managers; one is also a claims-director → 3 director-capable in total.
  const managerA = await prisma.user.create({
    data: {
      username: 'manager.tanaka',
      password_hash: defaultPassword,
      role: UserRole.manager,
      display_name: '田中 Manager',
      email: 'tanaka@yotsuba.example.co.jp',
      is_claims_director: true,
    },
  });

  const managerB = await prisma.user.create({
    data: {
      username: 'manager.suzuki',
      password_hash: defaultPassword,
      role: UserRole.manager,
      display_name: '鈴木 Manager',
      email: 'suzuki@yotsuba.example.co.jp',
      is_claims_director: true,
    },
  });

  // 5 adjusters, all reporting to managerA so role-scoped reads have data.
  const adjusterSpecs: { username: string; display: string; email: string }[] = [
    { username: 'adjuster.sato', display: '佐藤 Adjuster', email: 'sato@yotsuba.example.co.jp' },
    { username: 'adjuster.ito', display: '伊藤 Adjuster', email: 'ito@yotsuba.example.co.jp' },
    { username: 'adjuster.watanabe', display: '渡辺 Adjuster', email: 'watanabe@yotsuba.example.co.jp' },
    { username: 'adjuster.yamamoto', display: '山本 Adjuster', email: 'yamamoto@yotsuba.example.co.jp' },
    { username: 'adjuster.nakamura', display: '中村 Adjuster', email: 'nakamura@yotsuba.example.co.jp' },
  ];

  const adjusters: { id: string; username: string }[] = [];
  for (const spec of adjusterSpecs) {
    const created = await prisma.user.create({
      data: {
        username: spec.username,
        password_hash: defaultPassword,
        role: UserRole.adjuster,
        display_name: spec.display,
        email: spec.email,
        reports_to_id: managerA.id,
      },
    });
    adjusters.push({ id: created.id, username: created.username });
  }

  // Auditor — read-only across all claims + audit log.
  const auditor = await prisma.user.create({
    data: {
      username: 'auditor.kobayashi',
      password_hash: defaultPassword,
      role: UserRole.auditor,
      display_name: '小林 Auditor',
      email: 'kobayashi@yotsuba.example.co.jp',
    },
  });

  // SIU referrer.
  const siu = await prisma.user.create({
    data: {
      username: 'siu.kato',
      password_hash: defaultPassword,
      role: UserRole.siu_referrer,
      display_name: '加藤 SIU',
      email: 'kato@yotsuba.example.co.jp',
    },
  });

  // Intake agent (call-centre).
  const agent = await prisma.user.create({
    data: {
      username: 'agent.yoshida',
      password_hash: defaultPassword,
      role: UserRole.agent,
      display_name: '吉田 Agent',
      email: 'yoshida@yotsuba.example.co.jp',
    },
  });

  return {
    admin: { id: admin.id },
    managers: [
      { id: admin.id, username: admin.username },
      { id: managerA.id, username: managerA.username },
      { id: managerB.id, username: managerB.username },
    ],
    directors: [
      { id: admin.id, username: admin.username },
      { id: managerA.id, username: managerA.username },
      { id: managerB.id, username: managerB.username },
    ],
    adjusters,
    auditor: { id: auditor.id },
    siu: { id: siu.id },
    agent: { id: agent.id },
  };
}

// ─── claims ──────────────────────────────────────────────────────────────

interface ClaimSpec {
  policy_number: string;
  loss_offset_days: number;
  prefecture: string;
  postal_code: string;
  detail: string;
  channel: IntakeChannel;
  reporter_name: string;
  reporter_phone: string;
  reporter_email: string;
  relation: string;
  incident_type: IncidentType;
  description: string;
  injury: boolean;
  third_party: boolean;
  police_report?: string;
  severity: ClaimSeverity;
  status: ClaimStatus;
  insured_government_id?: string;
  bank_account?: string;
  injury_details?: string;
  assignee_index: number | null; // index into adjusters[]
}

// 20 claims — covers all 7 IncidentType values and all 7 ClaimStatus values
// at least once. Indices 0..6 ensure every IncidentType appears; the
// status spread is engineered below in the array.
const CLAIM_SPECS: ClaimSpec[] = [
  {
    policy_number: 'POL-AUTO-0001001',
    loss_offset_days: 14,
    prefecture: '東京都',
    postal_code: '100-0001',
    detail: '千代田区丸の内1-1-1付近',
    channel: IntakeChannel.agent,
    reporter_name: '高橋 一郎',
    reporter_phone: '+81-90-1111-0001',
    reporter_email: 'takahashi.ichiro@example.jp',
    relation: '本人',
    incident_type: IncidentType.auto_collision,
    description: '丸の内交差点での追突事故。前方車両に低速で接触。',
    injury: false,
    third_party: true,
    police_report: 'MPD-2024-001001',
    severity: ClaimSeverity.simple,
    status: ClaimStatus.intake,
    insured_government_id: '123456789012',
    bank_account: 'MUFG-001-1234567',
    assignee_index: null,
  },
  {
    policy_number: 'POL-AUTO-0001002',
    loss_offset_days: 21,
    prefecture: '大阪府',
    postal_code: '530-0001',
    detail: '北区梅田2-2-2',
    channel: IntakeChannel.mobile,
    reporter_name: '中島 花子',
    reporter_phone: '+81-90-1111-0002',
    reporter_email: 'nakajima.hanako@example.jp',
    relation: '本人',
    incident_type: IncidentType.auto_property_damage,
    description: '駐車場でのドア接触。相手方車両に擦り傷。',
    injury: false,
    third_party: true,
    severity: ClaimSeverity.simple,
    status: ClaimStatus.under_investigation,
    insured_government_id: '234567890123',
    bank_account: 'SMBC-002-2345678',
    assignee_index: 0,
  },
  {
    policy_number: 'POL-FIRE-0002001',
    loss_offset_days: 30,
    prefecture: '神奈川県',
    postal_code: '220-0011',
    detail: '横浜市西区高島1-1-1',
    channel: IntakeChannel.agent,
    reporter_name: '小川 真一',
    reporter_phone: '+81-90-2222-0003',
    reporter_email: 'ogawa.shinichi@example.jp',
    relation: '本人',
    incident_type: IncidentType.fire_residential,
    description: '台所からの出火。キッチン周辺に焼損。',
    injury: true,
    third_party: false,
    severity: ClaimSeverity.complex,
    status: ClaimStatus.awaiting_reserve_approval,
    insured_government_id: '345678901234',
    bank_account: 'Mizuho-003-3456789',
    injury_details: '軽度の火傷(第一度)、左手の甲。',
    assignee_index: 1,
  },
  {
    policy_number: 'POL-FIRE-0002002',
    loss_offset_days: 45,
    prefecture: '愛知県',
    postal_code: '450-0002',
    detail: '名古屋市中村区名駅3-3-3',
    channel: IntakeChannel.broker,
    reporter_name: '株式会社中部商事 担当: 林',
    reporter_phone: '+81-52-333-0004',
    reporter_email: 'hayashi@chubu-shoji.example.jp',
    relation: '代理店',
    incident_type: IncidentType.fire_commercial,
    description: '倉庫内での電気系統からの出火。在庫商品に大規模な焼損。',
    injury: false,
    third_party: false,
    severity: ClaimSeverity.catastrophic,
    status: ClaimStatus.settlement_offered,
    insured_government_id: '456789012345',
    bank_account: 'MUFG-004-4567890',
    assignee_index: 2,
  },
  {
    policy_number: 'POL-MARINE-0003001',
    loss_offset_days: 60,
    prefecture: '兵庫県',
    postal_code: '650-0024',
    detail: '神戸港コンテナターミナル',
    channel: IntakeChannel.email,
    reporter_name: '神戸物流株式会社',
    reporter_phone: '+81-78-444-0005',
    reporter_email: 'claims@kobe-logistics.example.jp',
    relation: '本人',
    incident_type: IncidentType.marine_cargo,
    description: 'コンテナ船からの荷下ろし時の積荷落下。電子機器の損傷。',
    injury: false,
    third_party: true,
    severity: ClaimSeverity.complex,
    status: ClaimStatus.closed_paid,
    insured_government_id: '567890123456',
    bank_account: 'SMBC-005-5678901',
    assignee_index: 3,
  },
  {
    policy_number: 'POL-LIAB-0004001',
    loss_offset_days: 10,
    prefecture: '京都府',
    postal_code: '604-8001',
    detail: '京都市中京区河原町通',
    channel: IntakeChannel.agent,
    reporter_name: '森田 健二',
    reporter_phone: '+81-90-5555-0006',
    reporter_email: 'morita.kenji@example.jp',
    relation: '本人',
    incident_type: IncidentType.liability_premises,
    description: '店舗入口で来店客が転倒。床面の濡れによる滑り。',
    injury: true,
    third_party: true,
    police_report: 'KPP-2024-002001',
    severity: ClaimSeverity.complex,
    status: ClaimStatus.closed_denied,
    insured_government_id: '678901234567',
    bank_account: 'Mizuho-006-6789012',
    injury_details: '右足首捻挫、全治2週間。',
    assignee_index: 4,
  },
  {
    policy_number: 'POL-PA-0005001',
    loss_offset_days: 7,
    prefecture: '福岡県',
    postal_code: '810-0001',
    detail: '福岡市中央区天神2-2-2',
    channel: IntakeChannel.mobile,
    reporter_name: '清水 美咲',
    reporter_phone: '+81-90-6666-0007',
    reporter_email: 'shimizu.misaki@example.jp',
    relation: '家族',
    incident_type: IncidentType.personal_accident,
    description: '自転車での転倒事故。歩道走行中に段差で転倒。',
    injury: true,
    third_party: false,
    severity: ClaimSeverity.simple,
    status: ClaimStatus.reopened,
    insured_government_id: '789012345678',
    bank_account: 'MUFG-007-7890123',
    injury_details: '左腕骨折、ギプス固定中。',
    assignee_index: 0,
  },
  {
    policy_number: 'POL-AUTO-0001003',
    loss_offset_days: 3,
    prefecture: '北海道',
    postal_code: '060-0001',
    detail: '札幌市中央区北一条西2-2',
    channel: IntakeChannel.agent,
    reporter_name: '近藤 太郎',
    reporter_phone: '+81-90-7777-0008',
    reporter_email: 'kondo.taro@example.jp',
    relation: '本人',
    incident_type: IncidentType.auto_collision,
    description: '凍結路面でのスリップによる単独事故。ガードレールに接触。',
    injury: false,
    third_party: false,
    severity: ClaimSeverity.simple,
    status: ClaimStatus.intake,
    assignee_index: null,
  },
  {
    policy_number: 'POL-AUTO-0001004',
    loss_offset_days: 28,
    prefecture: '宮城県',
    postal_code: '980-0011',
    detail: '仙台市青葉区上杉1-1-1',
    channel: IntakeChannel.broker,
    reporter_name: '東北モーターズ代理店',
    reporter_phone: '+81-22-888-0009',
    reporter_email: 'broker@tohoku-motors.example.jp',
    relation: '代理店',
    incident_type: IncidentType.auto_property_damage,
    description: 'バック走行時に塀へ衝突。フェンスと車両右後部に損傷。',
    injury: false,
    third_party: true,
    severity: ClaimSeverity.simple,
    status: ClaimStatus.under_investigation,
    assignee_index: 1,
  },
  {
    policy_number: 'POL-FIRE-0002003',
    loss_offset_days: 90,
    prefecture: '広島県',
    postal_code: '730-0011',
    detail: '広島市中区基町10-1',
    channel: IntakeChannel.agent,
    reporter_name: '岡田 三郎',
    reporter_phone: '+81-90-9999-0010',
    reporter_email: 'okada.saburo@example.jp',
    relation: '本人',
    incident_type: IncidentType.fire_residential,
    description: '隣家からの延焼により住宅外壁に焼損被害。',
    injury: false,
    third_party: true,
    severity: ClaimSeverity.complex,
    status: ClaimStatus.awaiting_reserve_approval,
    insured_government_id: '890123456789',
    assignee_index: 2,
  },
  {
    policy_number: 'POL-FIRE-0002004',
    loss_offset_days: 120,
    prefecture: '静岡県',
    postal_code: '420-0851',
    detail: '静岡市葵区黒金町',
    channel: IntakeChannel.email,
    reporter_name: '静岡製造株式会社',
    reporter_phone: '+81-54-101-0011',
    reporter_email: 'claims@shizuoka-mfg.example.jp',
    relation: '本人',
    incident_type: IncidentType.fire_commercial,
    description: '工場機械からの火災。生産ライン半分が焼損。',
    injury: true,
    third_party: false,
    severity: ClaimSeverity.catastrophic,
    status: ClaimStatus.settlement_offered,
    insured_government_id: '901234567890',
    bank_account: 'MUFG-011-1011011',
    injury_details: '作業員2名が煙吸引で病院搬送、軽傷。',
    assignee_index: 3,
  },
  {
    policy_number: 'POL-MARINE-0003002',
    loss_offset_days: 75,
    prefecture: '長崎県',
    postal_code: '850-0921',
    detail: '長崎港出島埠頭',
    channel: IntakeChannel.broker,
    reporter_name: '九州海運代理店',
    reporter_phone: '+81-95-202-0012',
    reporter_email: 'broker@kyushu-marine.example.jp',
    relation: '代理店',
    incident_type: IncidentType.marine_cargo,
    description: '荒天により積荷の一部が海水濡損。',
    injury: false,
    third_party: false,
    severity: ClaimSeverity.complex,
    status: ClaimStatus.closed_paid,
    assignee_index: 4,
  },
  {
    policy_number: 'POL-LIAB-0004002',
    loss_offset_days: 18,
    prefecture: '埼玉県',
    postal_code: '330-0001',
    detail: 'さいたま市大宮区桜木町1-1',
    channel: IntakeChannel.agent,
    reporter_name: '藤田 良子',
    reporter_phone: '+81-90-303-0013',
    reporter_email: 'fujita.ryoko@example.jp',
    relation: '本人',
    incident_type: IncidentType.liability_premises,
    description: '店内陳列棚の落下による顧客負傷。',
    injury: true,
    third_party: true,
    severity: ClaimSeverity.complex,
    status: ClaimStatus.under_investigation,
    insured_government_id: '012345678901',
    injury_details: '頭部打撲、念のため検査入院1泊。',
    assignee_index: 0,
  },
  {
    policy_number: 'POL-PA-0005002',
    loss_offset_days: 5,
    prefecture: '千葉県',
    postal_code: '260-0013',
    detail: '千葉市中央区中央2-2-2',
    channel: IntakeChannel.mobile,
    reporter_name: '石川 純',
    reporter_phone: '+81-90-404-0014',
    reporter_email: 'ishikawa.jun@example.jp',
    relation: '本人',
    incident_type: IncidentType.personal_accident,
    description: '階段からの転落。',
    injury: true,
    third_party: false,
    severity: ClaimSeverity.simple,
    status: ClaimStatus.intake,
    assignee_index: null,
  },
  {
    policy_number: 'POL-AUTO-0001005',
    loss_offset_days: 50,
    prefecture: '岐阜県',
    postal_code: '500-8856',
    detail: '岐阜市橋本町1-1',
    channel: IntakeChannel.agent,
    reporter_name: '長谷川 浩',
    reporter_phone: '+81-90-505-0015',
    reporter_email: 'hasegawa.hiroshi@example.jp',
    relation: '事故相手方',
    incident_type: IncidentType.auto_collision,
    description: '高速道路上での多重追突。',
    injury: true,
    third_party: true,
    police_report: 'GPP-2024-003001',
    severity: ClaimSeverity.catastrophic,
    status: ClaimStatus.awaiting_reserve_approval,
    insured_government_id: '112233445566',
    bank_account: 'SMBC-015-1515015',
    injury_details: 'むち打ち症、頚椎捻挫。通院加療中。',
    assignee_index: 1,
  },
  {
    policy_number: 'POL-AUTO-0001006',
    loss_offset_days: 100,
    prefecture: '新潟県',
    postal_code: '950-0901',
    detail: '新潟市中央区弁天1-1',
    channel: IntakeChannel.email,
    reporter_name: '新潟運輸',
    reporter_phone: '+81-25-606-0016',
    reporter_email: 'claims@niigata-transport.example.jp',
    relation: '本人',
    incident_type: IncidentType.auto_property_damage,
    description: 'トラック横転により道路設備に損傷。',
    injury: false,
    third_party: true,
    severity: ClaimSeverity.complex,
    status: ClaimStatus.closed_paid,
    assignee_index: 2,
  },
  {
    policy_number: 'POL-FIRE-0002005',
    loss_offset_days: 8,
    prefecture: '沖縄県',
    postal_code: '900-0015',
    detail: '那覇市久茂地3-3-3',
    channel: IntakeChannel.agent,
    reporter_name: '比嘉 健太',
    reporter_phone: '+81-90-707-0017',
    reporter_email: 'higa.kenta@example.jp',
    relation: '本人',
    incident_type: IncidentType.fire_residential,
    description: '台風による飛来物起因の小規模火災。',
    injury: false,
    third_party: false,
    severity: ClaimSeverity.simple,
    status: ClaimStatus.under_investigation,
    assignee_index: 3,
  },
  {
    policy_number: 'POL-LIAB-0004003',
    loss_offset_days: 40,
    prefecture: '岡山県',
    postal_code: '700-8544',
    detail: '岡山市北区表町1-1',
    channel: IntakeChannel.broker,
    reporter_name: '岡山商事代理店',
    reporter_phone: '+81-86-808-0018',
    reporter_email: 'broker@okayama-shoji.example.jp',
    relation: '代理店',
    incident_type: IncidentType.liability_premises,
    description: 'エレベーター故障による顧客一時閉じ込め。',
    injury: false,
    third_party: true,
    severity: ClaimSeverity.simple,
    status: ClaimStatus.settlement_offered,
    assignee_index: 4,
  },
  {
    policy_number: 'POL-PA-0005003',
    loss_offset_days: 200,
    prefecture: '熊本県',
    postal_code: '860-0805',
    detail: '熊本市中央区桜町1-1',
    channel: IntakeChannel.agent,
    reporter_name: '松本 さくら',
    reporter_phone: '+81-90-909-0019',
    reporter_email: 'matsumoto.sakura@example.jp',
    relation: '本人',
    incident_type: IncidentType.personal_accident,
    description: '山岳ハイキング中の転倒事故。',
    injury: true,
    third_party: false,
    severity: ClaimSeverity.complex,
    status: ClaimStatus.closed_denied,
    insured_government_id: '223344556677',
    injury_details: '右膝靭帯損傷、手術済み。',
    assignee_index: 0,
  },
  {
    policy_number: 'POL-MARINE-0003003',
    loss_offset_days: 35,
    prefecture: '香川県',
    postal_code: '760-0011',
    detail: '高松市浜ノ町8-1',
    channel: IntakeChannel.email,
    reporter_name: '瀬戸内海運',
    reporter_phone: '+81-87-010-0020',
    reporter_email: 'claims@setouchi-marine.example.jp',
    relation: '本人',
    incident_type: IncidentType.marine_cargo,
    description: '内航船のコンテナ移動中の積荷破損。',
    injury: false,
    third_party: false,
    severity: ClaimSeverity.simple,
    status: ClaimStatus.reopened,
    assignee_index: 1,
  },
];

async function seedClaims(users: SeededUsers): Promise<{ id: string; spec: ClaimSpec }[]> {
  const created: { id: string; spec: ClaimSpec }[] = [];

  for (const spec of CLAIM_SPECS) {
    const lossDate = daysAgo(spec.loss_offset_days);
    const consentAt = new Date(lossDate.getTime() + 60 * 60 * 1000); // +1h

    const assignee =
      spec.assignee_index === null ? null : users.adjusters[spec.assignee_index] ?? null;

    const claim = await prisma.claim.create({
      data: {
        policy_number: spec.policy_number,
        loss_date: lossDate,
        loss_location_prefecture: spec.prefecture,
        loss_location_postal_code: spec.postal_code,
        loss_location_detail: spec.detail,
        reported_by_channel: spec.channel,
        reporter_name: spec.reporter_name,
        reporter_phone_ct: encryptString(spec.reporter_phone),
        reporter_email_ct: encryptString(spec.reporter_email),
        reporter_relation_to_insured: spec.relation,
        incident_type: spec.incident_type,
        initial_description: spec.description,
        injury_reported: spec.injury,
        third_party_involved: spec.third_party,
        police_report_number: spec.police_report,
        severity_initial: spec.severity,
        status: spec.status,
        appi_consent_version: CONSENT_VERSION,
        appi_consent_at: consentAt,
        assigned_adjuster_id: assignee?.id ?? null,
        insured_government_id_ct: spec.insured_government_id
          ? encryptString(spec.insured_government_id)
          : null,
        bank_account_for_payout_ct: spec.bank_account ? encryptString(spec.bank_account) : null,
        injury_details_ct: spec.injury_details ? encryptString(spec.injury_details) : null,
      },
    });

    created.push({ id: claim.id, spec });

    // ── audit: claim.created ─────────────────────────────────────────────
    await prisma.auditEvent.create({
      data: {
        actor_id: users.agent.id,
        actor_role: UserRole.agent,
        action: 'claim.created',
        claim_id: claim.id,
        target_id: claim.id,
        payload_hash: payloadHash({
          policy_number: spec.policy_number,
          channel: spec.channel,
          incident_type: spec.incident_type,
        }),
        request_id: `seed-req-${randomBytes(6).toString('hex')}`,
        correlation_id: `seed-corr-${randomBytes(6).toString('hex')}`,
      },
    });

    // ── audit: claim.assigned (if applicable) ────────────────────────────
    if (assignee) {
      await prisma.auditEvent.create({
        data: {
          actor_id: users.managers[1].id, // managerA
          actor_role: UserRole.manager,
          action: 'claim.assigned',
          claim_id: claim.id,
          target_id: assignee.id,
          payload_hash: payloadHash({ assignee_id: assignee.id }),
          request_id: `seed-req-${randomBytes(6).toString('hex')}`,
          correlation_id: `seed-corr-${randomBytes(6).toString('hex')}`,
        },
      });
    }
  }

  return created;
}

// ─── notes / evidence / witnesses / reserves ─────────────────────────────

async function seedChildren(
  users: SeededUsers,
  claims: { id: string; spec: ClaimSpec }[],
): Promise<void> {
  for (let i = 0; i < claims.length; i++) {
    const { id: claimId, spec } = claims[i];
    const assignee =
      spec.assignee_index === null ? null : users.adjusters[spec.assignee_index] ?? null;

    // Notes — every claim past intake gets at least one note from its adjuster.
    if (assignee && spec.status !== ClaimStatus.intake) {
      await prisma.claimNote.create({
        data: {
          claim_id: claimId,
          author_id: assignee.id,
          body: `初回調査メモ: ${spec.description.slice(0, 40)}... — 担当調査を開始しました。`,
        },
      });
      await prisma.auditEvent.create({
        data: {
          actor_id: assignee.id,
          actor_role: UserRole.adjuster,
          action: 'claim.note.added',
          claim_id: claimId,
          payload_hash: payloadHash({ kind: 'initial_investigation' }),
          request_id: `seed-req-${randomBytes(6).toString('hex')}`,
          correlation_id: `seed-corr-${randomBytes(6).toString('hex')}`,
        },
      });
    }

    // Evidence — every other progressed claim gets a photo + a document.
    if (assignee && i % 2 === 0 && spec.status !== ClaimStatus.intake) {
      const photoBlob = `seed-photo-${i}-${spec.policy_number}`;
      const docBlob = `seed-doc-${i}-${spec.policy_number}`;
      await prisma.evidence.create({
        data: {
          claim_id: claimId,
          kind: EvidenceKind.photo,
          content_hash: sha256Hex(photoBlob),
          blob_ref: `s3://stub/${photoBlob}.jpg`,
          uploaded_by_id: assignee.id,
        },
      });
      await prisma.evidence.create({
        data: {
          claim_id: claimId,
          kind: EvidenceKind.document,
          content_hash: sha256Hex(docBlob),
          blob_ref: `s3://stub/${docBlob}.pdf`,
          uploaded_by_id: assignee.id,
        },
      });
      await prisma.auditEvent.create({
        data: {
          actor_id: assignee.id,
          actor_role: UserRole.adjuster,
          action: 'claim.evidence.added',
          claim_id: claimId,
          payload_hash: payloadHash({ count: 2 }),
          request_id: `seed-req-${randomBytes(6).toString('hex')}`,
          correlation_id: `seed-corr-${randomBytes(6).toString('hex')}`,
        },
      });
    }

    // Witness — claims with third-party involvement get a witness statement.
    if (assignee && spec.third_party && spec.status !== ClaimStatus.intake) {
      const statementBody = `現場を目撃しました: ${spec.description.slice(0, 30)}...`;
      const recordedAt = new Date();
      const inkanCanonical = `${claimId}|${statementBody}|${recordedAt.toISOString()}`;
      await prisma.witnessStatement.create({
        data: {
          claim_id: claimId,
          witness_name: '目撃者 太郎',
          witness_phone_ct: encryptString('+81-90-0000-9999'),
          statement_body: statementBody,
          inkan_seal_hash: sha256Hex(inkanCanonical),
          recorded_by_id: assignee.id,
          recorded_at: recordedAt,
        },
      });
      await prisma.auditEvent.create({
        data: {
          actor_id: assignee.id,
          actor_role: UserRole.adjuster,
          action: 'claim.witness.recorded',
          claim_id: claimId,
          payload_hash: payloadHash({ kind: 'witness_statement' }),
          request_id: `seed-req-${randomBytes(6).toString('hex')}`,
          correlation_id: `seed-corr-${randomBytes(6).toString('hex')}`,
        },
      });
    }

    // Reserves — every claim past `under_investigation` gets a reserve.
    const reserveBearingStatuses: ClaimStatus[] = [
      ClaimStatus.awaiting_reserve_approval,
      ClaimStatus.settlement_offered,
      ClaimStatus.closed_paid,
      ClaimStatus.closed_denied,
      ClaimStatus.reopened,
    ];
    if (assignee && reserveBearingStatuses.includes(spec.status)) {
      const baseAmount = (() => {
        switch (spec.severity) {
          case ClaimSeverity.simple:
            return 500_000;
          case ClaimSeverity.complex:
            return 5_000_000;
          case ClaimSeverity.catastrophic:
            return 50_000_000;
        }
      })();

      const proposedAmount = baseAmount + i * 100_000;
      const approvalStatus: ApprovalStatus = (() => {
        if (spec.status === ClaimStatus.awaiting_reserve_approval) return ApprovalStatus.pending;
        if (spec.status === ClaimStatus.closed_denied) return ApprovalStatus.rejected;
        return ApprovalStatus.approved;
      })();

      const requiresDirector = proposedAmount > 10_000_000;
      const managerActor = users.managers[1]; // managerA
      const directorActor = users.directors[0]; // admin (also director)

      const reserve = await prisma.reserve.create({
        data: {
          claim_id: claimId,
          category: ReserveCategory.loss_unpaid,
          proposed_yen: yen(proposedAmount),
          prior_yen: null,
          justification: `初期見積もり: ${spec.incident_type} の発生状況および負傷の有無に基づく標準的な引当額の算定。詳細調査結果を踏まえ再評価予定。`,
          proposed_by_id: assignee.id,
          approval_status: approvalStatus,
          approved_by_id:
            approvalStatus === ApprovalStatus.approved || approvalStatus === ApprovalStatus.rejected
              ? managerActor.id
              : null,
          approved_at:
            approvalStatus === ApprovalStatus.approved || approvalStatus === ApprovalStatus.rejected
              ? new Date()
              : null,
          director_approved_by_id:
            approvalStatus === ApprovalStatus.approved && requiresDirector ? directorActor.id : null,
          director_approved_at:
            approvalStatus === ApprovalStatus.approved && requiresDirector ? new Date() : null,
          reason_for_rejection:
            approvalStatus === ApprovalStatus.rejected
              ? '提出された justification が裏付資料不足のため差し戻し。'
              : null,
        },
      });

      await prisma.auditEvent.create({
        data: {
          actor_id: assignee.id,
          actor_role: UserRole.adjuster,
          action: 'reserve.proposed',
          claim_id: claimId,
          target_id: reserve.id,
          payload_hash: payloadHash({
            category: ReserveCategory.loss_unpaid,
            proposed_yen: proposedAmount,
          }),
          request_id: `seed-req-${randomBytes(6).toString('hex')}`,
          correlation_id: `seed-corr-${randomBytes(6).toString('hex')}`,
        },
      });

      if (approvalStatus === ApprovalStatus.approved) {
        await prisma.auditEvent.create({
          data: {
            actor_id: managerActor.id,
            actor_role: UserRole.manager,
            action: 'reserve.approved',
            claim_id: claimId,
            target_id: reserve.id,
            payload_hash: payloadHash({ approved_yen: proposedAmount }),
            request_id: `seed-req-${randomBytes(6).toString('hex')}`,
            correlation_id: `seed-corr-${randomBytes(6).toString('hex')}`,
          },
        });
        if (requiresDirector) {
          await prisma.auditEvent.create({
            data: {
              actor_id: directorActor.id,
              actor_role: UserRole.manager,
              action: 'reserve.director_approved',
              claim_id: claimId,
              target_id: reserve.id,
              payload_hash: payloadHash({ director_approved_yen: proposedAmount }),
              request_id: `seed-req-${randomBytes(6).toString('hex')}`,
              correlation_id: `seed-corr-${randomBytes(6).toString('hex')}`,
            },
          });
        }
      } else if (approvalStatus === ApprovalStatus.rejected) {
        await prisma.auditEvent.create({
          data: {
            actor_id: managerActor.id,
            actor_role: UserRole.manager,
            action: 'reserve.rejected',
            claim_id: claimId,
            target_id: reserve.id,
            payload_hash: payloadHash({ reason: 'insufficient_justification' }),
            request_id: `seed-req-${randomBytes(6).toString('hex')}`,
            correlation_id: `seed-corr-${randomBytes(6).toString('hex')}`,
          },
        });
      }

      // JFSA threshold notification on any reserve >= ¥100M.
      const jfsaThreshold = Number(process.env.JFSA_RESERVE_THRESHOLD_YEN ?? '100000000');
      if (proposedAmount >= jfsaThreshold) {
        await prisma.notificationToRegulator.create({
          data: {
            kind: 'jfsa_reserve_threshold',
            claim_id: claimId,
            reserve_id: reserve.id,
            amount_yen: yen(proposedAmount),
          },
        });
      }
    }
  }
}

// ─── main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('[seed] resetting database...');
  await reset();

  // eslint-disable-next-line no-console
  console.log('[seed] creating users...');
  const users = await seedUsers();

  // eslint-disable-next-line no-console
  console.log('[seed] creating claims...');
  const claims = await seedClaims(users);

  // eslint-disable-next-line no-console
  console.log('[seed] creating notes / evidence / witnesses / reserves...');
  await seedChildren(users, claims);

  const counts = {
    users: await prisma.user.count(),
    claims: await prisma.claim.count(),
    notes: await prisma.claimNote.count(),
    evidence: await prisma.evidence.count(),
    witnesses: await prisma.witnessStatement.count(),
    reserves: await prisma.reserve.count(),
    notifications: await prisma.notificationToRegulator.count(),
    audit_events: await prisma.auditEvent.count(),
  };
  // eslint-disable-next-line no-console
  console.log('[seed] done.', counts);
  // eslint-disable-next-line no-console
  console.log(
    '[seed] login credentials: every user has password = "password123". Usernames: admin, manager.tanaka, manager.suzuki, adjuster.sato, adjuster.ito, adjuster.watanabe, adjuster.yamamoto, adjuster.nakamura, auditor.kobayashi, siu.kato, agent.yoshida',
  );
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[seed] failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });