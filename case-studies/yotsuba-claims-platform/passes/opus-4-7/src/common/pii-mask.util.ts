// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// APPI-tier-aware PII masking (ADR-003).
//
// The same `Claim` record must surface different field projections to
// different roles. Rather than scatter "who sees what" logic across every
// controller, this module is the single source of truth.
//
// APPI tiering (per brief PII inventory):
//
//   ┌────────────────────────────┬─────────────────┬─────────────────────┐
//   │ Field                      │ Tier            │ At-rest protection  │
//   ├────────────────────────────┼─────────────────┼─────────────────────┤
//   │ reporter_name              │ Standard PII    │ cleartext, masked   │
//   │ reporter_phone             │ Standard PII    │ encrypted (_ct)     │
//   │ reporter_email             │ Standard PII    │ encrypted (_ct)     │
//   │ policy_number              │ Sensitive       │ cleartext, masked   │
//   │ loss_location_*            │ Standard PII    │ cleartext, prefecture-
//   │                            │                 │ only for non-adjuster│
//   │ insured_government_id      │ Special-care    │ encrypted, redacted │
//   │ bank_account_for_payout    │ Special-care    │ encrypted, redacted │
//   │ injury_details             │ Special-care    │ encrypted, redacted │
//   │ witness_phone              │ Standard PII    │ encrypted (_ct)     │
//   └────────────────────────────┴─────────────────┴─────────────────────┘
//
// Visibility matrix by role (✓ = cleartext; △ = masked; ✗ = redacted):
//
//   role          | std PII (own) | std PII (other) | sensitive | special-care
//   --------------+---------------+-----------------+-----------+-------------
//   agent         |      △        |       △         |     △     |     ✗
//   adjuster      |      ✓ (own)  |       △         |     △     |     ✗
//                 |      △ (other)│                 │           │
//   manager       |      ✓        |       ✓         |     ✓     |     ✗
//   auditor       |      ✓        |       ✓         |     ✓     |     ✓
//   siu_referrer  |      △        |       △         |     △     |     ✗
//
// "own" means: for an adjuster, the claim is assigned to them; for an
// agent, the claim was intaken by them within the 24h read window.
// Manager scoping ("reports' only") is enforced upstream by the service
// layer; once a manager is permitted to read the record, they see
// cleartext of standard + sensitive fields.
//
// Special-care PII is never returned by `GET /claims/:id` for any role;
// it is only ever materialised by `GET /claims/:id/data-subject-export`
// for auditor / manager callers (APPI Article 28).
// ─────────────────────────────────────────────────────────────────────────

import { UserRole } from '@prisma/client';

// ─── tier taxonomy ───────────────────────────────────────────────────────

/**
 * APPI-aligned sensitivity tiers. The string values are stable and may
 * appear in logs / metrics; do not rename without an ADR update.
 */
export enum AppiTier {
  /** Name, contact details, postal address detail. */
  Standard = 'standard',
  /** Policy number — links to a financial product, treated stricter than name. */
  Sensitive = 'sensitive',
  /** APPI Article 17 special-care: gov ID, medical, bank. Never in normal GETs. */
  SpecialCare = 'special_care',
}

/**
 * Visibility levels yielded by the policy function. The mask renderer
 * consumes these to decide what to emit for each field.
 */
export enum Visibility {
  /** Emit the original value untouched. */
  Clear = 'clear',
  /** Emit a partial-redaction (e.g. `090-****-1234`, `t****@example.jp`). */
  Masked = 'masked',
  /** Omit the field entirely (or set to `null`) — caller is not entitled. */
  Redacted = 'redacted',
}

/**
 * The claim-scoped relationship of the caller to the record being read.
 * Used together with `role` to decide cleartext-vs-mask for standard PII.
 */
export interface CallerClaimRelation {
  /** True if the caller is the currently-assigned adjuster on this claim. */
  is_assigned_adjuster: boolean;
  /** True if the caller is the agent who intaked this claim, within the 24h window. */
  is_intake_agent_within_window: boolean;
}

/**
 * Minimal caller shape required by the masking policy. A strict subset of
 * `CurrentUserPayload` so this module remains decoupled from the auth layer.
 */
