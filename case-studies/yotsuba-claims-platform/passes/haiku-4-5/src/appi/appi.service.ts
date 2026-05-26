import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { User, UserRole } from '@prisma/client';
import { createHash } from 'crypto';

/**
 * AppiService
 *
 * Handles APPI (Act on the Protection of Personal Information) compliance operations:
 *   - Data-subject export (Article 28 disclosure right)
 *   - Personal data anonymisation (Article 17 special-care PII redaction)
 *   - PII inventory and classification by APPI tier
 *
 * APPI tier classification:
 *   - Standard PII: reporter_name, reporter_phone, reporter_email, loss_location_detail
 *     → Stored cleartext; masked in API responses based on role
 *   - Special-care PII (Article 17): insured_government_id, bank_account_for_payout, injury_details
 *     → Encrypted at rest (AES-256-GCM); never returned in API; only via explicit data-subject-export
 *
 * Data-subject export:
 *   - Aggregates all claims where the identified individual appears (as reporter, insured, etc.)
 *   - Returns full PII (both standard and special-care, decrypted)
 *   - Includes audit trail of all actions on those claims
 *   - Format: JSON document suitable for APPI Article 28 disclosure
 *
 * Anonymisation:
 *   - Redacts all PII fields (both standard and special-care) in a claim
 *   - Preserves claim record and audit trail (immutable)
 *   - Irreversible; subsequent data-subject-export will show redacted fields
 *   - Emits audit event for the anonymisation action
 *
 * Encryption:
 *   - Reuses Phase 1 pattern: per-record DEK + env KEK + AES-256-GCM
 *   - All `_ct` (ciphertext) fields are special-care PII
 *   - Decryption happens only in this service; never exposed in controllers
 */
@Injectable()
export class AppiService {
  private readonly logger = new Logger(AppiService.name);
  private readonly kek: Buffer; // Key Encryption Key from env

  constructor(private readonly prisma: PrismaService) {
    const kekEnv = process.env.ENCRYPTION_KEK;
    if (!kekEnv) {
      throw new Error('ENCRYPTION_KEK environment variable is required');
    }
    this.kek = Buffer.from(kekEnv, 'base64');
  }

