// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/common/pii-mask.util.ts
//
// APPI-tier-aware PII masking utility.
//
// Per ADR-003, the same Claim record must return different field sets
// depending on the caller's role and claim ownership. This module is the
// single source of truth for what gets returned to whom.
//
// APPI tiers:
//   - Standard PII: name, phone, email, loss_location — cleartext in DB;
//     masked in API responses based on role.
//   - Special-care PII (APPI Article 17): government_id, bank_account,
//     injury_details — encrypted at rest (_ct fields); never returned in
//     normal API; only via explicit data-subject-export.
//
// Masking strategy per role:
//   agent      — sees own intake claims for 24h; phone/email masked after
//   adjuster   — assigned adjuster sees cleartext; others see masked
//   manager    — sees their reports' claims; PII unmasked for direct reports
//   auditor    — read-only, sees all; special-care PII also visible
//   siu_referrer — sees only flagged claims; standard PII masked
// =============================================================================

import { UserRole } from '@prisma/client';
import type { AuthenticatedUser } from './current-user.decorator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Partial claim shape for masking purposes. Only the fields that require
 * masking logic are included here; callers pass the full Prisma record and
 * receive a masked copy.
 */
export interface MaskableClaim {
  id: string;
  policy_number: string;
  reporter_name: string;
  reporter_phone_ct?: Buffer | Uint8Array | null;  // encrypted; never returned as-is
  reporter_email_ct?: Buffer | Uint8Array | null;  // encrypted; never returned as-is
  reporter_relation_to_insured: string;
  loss_location_prefecture: string;
  loss_location_postal_code: string;
  loss_location_detail: string;
  assigned_adjuster_id?: string | null;
  insured_government_id_ct?: Buffer | Uint8Array | null;   // special-care
  bank_account_for_payout_ct?: Buffer | Uint8Array | null; // special-care
  injury_details_ct?: Buffer | Uint8Array | null;          // special-care
  created_at: Date;
  [key: string]: unknown;
}

/**
 * The result shape after masking. Special-care `_ct` fields are removed;
 * standard PII fields are replaced with masked variants based on role.
 */
export interface MaskedClaim extends Omit<
  MaskableClaim,
  | 'reporter_phone_ct'
  | 'reporter_email_ct'
  | 'insured_government_id_ct'
  | 'bank_account_for_payout_ct'
  | 'injury_details_ct'
> {
  reporter_phone_masked: string | null;
  reporter_email_masked: string | null;
  loss_location_display: string;
  // Special-care fields are never in the normal response shape
}

/**
 * Context passed to masking functions to determine what to reveal.
 */
export interface MaskingContext {
  caller: AuthenticatedUser;
  /** Whether the caller is the assigned adjuster for this specific claim */
  isAssignedAdjuster: boolean;
  /** Whether the caller is a manager of the assigned adjuster */
  isResponsibleManager: boolean;
}

// ---------------------------------------------------------------------------
// Masking constants
// ---------------------------------------------------------------------------

const PHONE_MASK   = '***-****-****';
const EMAIL_MASK   = '***@***.***';
const DETAIL_MASK  = '[redacted]';

// ---------------------------------------------------------------------------
// Field-level masking helpers
// ---------------------------------------------------------------------------

/**
 * Mask a phone number, preserving nothing.
 * Assignees and responsible managers see the decrypted value passed in;
 * all others see the mask constant.
 */
export function maskPhone(
  decryptedPhone: string | null,
  ctx: MaskingContext,
): string | null {
  if (decryptedPhone === null) return null;

  const { caller, isAssignedAdjuster, isResponsibleManager } = ctx;

  switch (caller.role) {
    case UserRole.auditor:
      // Auditors see the decrypted value — they have full access per brief
      return decryptedPhone;

    case UserRole.adjuster:
      return isAssignedAdjuster ? decryptedPhone : PHONE_MASK;

    case UserRole.manager:
      return isResponsibleManager ? decryptedPhone : PHONE_MASK;

    case UserRole.agent:
    case UserRole.siu_referrer:
    default:
      return PHONE_MASK;
  }
}

/**
 * Mask an email address.
 * Same access rules as phone.
 */
export function maskEmail(
  decryptedEmail: string | null,
  ctx: MaskingContext,
): string | null {
  if (decryptedEmail === null) return null;

  const { caller, isAssignedAdjuster, isResponsibleManager } = ctx;

  switch (caller.role) {
    case UserRole.auditor:
      return decryptedEmail;

    case UserRole.adjuster:
      return isAssignedAdjuster ? decryptedEmail : EMAIL_MASK;

    case UserRole.manager:
      return isResponsibleManager ? decryptedEmail : EMAIL_MASK;

    case UserRole.agent:
    case UserRole.siu_referrer:
    default:
      return EMAIL_MASK;
  }
}

/**
 * Mask a policy number.
 * Auditors and the assigned adjuster see the full value.
 * Others see the last 4 chars prefixed with asterisks.
 */