export interface MaskingCaller {
  id: string;
  role: UserRole;
}

// ─── policy: who-sees-what ───────────────────────────────────────────────

/**
 * Pure function from (caller role × APPI tier × claim relation) to a
 * `Visibility` decision. This is the canonical policy referenced by
 * ADR-003; every test in `claims-workbench.e2e.spec.ts` that asserts a
 * role × field combination is ultimately checking the table below.
 */
export function visibilityFor(
  role: UserRole,
  tier: AppiTier,
  relation: CallerClaimRelation,
): Visibility {
  // Special-care PII: only auditors see it via normal reads. Everyone else
  // gets a hard redaction; the data-subject-export route is the only other
  // legitimate egress and it bypasses this function.
  if (tier === AppiTier.SpecialCare) {
    return role === 'auditor' ? Visibility.Clear : Visibility.Redacted;
  }

  switch (role) {
    case 'auditor':
      // Auditors see all non-special-care fields in the clear.
      return Visibility.Clear;

    case 'manager':
      // Managers (already scoped to their reports' claims at the service
      // layer) see standard + sensitive in the clear.
      return Visibility.Clear;

    case 'adjuster':
      // The assigned adjuster sees the claim in the clear; other adjusters
      // who somehow reach the record (shouldn't, but defence-in-depth)
      // get masked output.
      if (relation.is_assigned_adjuster) {
        return Visibility.Clear;
      }
      return Visibility.Masked;

    case 'agent':
      // Agents see their own intakes within the 24h window, masked.
      // Outside that window the service layer should have refused the read.
      if (relation.is_intake_agent_within_window) {
        return Visibility.Masked;
      }
      return Visibility.Redacted;

    case 'siu_referrer':
      // SIU referrers see flagged claims only (gated upstream); when they
      // do see a record, PII is masked — they need shape, not identity.
      return Visibility.Masked;

    default: {
      // Exhaustiveness check: a new UserRole must be handled explicitly.
      const _exhaustive: never = role;
      void _exhaustive;
      return Visibility.Redacted;
    }
  }
}

// ─── partial-redaction renderers ─────────────────────────────────────────

/**
 * Mask a phone number while preserving its rough shape. Keeps the leading
 * 3 digits and the trailing 4 digits; everything in between becomes `*`.
 * Non-digit characters (hyphens, parentheses, spaces) are preserved so
 * Japanese formats like `090-1234-5678` remain recognisable as phones.
 *
 * Examples:
 *   `090-1234-5678` → `090-****-5678`
 *   `0312345678`    → `031****5678`
 *   `+81 90 1234 5678` → `+81 90 ****5678` (digit-window logic)
 */
export function maskPhone(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  if (s.length === 0) return '';

  // Walk the string keeping non-digits as-is. Mask interior digits,
  // preserving the first 3 and last 4 digits.
  const digitPositions: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] >= '0' && s[i] <= '9') digitPositions.push(i);
  }
  if (digitPositions.length <= 7) {
    // Too short to meaningfully partition — mask everything but last 2.
    const chars = s.split('');
    const keepLast = Math.min(2, digitPositions.length);
    const keepFromIndex =
      digitPositions[digitPositions.length - keepLast] ?? s.length;
    for (let i = 0; i < s.length; i++) {
      if (i < keepFromIndex && s[i] >= '0' && s[i] <= '9') chars[i] = '*';
    }
    return chars.join('');
  }

  const headEnd = digitPositions[2]; // last index of the first 3 digits
  const tailStart = digitPositions[digitPositions.length - 4];
  const chars = s.split('');
  for (let i = headEnd + 1; i < tailStart; i++) {
    if (chars[i] >= '0' && chars[i] <= '9') chars[i] = '*';
  }
  return chars.join('');
}

/**
 * Mask an email address. Keeps the first character of the local part and
 * the entire domain; the rest of the local part becomes `*`.
 *
 * Examples:
 *   `tanaka@example.jp`     → `t*****@example.jp`
 *   `a@example.jp`          → `*@example.jp`
 *   `not-an-email`          → `***` (no `@` — full redaction of the local form)
 */
