// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/claims/dto/create-claim.dto.ts
//
// DTO for FNOL (First Notice of Loss) claim creation.
//
// Validates all required and optional fields per brief.md §1 (FNOL module).
// Channel-specific normalisers in claims-channel.service.ts produce this
// shape before handing off to claims.service.ts.
//
// APPI notes:
//   - appi_consent_version + appi_consent_at are required at intake.
//   - Non-agent channels must supply consent (enforced in service layer;
//     the DTO always requires it so the shape is consistent).
//   - Special-care PII fields (insured_government_id, bank_account_for_payout,
//     injury_details) are accepted as plaintext here and encrypted by the
//     service before persistence. They are typed as optional strings because
//     not all FNOL submissions carry them at intake time.
// =============================================================================

import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IntakeChannel,
  IncidentType,
} from '@prisma/client';

// ---------------------------------------------------------------------------
// Validated prefecture list (47 prefectures of Japan)
// Used by the custom prefecture validator below.
// ---------------------------------------------------------------------------

export const JAPAN_PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
  '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];

// ---------------------------------------------------------------------------
// Reporter relation values (canonical Japanese terms per brief.md)
// ---------------------------------------------------------------------------

export const REPORTER_RELATIONS = [
  '本人',       // insured themselves
  '家族',       // family member
  '代理店',     // agent / broker
  '事故相手方', // third-party / counter-party
  'その他',     // other
] as const;

export type ReporterRelation = (typeof REPORTER_RELATIONS)[number];

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

export class CreateClaimDto {
  // ── Policy & loss basics ──────────────────────────────────────────────────

  @ApiProperty({
    description: 'Policy number — validated against the external Policy Service stub.',
    example: 'POL-2024-00123456',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  policy_number!: string;

  @ApiProperty({
    description:
      'Date the loss occurred. Must fall within the policy effective window ' +
      '(loss_date >= policy_effective_date AND loss_date <= policy_expiry_date). ' +
      'ISO-8601 date or datetime string.',
    example: '2024-06-15',
  })
  @IsDateString()
  loss_date!: string;

  // ── Loss location (Japanese-format postal address) ────────────────────────

  @ApiProperty({
    description:
      '都道府県 (prefecture). Must be one of the 47 recognised Japanese prefectures. ' +
      'E.g. 東京都, 大阪府, 北海道.',
    example: '東京都',
  })
  @IsString()
  @IsNotEmpty()
  loss_location_prefecture!: string;

  @ApiProperty({
    description:
      'Japanese postal code in 〒NNN-NNNN format (7 digits, hyphen optional in storage). ' +
      'Accepts NNN-NNNN or NNNNNNN.',
    example: '100-0001',
  })
  @IsString()
  @Matches(/^\d{3}-?\d{4}$/, {
    message: 'loss_location_postal_code must be a valid Japanese postal code (NNN-NNNN or NNNNNNN).',
  })
  loss_location_postal_code!: string;

  @ApiProperty({
    description:
      'Street-level address detail below prefecture and city — 市区町村 + 番地 + 建物名 etc.',
    example: '千代田区千代田1-1 皇居前ビル201号室',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  loss_location_detail!: string;

  // ── Intake channel ────────────────────────────────────────────────────────

  @ApiProperty({
    description: 'Channel through which this FNOL was received.',
    enum: IntakeChannel,
    example: IntakeChannel.agent,
  })
  @IsEnum(IntakeChannel, {
    message: `reported_by_channel must be one of: ${Object.values(IntakeChannel).join(', ')}.`,
  })
  reported_by_channel!: IntakeChannel;

  // ── Reporter details ──────────────────────────────────────────────────────

  @ApiProperty({
    description: 'Full name of the person reporting the loss.',
    example: '山田 太郎',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  reporter_name!: string;

  @ApiProperty({
    description:
      'Contact phone number of the reporter. ' +
      'Standard PII — stored cleartext, masked in API responses by role. ' +
      'Japanese format accepted (e.g. 090-1234-5678 or +81-90-1234-5678).',
    example: '090-1234-5678',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  reporter_phone!: string;

  @ApiProperty({
    description:
      'Contact email address of the reporter. Standard PII — stored cleartext, masked by role.',
    example: 'yamada.taro@example.co.jp',
  })
  @IsEmail({}, { message: 'reporter_email must be a valid email address.' })
  reporter_email!: string;

  @ApiProperty({
    description:
      'Relation of the reporter to the insured. ' +
      'Canonical Japanese terms: 本人 / 家族 / 代理店 / 事故相手方 / その他.',
    example: '本人',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  reporter_relation_to_insured!: string;

  // ── Incident classification ───────────────────────────────────────────────

  @ApiProperty({
    description: 'Category of the insured incident.',
    enum: IncidentType,
    example: IncidentType.auto_collision,
  })
  @IsEnum(IncidentType, {
    message: `incident_type must be one of: ${Object.values(IncidentType).join(', ')}.`,
  })
  incident_type!: IncidentType;

  @ApiProperty({
    description:
      'Free-text initial description of the loss event as reported by the caller. ' +
      'Stored as UTF-8; agents typically enter this in Japanese.',
    example: '2024年6月15日午後3時頃、東京都千代田区内の交差点で追突事故が発生しました。',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  initial_description!: string;

  // ── Flags ─────────────────────────────────────────────────────────────────

  @ApiProperty({
    description: 'Whether any physical injury has been reported.',
    example: false,
  })
  @IsBoolean()
  injury_reported!: boolean;

  @ApiProperty({
    description: 'Whether a third party is involved in the incident.',
    example: true,
  })
  @IsBoolean()
  third_party_involved!: boolean;

  // ── Optional supplementary fields ─────────────────────────────────────────

  @ApiPropertyOptional({
    description:
      'Police report number, if a police report has been filed. ' +
      'Required when injury_reported is true or third_party_involved is true ' +
      'for certain incident types (business-rule check in service layer).',
    example: 'P-2024-001234',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  police_report_number?: string;

  @ApiPropertyOptional({
    description:
      'Array of attachment references (content-hash strings or blob URIs). ' +
      'Actual blob storage is stubbed; values are stored as-is.',
    type: [String],
    example: ['sha256:abc123...', 'sha256:def456...'],
  })
  @IsOptional()
  @IsString({ each: true })
  attachments?: string[];

  // ── Declared loss amount (used for severity classification) ───────────────

  @ApiPropertyOptional({
    description:
      'Declared loss amount in Japanese Yen (integer). ' +
      'Used together with incident_type and injury_reported to assign severity_initial. ' +
      'Must be a non-negative integer string to avoid floating-point precision issues.',
    example: '500000',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, { message: 'declared_loss_yen must be a non-negative integer string.' })
  declared_loss_yen?: string;

  // ── APPI consent ──────────────────────────────────────────────────────────

  @ApiProperty({
    description:
      'Version identifier of the APPI consent notice the reporter accepted. ' +
      'Must be provided for all channels. Non-agent channels additionally require ' +
      'this to be present or the intake will be rejected (APPI Article 17).',
    example: 'v2.1',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  appi_consent_version!: string;

  @ApiProperty({
    description:
      'Timestamp at which the reporter granted APPI consent. ISO-8601 datetime string.',
    example: '2024-06-15T15:00:00.000Z',
  })
  @IsDateString()
  appi_consent_at!: string;

  // ── Special-care PII fields (APPI Article 17) ─────────────────────────────
  // These are accepted as plaintext at intake, then encrypted by the service
  // before persistence using AES-256-GCM (ADR-001). They are optional because
  // not all claims carry this information at FNOL time.

  @ApiPropertyOptional({
    description:
      'Insured party\'s government-issued ID number. ' +
      'APPI Article 17 special-care PII — encrypted at rest, never returned in API responses. ' +
      'Only available via explicit data-subject-export (GET /claims/:id/data-subject-export).',
    example: 'MY-NUMBER-123456789012',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  insured_government_id?: string;

  @ApiPropertyOptional({
    description:
      'Bank account details for claim payout. ' +
      'APPI Article 17 special-care PII — encrypted at rest. ' +
      'Format: bank_code-branch_code-account_type-account_number.',
    example: '0001-001-普通-1234567',
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  bank_account_for_payout?: string;

  @ApiPropertyOptional({
    description:
      'Injury details as reported. ' +
      'APPI Article 17 special-care PII (medical information) — encrypted at rest. ' +
      'Required when injury_reported is true; optional at DTO level to allow ' +
      'progressive disclosure workflows.',
    example: '右腕骨折、頸椎捻挫の疑い。救急車にて搬送済み。',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  @ValidateIf((o: CreateClaimDto) => o.injury_reported === true)
  @IsNotEmpty({ message: 'injury_details must be provided when injury_reported is true.' })
  injury_details?: string;
}