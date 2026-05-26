import { Injectable } from '@nestjs/common';
import { User, UserRole } from '@prisma/client';
import { EncryptionService } from './encryption';

/**
 * APPI-tier-aware PII masking utility.
 *
 * Context:
 *   APPI (Act on Protection of Personal Information) defines three tiers of PII:
 *   1. Standard PII (name, email, phone): stored cleartext, masked at response time based on role.
 *   2. Special-care PII (government ID, bank account, medical): encrypted at rest, never returned in API responses except via explicit data-subject-export.
 *   3. Sensitive context (loss location, policy number): role-masked at granularity level (e.g., prefecture-only for non-adjuster).
 *
 * This utility is the single source of truth for what fields are returned to whom.
 * It is applied at the controller level via response interceptor or explicit masking calls.
 *
 * Field classification (from brief.md §PII inventory):
 *   - Standard PII: reporter_name, reporter_phone, reporter_email
 *   - Special-care PII: insured_government_id, bank_account_for_payout, injury_details
 *   - Sensitive context: policy_number, loss_location (prefecture granularity)
 *
 * Role matrix (from brief.md §Role matrix):
 *   - agent: read-only on own intake claims (24h window)
 *   - adjuster: full CRUD on assigned claims; sees cleartext for assigned claims only
 *   - manager: reports' pool; sees cleartext for their reports' claims
 *   - auditor: read-only all claims; sees masked PII (no special-care ever)
 *   - siu_referrer: flagged claims only; sees masked PII
 */
@Injectable()
export class PiiMaskUtil {
  constructor(private readonly encryption: EncryptionService) {}

  /**
   * Mask a claim object based on the caller's role and relationship to the claim.
   *
   * @param claim The full claim object (with encrypted fields as Bytes)
   * @param caller The authenticated user making the request
   * @param isAssignedToCallerOrReport Whether the caller is the assigned adjuster or the manager of the assigned adjuster
   * @returns A masked copy of the claim safe to return in the API response
   */
  maskClaimForRole(
    claim: any,
    caller: User,
    isAssignedToCallerOrReport: boolean,
  ): any {
    const masked = { ...claim };

    // Special-care PII: never returned in API responses (except via explicit data-subject-export)
    // These fields are encrypted at rest and should be redacted entirely.
    masked.insured_government_id_ct = undefined;
    masked.bank_account_for_payout_ct = undefined;
    masked.injury_details_ct = undefined;

    // Standard PII masking by role
    switch (caller.role) {
      case UserRole.agent:
        // Agents see only their own intake claims for 24h; after that, masked.
        // For simplicity, we assume the controller enforces the 24h window.
        // Here we mask phone/email unless they are the reporter.
        if (claim.reporter_name !== caller.display_name) {
          masked.reporter_phone_ct = undefined;
          masked.reporter_email_ct = undefined;
        }
        // Agents never see policy_number or loss_location detail
        masked.policy_number = '[REDACTED]';
        masked.loss_location_detail = '[REDACTED]';
        masked.loss_location_postal_code = '[REDACTED]';
        break;

      case UserRole.adjuster:
        // Adjusters see cleartext for assigned claims; masked for others.
        if (!isAssignedToCallerOrReport) {
          masked.reporter_phone_ct = undefined;
          masked.reporter_email_ct = undefined;
          masked.reporter_name = '[REDACTED]';
          masked.loss_location_detail = '[REDACTED]';
          masked.loss_location_postal_code = '[REDACTED]';
        }
        // Policy number is always masked for adjusters (manager-only visibility)
        masked.policy_number = '[REDACTED]';
        break;

      case UserRole.manager:
        // Managers see cleartext for their reports' claims; masked for others.
        if (!isAssignedToCallerOrReport) {
          masked.reporter_phone_ct = undefined;
          masked.reporter_email_ct = undefined;
          masked.reporter_name = '[REDACTED]';
          masked.loss_location_detail = '[REDACTED]';
          masked.loss_location_postal_code = '[REDACTED]';
        }
        // Managers see policy_number and full location for their reports
        break;

      case UserRole.auditor:
        // Auditors see masked PII across all claims (no special-care ever).
        // Standard PII is masked to last 4 digits / redacted.
        masked.reporter_phone_ct = this.maskPhoneBytes(claim.reporter_phone_ct);
        masked.reporter_email_ct = this.maskEmailBytes(claim.reporter_email_ct);
        masked.reporter_name = '[REDACTED]';
        masked.loss_location_detail = '[REDACTED]';
        masked.loss_location_postal_code = '[REDACTED]';
        // Auditors see policy_number for audit trail purposes
        break;

      case UserRole.siu_referrer:
        // SIU referrers see masked PII on flagged claims.
        masked.reporter_phone_ct = this.maskPhoneBytes(claim.reporter_phone_ct);
        masked.reporter_email_ct = this.maskEmailBytes(claim.reporter_email_ct);
        masked.reporter_name = '[REDACTED]';
        masked.loss_location_detail = '[REDACTED]';
        masked.loss_location_postal_code = '[REDACTED]';
        masked.policy_number = '[REDACTED]';
        break;

      default:
        // Deny all by default
        masked.reporter_phone_ct = undefined;
        masked.reporter_email_ct = undefined;
        masked.reporter_name = '[REDACTED]';
        masked.policy_number = '[REDACTED]';
        masked.loss_location_detail = '[REDACTED]';
        masked.loss_location_postal_code = '[REDACTED]';
    }

    return masked;
  }