export function maskEmail(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  if (s.length === 0) return '';
  const atIdx = s.indexOf('@');
  if (atIdx < 0) return '***';
  const local = s.slice(0, atIdx);
  const domain = s.slice(atIdx); // includes the '@'
  if (local.length <= 1) {
    return `*${domain}`;
  }
  return `${local[0]}${'*'.repeat(Math.max(1, local.length - 1))}${domain}`;
}

/**
 * Mask a personal name. Keeps the first character (which for Japanese
 * names is typically the family-name surname character) and replaces the
 * remainder with `*`. Works equally for `田中太郎` → `田***` and
 * `Tanaka Taro` → `T*********`.
 */
export function maskName(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  if (s.length === 0) return '';
  // Use Array.from to count Unicode code points correctly for CJK.
  const codepoints = Array.from(s);
  if (codepoints.length <= 1) return '*';
  return `${codepoints[0]}${'*'.repeat(codepoints.length - 1)}`;
}

/**
 * Mask a policy number. Keeps the first 2 and last 2 characters; the
 * interior becomes `*`. Policy numbers are short enough that fully
 * preserving either end would leak identity.
 *
 * Examples:
 *   `POL-2024-000123` → `PO***********23`
 *   `AB12`            → `****`
 */
export function maskPolicyNumber(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  if (s.length === 0) return '';
  if (s.length <= 4) return '*'.repeat(s.length);
  return `${s.slice(0, 2)}${'*'.repeat(s.length - 4)}${s.slice(-2)}`;
}

/**
 * Coarsen a loss location to prefecture-only granularity. The detail
 * (street, building, room) and the postal code are dropped; only the
 * prefecture is retained.
 */
export interface LossLocation {
  loss_location_prefecture: string;
  loss_location_postal_code: string;
  loss_location_detail: string;
}

export function maskLossLocation(loc: LossLocation): LossLocation {
  return {
    loss_location_prefecture: loc.loss_location_prefecture,
    loss_location_postal_code: '***',
    loss_location_detail: '***',
  };
}

// ─── claim-shape masker ──────────────────────────────────────────────────

/**
 * The subset of a claim shape this module knows how to mask. Callers may
 * pass a wider object (e.g. with relations); unknown fields are left
 * untouched. The shape mirrors the Prisma `Claim` projection produced by
 * the claims service after decrypting `_ct` columns into plaintext
 * companions (e.g. `reporter_phone`, `reporter_email`).
 */
export interface MaskableClaim {
  id?: string;
  policy_number?: string;
  reporter_name?: string | null;
  reporter_phone?: string | null;
  reporter_email?: string | null;
  loss_location_prefecture?: string;
  loss_location_postal_code?: string;
  loss_location_detail?: string;
  assigned_adjuster_id?: string | null;
  // Special-care plaintext companions — present only when the service
  // layer has explicitly decrypted them for an entitled caller (e.g.
  // data-subject-export). Normal reads never populate these.
  insured_government_id?: string | null;
  bank_account_for_payout?: string | null;
  injury_details?: string | null;
  [key: string]: unknown;
}

/**
 * Apply the APPI masking policy to a claim projection. Returns a new
 * object; the input is not mutated.
 *
 * Field-to-tier assignments are encoded inline rather than in a lookup
 * table so that adding a new sensitive field is a single, reviewable
 * diff in this file — consistent with the ADR-003 commitment that this
 * function is the single source of truth.
 */