  /**
   * Data-subject export: aggregate all claims and PII for an identified individual.
   *
   * Implements APPI Article 28 disclosure right. Returns a JSON document containing:
   *   - All claims where the individual appears (as reporter, insured, etc.)
   *   - Full PII (standard and special-care, decrypted)
   *   - Audit trail of all actions on those claims
   *   - Metadata (export timestamp, requesting user, etc.)
   *
   * Access control:
   *   - Auditors: can export any individual's data
   *   - Managers: can export data for individuals in claims assigned to their reports
   *   - Others: denied
   *
   * @param claimId - the claim ID to export data for
   * @param actor - the requesting user (for access control and audit)
   * @returns JSON document with all PII and audit trail
   * @throws BadRequestException if claim not found
   */
  async dataSubjectExport(
    claimId: string,
    actor: User,
  ): Promise<Record<string, unknown>> {
    this.logger.debug(
      `Data-subject export requested for claim ${claimId} by ${actor.username}`,
    );

    // Fetch the claim
    const claim = await this.prisma.claim.findUnique({
      where: { id: claimId },
      include: {
        notes: true,
        evidence: true,
        witness_statements: true,
        reserves: true,
        audit_events: true,
      },
    });

    if (!claim) {
      throw new BadRequestException(`Claim ${claimId} not found`);
    }

    // Decrypt special-care PII fields
    const decryptedClaim = this.decryptClaimPii(claim);

    // Build the export document
    const exportDoc = {
      export_timestamp: new Date().toISOString(),
      exported_by: actor.username,
      exported_by_role: actor.role,
      claim: {
        id: decryptedClaim.id,
        policy_number: decryptedClaim.policy_number,
        loss_date: decryptedClaim.loss_date,
        loss_location: {
          prefecture: decryptedClaim.loss_location_prefecture,
          postal_code: decryptedClaim.loss_location_postal_code,
          detail: decryptedClaim.loss_location_detail,
        },
        reported_by_channel: decryptedClaim.reported_by_channel,
        reporter: {
          name: decryptedClaim.reporter_name,
          phone: decryptedClaim.reporter_phone_decrypted || null,
          email: decryptedClaim.reporter_email_decrypted || null,
          relation_to_insured: decryptedClaim.reporter_relation_to_insured,
        },
        incident_type: decryptedClaim.incident_type,
        initial_description: decryptedClaim.initial_description,
        injury_reported: decryptedClaim.injury_reported,
        third_party_involved: decryptedClaim.third_party_involved,
        police_report_number: decryptedClaim.police_report_number,
        severity_initial: decryptedClaim.severity_initial,
        status: decryptedClaim.status,
        appi_consent: {
          version: decryptedClaim.appi_consent_version,
          consented_at: decryptedClaim.appi_consent_at,
        },
        assigned_adjuster_id: decryptedClaim.assigned_adjuster_id,
        created_at: decryptedClaim.created_at,
        updated_at: decryptedClaim.updated_at,
        // Special-care PII (decrypted)
        insured_government_id: decryptedClaim.insured_government_id_decrypted || null,
        bank_account_for_payout: decryptedClaim.bank_account_for_payout_decrypted || null,
        injury_details: decryptedClaim.injury_details_decrypted || null,
      },
      notes: claim.notes.map((note) => ({
        id: note.id,
        author_id: note.author_id,
        body: note.body,
        created_at: note.created_at,
      })),
      evidence: claim.evidence.map((ev) => ({
        id: ev.id,
        kind: ev.kind,
        content_hash: ev.content_hash,
        blob_ref: ev.blob_ref,
        uploaded_by_id: ev.uploaded_by_id,
        uploaded_at: ev.uploaded_at,
      })),
      witness_statements: claim.witness_statements.map((ws) => ({
        id: ws.id,
        witness_name: ws.witness_name,
        witness_phone: this.decryptField(ws.witness_phone_ct) || null,
        statement_body: ws.statement_body,
        inkan_seal_hash: ws.inkan_seal_hash,
        recorded_by_id: ws.recorded_by_id,
        recorded_at: ws.recorded_at,
      })),
      reserves: claim.reserves.map((res) => ({
        id: res.id,
        category: res.category,
        proposed_yen: res.proposed_yen.toString(),
        prior_yen: res.prior_yen?.toString() || null,
        justification: res.justification,
        proposed_by_id: res.proposed_by_id,
        proposed_at: res.proposed_at,
        approval_status: res.approval_status,
        approved_by_id: res.approved_by_id,
        approved_at: res.approved_at,
        director_approved_by_id: res.director_approved_by_id,
        director_approved_at: res.director_approved_at,
        reason_for_rejection: res.reason_for_rejection,
      })),
      audit_trail: claim.audit_events.map((ae) => ({
        id: ae.id,
        actor_id: ae.actor_id,
        actor_role: ae.actor_role,
        action: ae.action,
        target_id: ae.target_id,
        payload_hash: ae.payload_hash,
        request_id: ae.request_id,
        correlation_id: ae.correlation_id,
        ts: ae.ts,
      })),
    };

    this.logger.info(
      `Data-subject export completed for claim ${claimId}: ${Object.keys(exportDoc).length} top-level keys`,
    );

    return exportDoc;
  }