export function maskPolicyNumber(
  policyNumber: string,
  ctx: MaskingContext,
): string {
  const { caller, isAssignedAdjuster, isResponsibleManager } = ctx;

  switch (caller.role) {
    case UserRole.auditor:
      return policyNumber;

    case UserRole.adjuster:
      return isAssignedAdjuster ? policyNumber : `****${policyNumber.slice(-4)}`;

    case UserRole.manager:
      return isResponsibleManager ? policyNumber : `****${policyNumber.slice(-4)}`;

    case UserRole.agent:
    case UserRole.siu_referrer:
    default:
      return `****${policyNumber.slice(-4)}`;
  }
}

/**
 * Mask location detail.
 * Per brief: non-adjuster roles see only prefecture-level granularity.
 * Adjuster (assigned) and manager (responsible) see full detail.
 * Auditors see full detail.
 */
export function maskLocationDetail(
  prefecture: string,
  postalCode: string,
  detail: string,
  ctx: MaskingContext,
): string {
  const { caller, isAssignedAdjuster, isResponsibleManager } = ctx;

  switch (caller.role) {
    case UserRole.auditor:
      return `${prefecture} ${postalCode} ${detail}`;

    case UserRole.adjuster:
      return isAssignedAdjuster
        ? `${prefecture} ${postalCode} ${detail}`
        : prefecture; // prefecture only for non-assigned adjuster

    case UserRole.manager:
      return isResponsibleManager
        ? `${prefecture} ${postalCode} ${detail}`
        : prefecture;

    case UserRole.agent:
    case UserRole.siu_referrer:
    default:
      return prefecture; // prefecture only
  }
}

/**
 * Mask reporter name.
 * Non-assigned roles get a partially redacted name (first char + ****).
 */
export function maskReporterName(
  name: string,
  ctx: MaskingContext,
): string {
  const { caller, isAssignedAdjuster, isResponsibleManager } = ctx;

  switch (caller.role) {
    case UserRole.auditor:
      return name;

    case UserRole.adjuster:
      return isAssignedAdjuster ? name : `${name.charAt(0)}****`;

    case UserRole.manager:
      return isResponsibleManager ? name : `${name.charAt(0)}****`;

    case UserRole.agent:
    case UserRole.siu_referrer:
    default:
      return `${name.charAt(0)}****`;
  }
}

// ---------------------------------------------------------------------------
// Special-care PII
// ---------------------------------------------------------------------------

/**
 * Special-care PII fields (APPI Article 17) are NEVER returned in normal
 * API responses. They are only available via the explicit data-subject-export
 * endpoint (GET /claims/:id/data-subject-export), which requires auditor or
 * manager role.
 *
 * This function returns an object indicating that these fields are redacted.
 * The actual decryption happens only in appi.service.ts.
 */
export function specialCarePlaceholder(): string {
  return DETAIL_MASK;
}

/**
 * Whether the given role is permitted to access special-care PII fields
 * via the data-subject-export endpoint.
 */