export function maskClaimForCaller<T extends MaskableClaim>(
  claim: T,
  caller: MaskingCaller,
  relation?: Partial<CallerClaimRelation>,
): T {
  const rel: CallerClaimRelation = {
    is_assigned_adjuster:
      relation?.is_assigned_adjuster ??
      (caller.role === 'adjuster' && claim.assigned_adjuster_id === caller.id),
    is_intake_agent_within_window:
      relation?.is_intake_agent_within_window ?? false,
  };

  // Pre-compute the three visibility decisions we actually use.
  const vStd = visibilityFor(caller.role, AppiTier.Standard, rel);
  const vSensitive = visibilityFor(caller.role, AppiTier.Sensitive, rel);
  const vSpecial = visibilityFor(caller.role, AppiTier.SpecialCare, rel);

  const out: MaskableClaim = { ...claim };

  // ── standard PII ─────────────────────────────────────────────────────
  if ('reporter_name' in out) {
    out.reporter_name = applyVisibility(
      out.reporter_name ?? null,
      vStd,
      maskName,
    );
  }
  if ('reporter_phone' in out) {
    out.reporter_phone = applyVisibility(
      out.reporter_phone ?? null,
      vStd,
      maskPhone,
    );
  }
  if ('reporter_email' in out) {
    out.reporter_email = applyVisibility(
      out.reporter_email ?? null,
      vStd,
      maskEmail,
    );
  }

  // ── loss location: prefecture-only for non-adjuster roles ────────────
  // The brief specifies prefecture-granularity for non-adjuster roles
  // specifically; adjusters with cleartext visibility see the full address,
  // everyone else sees prefecture + masked detail/postal.
  if (
    'loss_location_prefecture' in out &&
    'loss_location_postal_code' in out &&
    'loss_location_detail' in out
  ) {
    if (vStd !== Visibility.Clear) {
      const coarsened = maskLossLocation({
        loss_location_prefecture: String(out.loss_location_prefecture ?? ''),
        loss_location_postal_code: String(out.loss_location_postal_code ?? ''),
        loss_location_detail: String(out.loss_location_detail ?? ''),
      });
      out.loss_location_prefecture = coarsened.loss_location_prefecture;
      out.loss_location_postal_code = coarsened.loss_location_postal_code;
      out.loss_location_detail = coarsened.loss_location_detail;
    }
  }

  // ── sensitive: policy number ─────────────────────────────────────────
  if ('policy_number' in out) {
    out.policy_number = applyVisibility(
      out.policy_number ?? null,
      vSensitive,
      maskPolicyNumber,
    );
  }

  // ── special-care plaintext companions: present only when the service
  // layer has materialised them. For non-auditor callers (vSpecial !==
  // Clear) we hard-redact to null so even an accidental inclusion can't
  // leak. The data-subject-export pipeline bypasses this function.
  if ('insured_government_id' in out) {
    out.insured_government_id =
      vSpecial === Visibility.Clear ? out.insured_government_id : null;
  }
  if ('bank_account_for_payout' in out) {
    out.bank_account_for_payout =
      vSpecial === Visibility.Clear ? out.bank_account_for_payout : null;
  }
  if ('injury_details' in out) {
    out.injury_details =
      vSpecial === Visibility.Clear ? out.injury_details : null;
  }

  return out as T;
}

/**
 * Apply a single visibility decision to a single field value.
 */
function applyVisibility(
  value: string | null,
  visibility: Visibility,
  masker: (v: string | null | undefined) => string | null,
): string | null {
  switch (visibility) {
    case Visibility.Clear:
      return value;
    case Visibility.Masked:
      return masker(value);
    case Visibility.Redacted:
      return null;
    default: {
      const _exhaustive: never = visibility;
      void _exhaustive;
      return null;
    }
  }
}

// ─── witness-statement masker ────────────────────────────────────────────

/**
 * Witness statements carry their own contact PII (`witness_phone`).
 * Apply the same standard-PII policy.
 */
export interface MaskableWitnessStatement {
  witness_name?: string;
  witness_phone?: string | null;
  statement_body?: string;
  inkan_seal_hash?: string;
  [key: string]: unknown;
}

export function maskWitnessStatementForCaller<T extends MaskableWitnessStatement>(
  ws: T,
  caller: MaskingCaller,
  relation: CallerClaimRelation,
): T {
  const vStd = visibilityFor(caller.role, AppiTier.Standard, relation);
  const out: MaskableWitnessStatement = { ...ws };
  if ('witness_name' in out) {
    out.witness_name =
      applyVisibility(out.witness_name ?? null, vStd, maskName) ?? undefined;
  }
  if ('witness_phone' in out) {
    out.witness_phone = applyVisibility(
      out.witness_phone ?? null,
      vStd,
      maskPhone,
    );
  }
  return out as T;
}