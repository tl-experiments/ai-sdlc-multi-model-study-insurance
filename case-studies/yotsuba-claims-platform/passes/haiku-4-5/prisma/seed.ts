import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

const prisma = new PrismaClient();

// ─── Encryption helper (matches common/encryption.ts pattern) ────────────────
function encryptSpecialCarePII(plaintext: string, kek: string): Buffer {
  const crypto = require('crypto');
  const keyBuffer = Buffer.from(kek, 'base64');
  const iv = randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
  let encrypted = cipher.update(plaintext, 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

// ─── Seed data ──────────────────────────────────────────────────────────────
async function main() {
  console.log('🌱 Seeding Yotsuba Insurance Claims database...');

  // Retrieve encryption key from environment
  const encryptionKek = process.env.ENCRYPTION_KEK || 'your-base64-encoded-32-byte-key-change-this-in-production';
  const appiConsentVersion = process.env.APPI_CONSENT_VERSION || '1.0';

  // ─── Create users ───────────────────────────────────────────────────────
  console.log('  Creating users...');

  const adminUser = await prisma.user.create({
    data: {
      username: 'admin',
      password_hash: await bcrypt.hash('admin123', 10),
      role: 'manager',
      display_name: 'Admin User',
      email: 'admin@yotsuba.example.com',
      is_claims_director: true,
    },
  });

  const manager1 = await prisma.user.create({
    data: {
      username: 'manager_tanaka',
      password_hash: await bcrypt.hash('manager123', 10),
      role: 'manager',
      display_name: '田中 マネージャー',
      email: 'tanaka.manager@yotsuba.example.com',
      is_claims_director: false,
    },
  });

  const manager2 = await prisma.user.create({
    data: {
      username: 'manager_suzuki',
      password_hash: await bcrypt.hash('manager123', 10),
      role: 'manager',
      display_name: '鈴木 マネージャー',
      email: 'suzuki.manager@yotsuba.example.com',
      is_claims_director: true,
    },
  });

  const manager3 = await prisma.user.create({
    data: {
      username: 'manager_yamamoto',
      password_hash: await bcrypt.hash('manager123', 10),
      role: 'manager',
      display_name: '山本 マネージャー',
      email: 'yamamoto.manager@yotsuba.example.com',
      is_claims_director: true,
    },
  });

  const adjuster1 = await prisma.user.create({
    data: {
      username: 'adjuster_ito',
      password_hash: await bcrypt.hash('adjuster123', 10),
      role: 'adjuster',
      display_name: '伊藤 調査員',
      email: 'ito.adjuster@yotsuba.example.com',
      reports_to_id: manager1.id,
    },
  });

  const adjuster2 = await prisma.user.create({
    data: {
      username: 'adjuster_nakamura',
      password_hash: await bcrypt.hash('adjuster123', 10),
      role: 'adjuster',
      display_name: '中村 調査員',
      email: 'nakamura.adjuster@yotsuba.example.com',
      reports_to_id: manager1.id,
    },
  });

  const adjuster3 = await prisma.user.create({
    data: {
      username: 'adjuster_kobayashi',
      password_hash: await bcrypt.hash('adjuster123', 10),
      role: 'adjuster',
      display_name: '小林 調査員',
      email: 'kobayashi.adjuster@yotsuba.example.com',
      reports_to_id: manager2.id,
    },
  });

  const adjuster4 = await prisma.user.create({
    data: {
      username: 'adjuster_watanabe',
      password_hash: await bcrypt.hash('adjuster123', 10),
      role: 'adjuster',
      display_name: '渡辺 調査員',
      email: 'watanabe.adjuster@yotsuba.example.com',
      reports_to_id: manager2.id,
    },
  });

  const adjuster5 = await prisma.user.create({
    data: {
      username: 'adjuster_sato',
      password_hash: await bcrypt.hash('adjuster123', 10),
      role: 'adjuster',
      display_name: '佐藤 調査員',
      email: 'sato.adjuster@yotsuba.example.com',
      reports_to_id: manager3.id,
    },
  });

  const agent = await prisma.user.create({
    data: {
      username: 'agent_yamada',
      password_hash: await bcrypt.hash('agent123', 10),
      role: 'agent',
      display_name: '山田 代理店',
      email: 'yamada.agent@yotsuba.example.com',
    },
  });

  const auditor = await prisma.user.create({
    data: {
      username: 'auditor_kato',
      password_hash: await bcrypt.hash('auditor123', 10),
      role: 'auditor',
      display_name: '加藤 監査役',
      email: 'kato.auditor@yotsuba.example.com',
    },
  });

  const siuReferrer = await prisma.user.create({
    data: {
      username: 'siu_nakano',
      password_hash: await bcrypt.hash('siu123', 10),
      role: 'siu_referrer',
      display_name: '中野 SIU',
      email: 'nakano.siu@yotsuba.example.com',
    },
  });

  console.log('  ✓ Created 11 users (1 admin, 3 managers, 5 adjusters, 1 agent, 1 auditor, 1 SIU referrer)');

  // ─── Create sample claims ────────────────────────────────────────────────
  console.log('  Creating 20 sample claims...');

  const prefectures = ['東京都', '大阪府', '愛知県', '福岡県', '北海道', '京都府', '兵庫県', '埼玉県', '神奈川県', '広島県'];
  const incidentTypes: Array<'auto_collision' | 'auto_property_damage' | 'fire_residential' | 'fire_commercial' | 'marine_cargo' | 'liability_premises' | 'personal_accident'> = [
    'auto_collision',
    'auto_property_damage',
    'fire_residential',
    'fire_commercial',
    'marine_cargo',
    'liability_premises',
    'personal_accident',
  ];
  const channels: Array<'agent' | 'mobile' | 'broker' | 'email'> = ['agent', 'mobile', 'broker', 'email'];
  const severities: Array<'simple' | 'complex' | 'catastrophic'> = ['simple', 'complex', 'catastrophic'];
  const statuses: Array<'intake' | 'under_investigation' | 'awaiting_reserve_approval' | 'settlement_offered' | 'closed_paid' | 'closed_denied' | 'reopened'> = [
    'intake',
    'under_investigation',
    'awaiting_reserve_approval',
    'settlement_offered',
    'closed_paid',
    'closed_denied',
    'reopened',
  ];

  const adjusters = [adjuster1, adjuster2, adjuster3, adjuster4, adjuster5];
  const claims = [];

  for (let i = 0; i < 20; i++) {
    const prefecture = prefectures[i % prefectures.length];
    const incidentType = incidentTypes[i % incidentTypes.length];
    const channel = channels[i % channels.length];
    const severity = severities[i % severities.length];
    const status = statuses[i % statuses.length];
    const assignedAdjuster = adjusters[i % adjusters.length];

    const lossDate = new Date();
    lossDate.setDate(lossDate.getDate() - (i % 30));

    const claim = await prisma.claim.create({
      data: {
        policy_number: `POL-2024-${String(1000 + i).padStart(5, '0')}`,
        loss_date: lossDate,
        loss_location_prefecture: prefecture,
        loss_location_postal_code: `${String(100 + (i % 90)).padStart(3, '0')}-${String(1000 + (i % 9000)).padStart(4, '0')}`,
        loss_location_detail: `${i + 1}-chome, Sample Ward, ${prefecture}`,
        reported_by_channel: channel,
        reporter_name: `Reporter ${i + 1}`,
        reporter_phone_ct: encryptSpecialCarePII(`090-${String(1000 + i).padStart(4, '0')}-${String(5000 + i).padStart(4, '0')}`, encryptionKek),
        reporter_email_ct: encryptSpecialCarePII(`reporter${i + 1}@example.com`, encryptionKek),
        reporter_relation_to_insured: i % 3 === 0 ? '本人' : i % 3 === 1 ? '家族' : '代理店',
        incident_type: incidentType,
        initial_description: `Sample incident description for claim ${i + 1}. This is a detailed description of the loss event.`,
        injury_reported: i % 5 === 0,
        third_party_involved: i % 4 === 0,
        police_report_number: i % 6 === 0 ? `POLICE-${String(2024000 + i).padStart(7, '0')}` : null,
        severity_initial: severity,
        status: status,
        appi_consent_version: appiConsentVersion,
        appi_consent_at: new Date(),
        assigned_adjuster_id: status !== 'intake' ? assignedAdjuster.id : null,
        assigned_at: status !== 'intake' ? new Date(lossDate.getTime() + 86400000) : null,
        assigned_by_id: status !== 'intake' ? manager1.id : null,
        insured_government_id_ct: encryptSpecialCarePII(`${String(12345600000 + i).padStart(11, '0')}`, encryptionKek),
        bank_account_for_payout_ct: encryptSpecialCarePII(`JP0010001000100010001000${String(i).padStart(2, '0')}`, encryptionKek),
        injury_details_ct: i % 5 === 0 ? encryptSpecialCarePII('Minor injuries to left arm and shoulder', encryptionKek) : null,
        created_by_id: agent.id,
      },
    });

    claims.push(claim);
  }

  console.log('  ✓ Created 20 sample claims across all incident types and statuses');

  // ─── Create sample notes ────────────────────────────────────────────────
  console.log('  Creating sample notes...');

  for (let i = 0; i < 10; i++) {
    const claim = claims[i];
    if (claim.assigned_adjuster_id) {
      await prisma.claimNote.create({
        data: {
          claim_id: claim.id,
          author_id: claim.assigned_adjuster_id,
          body: `Investigation note ${i + 1}: Initial assessment completed. Awaiting further documentation from claimant.`,
        },
      });
    }
  }

  console.log('  ✓ Created 10 sample notes');

  // ─── Create sample evidence ─────────────────────────────────────────────
  console.log('  Creating sample evidence...');

  for (let i = 0; i < 8; i++) {
    const claim = claims[i];
    if (claim.assigned_adjuster_id) {
      const kinds: Array<'photo' | 'document' | 'audio' | 'video' | 'witness_statement_attachment'> = ['photo', 'document', 'audio', 'video', 'witness_statement_attachment'];
      await prisma.evidence.create({
        data: {
          claim_id: claim.id,
          kind: kinds[i % kinds.length],
          content_hash: `sha256_${String(i).padStart(64, '0')}`,
          blob_ref: `s3://yotsuba-claims-evidence/claim-${claim.id}/evidence-${i}`,
          uploaded_by_id: claim.assigned_adjuster_id,
        },
      });
    }
  }

  console.log('  ✓ Created 8 sample evidence records');

  // ─── Create sample witness statements ────────────────────────────────────
  console.log('  Creating sample witness statements...');

  for (let i = 0; i < 6; i++) {
    const claim = claims[i];
    if (claim.assigned_adjuster_id) {
      await prisma.witnessStatement.create({
        data: {
          claim_id: claim.id,
          witness_name: `Witness ${i + 1}`,
          witness_phone_ct: encryptSpecialCarePII(`080-${String(2000 + i).padStart(4, '0')}-${String(6000 + i).padStart(4, '0')}`, encryptionKek),
          statement_body: `I witnessed the incident on the date specified. The claimant was involved in a loss event as described. I can confirm the details provided.`,
          inkan_seal_hash: `inkan_${String(i).padStart(64, '0')}`,
          recorded_by_id: claim.assigned_adjuster_id,
        },
      });
    }
  }

  console.log('  ✓ Created 6 sample witness statements');

  // ─── Create sample reserves ─────────────────────────────────────────────
  console.log('  Creating sample reserves...');

  for (let i = 0; i < 12; i++) {
    const claim = claims[i];
    if (claim.assigned_adjuster_id) {
      const categories: Array<'loss_paid' | 'loss_unpaid' | 'alae' | 'ulae'> = ['loss_paid', 'loss_unpaid', 'alae', 'ulae'];
      const proposedYen = BigInt((i + 1) * 1000000); // 1M, 2M, 3M, ...
      const approvalStatus = i % 3 === 0 ? 'approved' : i % 3 === 1 ? 'pending' : 'rejected';

      const reserve = await prisma.reserve.create({
        data: {
          claim_id: claim.id,
          category: categories[i % categories.length],
          proposed_yen: proposedYen,
          prior_yen: i > 0 ? BigInt((i) * 1000000) : null,
          justification: `Reserve proposal for claim ${claim.id}. Based on initial assessment and comparable claims analysis.`,
          proposed_by_id: claim.assigned_adjuster_id,
          approval_status: approvalStatus as 'pending' | 'approved' | 'rejected',
          approved_by_id: approvalStatus === 'approved' ? manager1.id : null,
          approved_at: approvalStatus === 'approved' ? new Date() : null,
          director_approved_by_id: proposedYen > BigInt(10000000) && approvalStatus === 'approved' ? manager2.id : null,
          director_approved_at: proposedYen > BigInt(10000000) && approvalStatus === 'approved' ? new Date() : null,
          reason_for_rejection: approvalStatus === 'rejected' ? 'Insufficient documentation provided' : null,
        },
      });

      // Create JFSA notification if reserve crosses threshold
      if (proposedYen >= BigInt(100000000)) {
        await prisma.notificationToRegulator.create({
          data: {
            kind: 'jfsa_reserve_threshold',
            claim_id: claim.id,
            reserve_id: reserve.id,
            amount_yen: proposedYen,
          },
        });
      }
    }
  }

  console.log('  ✓ Created 12 sample reserves with approval workflow');

  // ─── Create sample audit events ──────────────────────────────────────────
  console.log('  Creating sample audit events...');

  for (let i = 0; i < 20; i++) {
    const claim = claims[i];
    const actions = ['claim.created', 'claim.assigned', 'claim.status_changed', 'note.added', 'evidence.added', 'reserve.proposed'];
    const action = actions[i % actions.length];

    await prisma.auditEvent.create({
      data: {
        actor_id: agent.id,
        actor_role: 'agent',
        action: action,
        claim_id: claim.id,
        target_id: claim.id,
        payload_hash: `hash_${String(i).padStart(64, '0')}`,
        request_id: `req-${String(i).padStart(8, '0')}`,
        correlation_id: `corr-${String(Math.floor(i / 3)).padStart(8, '0')}`,
      },
    });
  }

  console.log('  ✓ Created 20 sample audit events');

  console.log('\n✅ Seed completed successfully!');
  console.log('\n📋 Test credentials:');
  console.log('  Admin (claims director):     admin / admin123');
  console.log('  Manager:                     manager_tanaka / manager123');
  console.log('  Adjuster:                    adjuster_ito / adjuster123');
  console.log('  Agent:                       agent_yamada / agent123');
  console.log('  Auditor:                     auditor_kato / auditor123');
  console.log('  SIU Referrer:                siu_nakano / siu123');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });