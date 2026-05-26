// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// FNOL — Create-claim DTO.
//
// This DTO is the wire contract for `POST /claims` and the four
// channel-specific normaliser routes (`/claims/mobile`, `/claims/broker`,
// `/claims/email-parse`). Per the brief, all four channels deposit a
// `Claim` record with a unified shape — that shape is this class.
//
// Validation philosophy:
//   * `class-validator` decorators enforce the field-level shape; the
//     global `ValidationPipe` (configured in `main.ts` with
//     `whitelist: true, forbidNonWhitelisted: true`) strips unknown
//     properties.
//   * Cross-field rules that depend on external state — most notably
//     "`loss_date` must fall within the policy effective window" — are
//     enforced in `claims.service.ts` against the Policy Service stub,
//     not here. The DTO only guarantees that `loss_date` is a valid
//     ISO-8601 date string in the past.
//   * Japan-specific shape: `loss_location_prefecture` must be one of
//     the 47 都道府県; `loss_location_postal_code` must match the
//     Japanese 〒NNN-NNNN format. These are checked here because they
//     are pure input-shape concerns.
//   * Special-care PII (`insured_government_id`, `bank_account_for_payout`,
//     `injury_details`) is accepted as cleartext on the wire and
//     encrypted by the service before persistence (see
//     `common/encryption.ts`). The DTO marks these fields optional —
//     they are typically captured later in the claim lifecycle — but
//     when present they pass through plain validation only.
//
// APPI consent:
//   * `appi_consent_version` and `appi_consent_at` are required for
//     non-agent channels. The DTO accepts them as optional because the
//     agent channel may omit them (the agent's call recording is the
//     consent artifact); the service rejects the request if the channel
//     requires consent and the fields are absent.
// ─────────────────────────────────────────────────────────────────────────

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { IncidentType, IntakeChannel } from '@prisma/client';

/**
 * The 47 Japanese prefectures (都道府県), romanised. Stored in romaji
 * because the database column is plain text and downstream systems
 * (reinsurance, IFRS17) consume ASCII. The agent UI maps Japanese
 * labels to these values at submit time.
 */
export const JAPAN_PREFECTURES = [
  'Hokkaido',
  'Aomori',
  'Iwate',
  'Miyagi',
  'Akita',
  'Yamagata',
  'Fukushima',
  'Ibaraki',
  'Tochigi',
  'Gunma',
  'Saitama',
  'Chiba',
  'Tokyo',
  'Kanagawa',
  'Niigata',
  'Toyama',
  'Ishikawa',
  'Fukui',
  'Yamanashi',
  'Nagano',
  'Gifu',
  'Shizuoka',
  'Aichi',
  'Mie',
  'Shiga',
  'Kyoto',
  'Osaka',
  'Hyogo',
  'Nara',
  'Wakayama',
  'Tottori',
  'Shimane',
  'Okayama',
  'Hiroshima',
  'Yamaguchi',
  'Tokushima',
  'Kagawa',
  'Ehime',
  'Kochi',
  'Fukuoka',
  'Saga',
  'Nagasaki',
  'Kumamoto',
  'Oita',
  'Miyazaki',
  'Kagoshima',
  'Okinawa',
] as const;

export type JapanPrefecture = (typeof JAPAN_PREFECTURES)[number];

/**
 * Japanese postal code regex: 〒NNN-NNNN. We accept the hyphenated form
 * without the 〒 mark; the UI strips the mark before submission.
 */
const JP_POSTAL_CODE_RE = /^\d{3}-\d{4}$/;

/**
 * Japanese phone number (rough): leading `+81` or `0`, then 9–10 digits
 * with optional hyphens. Strict E.164 conformance is not enforced here
 * because broker-channel payloads sometimes carry extension suffixes;
 * the agent-channel UI normalises before submit.
 */
const JP_PHONE_RE = /^(\+81|0)[\d-]{9,15}$/;

/**
 * Optional attachment reference. Files are not uploaded through this
 * endpoint (see brief, "OUT of scope"); instead, the caller supplies
 * a content-hash + blob_ref for a pre-uploaded artifact. Evidence
 * objects are persisted via the dedicated `POST /claims/:id/evidence`
 * route once the claim exists, but the FNOL DTO accepts a minimal
 * descriptor for attachments captured at intake.
 */
export class AttachmentRefDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  kind!: string;

  /** SHA-256 of the blob, hex-encoded. */
  @IsString()
  @Matches(/^[a-f0-9]{64}$/i, {
    message: 'content_hash must be a 64-character hex SHA-256 digest.',
  })
  content_hash!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(512)
  blob_ref!: string;
}

/**
 * The unified FNOL payload. All four intake channels normalise to this
 * shape before hitting `claims.service.ts`.
 */
export class CreateClaimDto {
  // ─── policy linkage ─────────────────────────────────────────────

  /**
   * Policy number as issued by the upstream PAS. Validated against the
   * Policy Service stub in the service layer (existence + effective
   * window). Format is carrier-specific; we accept any non-empty
   * alphanumeric-with-hyphens string up to 32 chars.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  @Matches(/^[A-Z0-9-]+$/i, {
    message: 'policy_number must be alphanumeric with optional hyphens.',
  })
  policy_number!: string;

  // ─── loss event ─────────────────────────────────────────────────

  /**
   * ISO-8601 date(-time) of the loss event. The service additionally
   * checks that this falls within the policy effective window and is
   * not in the future.
   */
  @IsDateString()
  loss_date!: string;

  @IsIn(JAPAN_PREFECTURES, {
    message: 'loss_location_prefecture must be a valid Japanese prefecture.',
  })
  loss_location_prefecture!: JapanPrefecture;

  @IsString()
  @Matches(JP_POSTAL_CODE_RE, {
    message:
      'loss_location_postal_code must match the Japanese format NNN-NNNN.',
  })
  loss_location_postal_code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(512)
  loss_location_detail!: string;

  // ─── intake channel ─────────────────────────────────────────────

  @IsEnum(IntakeChannel, {
    message:
      'reported_by_channel must be one of: agent, mobile, broker, email.',
  })
  reported_by_channel!: IntakeChannel;

  // ─── reporter (standard PII; stored cleartext, masked by role) ──

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  reporter_name!: string;

  @IsOptional()
  @IsString()
  @Matches(JP_PHONE_RE, {
    message: 'reporter_phone must be a valid Japanese phone number.',
  })
  reporter_phone?: string;

  @IsOptional()
  @IsEmail({}, { message: 'reporter_email must be a valid email address.' })
  @MaxLength(254)
  reporter_email?: string;

  /**
   * Relationship of the reporter to the insured. The brief enumerates
   * the canonical Japanese values (本人 / 家族 / 代理店 / 事故相手方);
   * we accept free-form text here because regional variants exist, and
   * the field is informational rather than load-bearing in the FSM.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  reporter_relation_to_insured!: string;

  // ─── incident ───────────────────────────────────────────────────

  @IsEnum(IncidentType, {
    message:
      'incident_type must be one of the supported P&C incident classifications.',
  })
  incident_type!: IncidentType;

  /**
   * Free-text description. UTF-8; Japanese input expected from the
   * agent channel. Bounded to keep payloads sane and to make the
   * audit `payload_hash` cheap to compute.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  initial_description!: string;

  @IsOptional()
  @IsBoolean()
  injury_reported?: boolean;

  @IsOptional()
  @IsBoolean()
  third_party_involved?: boolean;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  police_report_number?: string;

  /**
   * Declared loss amount in yen, if known at intake. Used by the
   * severity classifier (`claims.service.ts`) together with
   * `incident_type` and `injury_reported`. Accepted as a string to
   * preserve precision through the wire — the service parses it into
   * a `Decimal`. Optional because not all FNOL channels capture an
   * amount up front.
   */
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,15}$/, {
    message:
      'declared_loss_yen must be a non-negative integer string of yen (no decimals).',
  })
  declared_loss_yen?: string;

  // ─── attachments captured at intake (optional) ──────────────────

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => AttachmentRefDto)
  attachments?: AttachmentRefDto[];

  // ─── special-care PII (encrypted at rest by the service) ────────

  /**
   * Japanese government identifier (e.g. マイナンバー / driver's licence
   * number). APPI Article 17 special-care PII. Never returned in API
   * responses; accessible only via the explicit data-subject-export
   * pathway. Optional at intake — typically captured during settlement.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  insured_government_id?: string;

  /**
   * Bank account string for payout. APPI special-care. Encrypted at rest.
   * Free-form because the format varies across banks (店番 + 口座番号,
   * IBAN-style for foreign accounts, etc.).
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  bank_account_for_payout?: string;

  /**
   * Medical / injury details. APPI special-care (medical info).
   * Encrypted at rest.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  injury_details?: string;

  // ─── APPI consent capture ───────────────────────────────────────

  /**
   * Version identifier of the APPI consent notice the reporter
   * accepted. Required for non-agent channels (the service enforces
   * the channel-dependent rule); optional at the DTO layer so the
   * agent channel can omit it.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  appi_consent_version?: string;

  @IsOptional()
  @IsDateString()
  appi_consent_at?: string;
}