  /**
   * Decrypt and return a special-care PII field for data-subject-export.
   * Only called by the explicit data-subject-export endpoint, which is auditor/manager-only.
   *
   * @param encryptedBytes The encrypted field (Bytes from Prisma)
   * @returns Decrypted plaintext, or undefined if the field is null
   */
  decryptSpecialCarePii(encryptedBytes: Buffer | null): string | undefined {
    if (!encryptedBytes) {
      return undefined;
    }
    try {
      return this.encryption.decrypt(encryptedBytes);
    } catch (err) {
      // Log and return a safe error message; never expose decryption errors to the API
      console.error('Failed to decrypt special-care PII:', err);
      return '[DECRYPTION_ERROR]';
    }
  }

  /**
   * Mask a phone number (encrypted bytes) to last 4 digits.
   * Returns undefined if the input is null (field not set).
   *
   * @param phoneBytes Encrypted phone number
   * @returns Masked phone string (e.g., "****1234") or undefined
   */
  private maskPhoneBytes(phoneBytes: Buffer | null): string | undefined {
    if (!phoneBytes) {
      return undefined;
    }
    try {
      const decrypted = this.encryption.decrypt(phoneBytes);
      // Japanese phone numbers are typically 10-11 digits; mask to last 4
      const last4 = decrypted.slice(-4);
      return `****${last4}`;
    } catch (err) {
      console.error('Failed to mask phone:', err);
      return '[MASKED]';
    }
  }

  /**
   * Mask an email address (encrypted bytes) to domain only.
   * Returns undefined if the input is null (field not set).
   *
   * @param emailBytes Encrypted email address
   * @returns Masked email string (e.g., "****@example.com") or undefined
   */
  private maskEmailBytes(emailBytes: Buffer | null): string | undefined {
    if (!emailBytes) {
      return undefined;
    }
    try {
      const decrypted = this.encryption.decrypt(emailBytes);
      const [, domain] = decrypted.split('@');
      return domain ? `****@${domain}` : '[MASKED]';
    } catch (err) {
      console.error('Failed to mask email:', err);
      return '[MASKED]';
    }
  }

  /**
   * Mask a loss location to prefecture-only granularity for non-adjuster roles.
   * Adjusters and managers (for their reports) see full detail.
   *
   * @param prefecture The prefecture (都道府県) name
   * @param detail The full address detail
   * @param callerRole The role of the caller
   * @param isAssignedOrReport Whether the caller is assigned or is the manager of the assigned adjuster
   * @returns Masked location string
   */
  maskLocationByRole(
    prefecture: string,
    detail: string,
    callerRole: UserRole,
    isAssignedOrReport: boolean,
  ): string {
    if (
      callerRole === UserRole.adjuster ||
      callerRole === UserRole.manager
    ) {
      if (isAssignedOrReport) {
        return `${prefecture} ${detail}`;
      }
    }
    // All other roles see prefecture only
    return prefecture;
  }
}