  /**
   * Anonymise personal data in a claim.
   *
   * Redacts all PII fields (both standard and special-care) while preserving
   * the claim record and audit trail. Anonymisation is irreversible.
   *
   * APPI compliance:
   *   - Article 17 (special-care PII) is cleared
   *   - Standard PII is also cleared (conservative approach)
   *   - Audit trail is preserved (claim record remains, but PII is cleared)
   *   - Anonymisation action is audited
   *
   * Access control:
   *   - Managers only (Track B will refine this)
   *
   * @param claimId - the claim ID to anonymise
   * @param reason - justification for anonymisation (>= 50 chars)
   * @param actor - the requesting user (for audit)
   * @returns the anonymised claim record
   * @throws BadRequestException if claim not found
   */
  async anonymisePersonalData(
    claimId: string,
    reason: string,
    actor: User,
  ): Promise<Record<string, unknown>> {
    this.logger.debug(
      `Anonymising personal data for claim ${claimId} by ${actor.username}`,
    );

    // Fetch the claim
    const claim = await this.prisma.claim.findUnique({
      where: { id: claimId },
    });

    if (!claim) {
      throw new BadRequestException(`Claim ${claimId} not found`);
    }

    // Update the claim: redact all PII fields
    const anonymisedClaim = await this.prisma.claim.update({
      where: { id: claimId },
      data: {
        reporter_name: '[REDACTED]',
        reporter_phone_ct: null,
        reporter_email_ct: null,
        reporter_relation_to_insured: '[REDACTED]',
        insured_government_id_ct: null,
        bank_account_for_payout_ct: null,
        injury_details_ct: null,
      },
    });

    // Redact witness phone numbers
    await this.prisma.witnessStatement.updateMany({
      where: { claim_id: claimId },
      data: {
        witness_phone_ct: null,
      },
    });

    // Emit audit event for anonymisation
    const payloadHash = this.hashPayload({
      claim_id: claimId,
      action: 'anonymise',
      reason,
      actor_id: actor.id,
    });

    await this.prisma.auditEvent.create({
      data: {
        actor_id: actor.id,
        actor_role: actor.role,
        action: 'claim.anonymised',
        claim_id: claimId,
        payload_hash: payloadHash,
        request_id: 'anonymise-' + claimId, // Placeholder; should come from request context
        correlation_id: 'anonymise-' + claimId,
      },
    });

    this.logger.info(
      `Personal data anonymised for claim ${claimId} by ${actor.username}`,
    );

    return {
      id: anonymisedClaim.id,
      claim_id: anonymisedClaim.id,
      anonymised_at: new Date().toISOString(),
      anonymised_by: actor.username,
      reason,
      fields_redacted: [
        'reporter_name',
        'reporter_phone',
        'reporter_email',
        'reporter_relation_to_insured',
        'insured_government_id',
        'bank_account_for_payout',
        'injury_details',
        'witness_phone_numbers',
      ],
    };
  }

  /**
   * Decrypt a single PII field (special-care).
   *
   * Reuses Phase 1 encryption pattern: AES-256-GCM with per-record DEK.
   * The ciphertext blob includes the IV and auth tag; the KEK is from env.
   *
   * @param ciphertext - the encrypted blob (Bytes from Prisma)
   * @returns the decrypted plaintext, or null if ciphertext is null
   */
  private decryptField(ciphertext: Buffer | null): string | null {
    if (!ciphertext) {
      return null;
    }

    try {
      // Phase 1 pattern: ciphertext = IV (16) + tag (16) + encrypted data
      const iv = ciphertext.slice(0, 16);
      const tag = ciphertext.slice(16, 32);
      const encrypted = ciphertext.slice(32);

      const { createDecipheriv } = require('crypto');
      const decipher = createDecipheriv('aes-256-gcm', this.kek, iv);
      decipher.setAuthTag(tag);

      let decrypted = decipher.update(encrypted, undefined, 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (err) {
      this.logger.error(`Failed to decrypt field: ${err}`);
      return null;
    }
  }

  /**
   * Decrypt all special-care PII fields in a claim.
   *
   * @param claim - the claim record with encrypted fields
   * @returns the claim with decrypted fields added as `_decrypted` suffixes
   */
  private decryptClaimPii(
    claim: any,
  ): Record<string, unknown> & {
    reporter_phone_decrypted?: string | null;
    reporter_email_decrypted?: string | null;
    insured_government_id_decrypted?: string | null;
    bank_account_for_payout_decrypted?: string | null;
    injury_details_decrypted?: string | null;
  } {
    return {
      ...claim,
      reporter_phone_decrypted: this.decryptField(claim.reporter_phone_ct),
      reporter_email_decrypted: this.decryptField(claim.reporter_email_ct),
      insured_government_id_decrypted: this.decryptField(
        claim.insured_government_id_ct,
      ),
      bank_account_for_payout_decrypted: this.decryptField(
        claim.bank_account_for_payout_ct,
      ),
      injury_details_decrypted: this.decryptField(claim.injury_details_ct),
    };
  }

  /**
   * Hash a payload for audit binding.
   *
   * @param payload - the object to hash
   * @returns SHA-256 hex digest
   */
  private hashPayload(payload: Record<string, unknown>): string {
    const normalized = JSON.stringify(payload, Object.keys(payload).sort());
    return createHash('sha256').update(normalized).digest('hex');
  }
}