export function canAccessSpecialCarePii(
  role: UserRole,
  isResponsibleManager: boolean,
): boolean {
  if (role === UserRole.auditor) return true;
  if (role === UserRole.manager && isResponsibleManager) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Top-level mask function
// ---------------------------------------------------------------------------

/**
 * Apply all APPI-tier masking rules to a raw Prisma Claim record.
 *
 * - Strips all `_ct` (encrypted) fields from the response entirely.
 * - Replaces them with masked/redacted variants based on caller role.
 * - Applies field-level masking to standard PII based on context.
 *
 * @param claim   Full Prisma claim record (including _ct fields)
 * @param decrypted  Pre-decrypted values for _ct fields (from service layer)
 * @param ctx     Masking context (caller role + ownership booleans)
 * @returns       A new object safe to return in API responses
 */
export function maskClaimForCaller(
  claim: MaskableClaim,
  decrypted: {
    reporter_phone: string | null;
    reporter_email: string | null;
  },
  ctx: MaskingContext,
): MaskedClaim {
  // Destructure away all _ct fields — they must never appear in responses
  const {
    reporter_phone_ct: _rp,
    reporter_email_ct: _re,
    insured_government_id_ct: _ig,
    bank_account_for_payout_ct: _ba,
    injury_details_ct: _id,
    ...safeFields
  } = claim;

  // Suppress unused variable warnings — these are intentionally destructured
  // and discarded to prevent them appearing in spread output
  void _rp; void _re; void _ig; void _ba; void _id;

  const maskedPhone  = maskPhone(decrypted.reporter_phone, ctx);
  const maskedEmail  = maskEmail(decrypted.reporter_email, ctx);
  const maskedPolicy = maskPolicyNumber(safeFields.policy_number, ctx);
  const maskedName   = maskReporterName(safeFields.reporter_name, ctx);
  const locationDisplay = maskLocationDetail(
    safeFields.loss_location_prefecture,
    safeFields.loss_location_postal_code,
    safeFields.loss_location_detail,
    ctx,
  );

  return {
    ...safeFields,
    policy_number: maskedPolicy,
    reporter_name: maskedName,
    reporter_phone_masked: maskedPhone,
    reporter_email_masked: maskedEmail,
    loss_location_display: locationDisplay,
  };
}

// ---------------------------------------------------------------------------
// Witness statement masking
// ---------------------------------------------------------------------------

export interface MaskableWitnessStatement {
  id: string;
  claim_id: string;
  witness_name: string;
  witness_phone_ct?: Buffer | Uint8Array | null;
  statement_body: string;
  inkan_seal_hash: string;
  recorded_by_id: string;
  recorded_at: Date;
  [key: string]: unknown;
}

export interface MaskedWitnessStatement extends Omit<MaskableWitnessStatement, 'witness_phone_ct'> {
  witness_phone_masked: string | null;
}

/**
 * Mask a witness statement for API response.
 * witness_phone_ct is stripped; decrypted value is masked per caller role.
 */
export function maskWitnessStatementForCaller(
  stmt: MaskableWitnessStatement,
  decryptedPhone: string | null,
  ctx: MaskingContext,
): MaskedWitnessStatement {
  const { witness_phone_ct: _wpc, ...safeFields } = stmt;
  void _wpc;

  return {
    ...safeFields,
    witness_phone_masked: maskPhone(decryptedPhone, ctx),
  };
}

// ---------------------------------------------------------------------------
// Prefecture validation
// ---------------------------------------------------------------------------

/**
 * Canonical list of Japanese prefectures (都道府県) for validation.
 * Used in FNOL intake to validate `loss_location_prefecture`.
 */
export const JAPANESE_PREFECTURES: ReadonlySet<string> = new Set([
  '北海道',
  '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
  '岐阜県', '静岡県', '愛知県',
  '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県',
  '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県',
  '沖縄県',
]);

/**
 * Returns true if the given string is a valid Japanese prefecture name.
 */
export function isValidJapanesePrefecture(prefecture: string): boolean {
  return JAPANESE_PREFECTURES.has(prefecture);
}

// ---------------------------------------------------------------------------
// APPI consent validation
// ---------------------------------------------------------------------------

/**
 * Non-agent channels require APPI consent to be captured at intake.
 * Agent channel is exempt (verbal consent captured by agent per procedure).
 *
 * @param channel   The intake channel
 * @param consentVersion  The consent version string (must be non-empty)
 * @param consentAt       The consent timestamp (must be present)
 * @returns true if consent requirements are satisfied
 */
export function isAppiConsentSatisfied(
  channel: 'agent' | 'mobile' | 'broker' | 'email',
  consentVersion: string | null | undefined,
  consentAt: Date | null | undefined,
): boolean {
  if (channel === 'agent') {
    // Agent channel: verbal consent; still require version/at to be set
    // but don't reject — brief says reject if missing for non-agent channels
    return true;
  }

  // Non-agent channels: both version and timestamp are mandatory
  if (!consentVersion || consentVersion.trim() === '') return false;
  if (!consentAt) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Severity classification (pure function — no ML)
// ---------------------------------------------------------------------------

import { IncidentType, ClaimSeverity } from '@prisma/client';

/**
 * Classify the initial severity of a claim based on:
 * - Declared loss amount (in JPY)
 * - Incident type
 * - Whether injury is reported
 *
 * Per brief.md: IncidentType + declared loss + injury_reported → simple | complex | catastrophic
 *
 * Thresholds:
 *   catastrophic: loss >= ¥10M OR injury_reported + complex incident type
 *   complex:      loss >= ¥1M OR injury_reported OR commercial/marine/liability incident
 *   simple:       everything else
 */
export function classifyInitialSeverity(
  incidentType: IncidentType,
  declaredLossYen: number,
  injuryReported: boolean,
): ClaimSeverity {
  // Catastrophic incidents by type
  const catastrophicTypes: IncidentType[] = [
    IncidentType.fire_commercial,
    IncidentType.marine_cargo,
    IncidentType.liability_premises,
  ];

  // Complex incidents by type (everything not simple auto)
  const complexTypes: IncidentType[] = [
    IncidentType.fire_residential,
    IncidentType.fire_commercial,
    IncidentType.marine_cargo,
    IncidentType.liability_premises,
    IncidentType.personal_accident,
  ];

  // Catastrophic if:
  // - Loss >= ¥10M
  // - Or: injury + catastrophic-type incident
  // - Or: loss >= ¥5M + injury
  if (declaredLossYen >= 10_000_000) {
    return ClaimSeverity.catastrophic;
  }

  if (injuryReported && catastrophicTypes.includes(incidentType)) {
    return ClaimSeverity.catastrophic;
  }

  if (declaredLossYen >= 5_000_000 && injuryReported) {
    return ClaimSeverity.catastrophic;
  }

  // Complex if:
  // - Loss >= ¥1M
  // - Or: injury reported
  // - Or: complex incident type
  if (declaredLossYen >= 1_000_000) {
    return ClaimSeverity.complex;
  }

  if (injuryReported) {
    return ClaimSeverity.complex;
  }

  if (complexTypes.includes(incidentType)) {
    return ClaimSeverity.complex;
  }

  return ClaimSeverity.simple;
}