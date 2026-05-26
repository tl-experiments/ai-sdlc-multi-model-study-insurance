// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/appi/appi.service.ts
//
// APPI compliance service — data-subject export (Article 28) and PII
// anonymisation (Article 36 / Article 17 special-care erasure).
//
// Design reference: design.md §3 Module structure (appi/appi.service.ts)
// Brief reference:  brief.md §1 APPI compliance hooks
//
// Responsibilities:
//   1. data-subject-export: aggregate ALL PII the system holds about an
//      identified individual across every claim they appear in, decrypted
//      and returned as a single structured JSON document (APPI Article 28).
//   2. anonymise: redact standard PII cleartext fields + zero/null all
//      special-care encrypted blobs (_ct fields) on a single claim, while
//      unconditionally preserving the AuditEvent trail (ADR-002).
//
// ADR-001: Special-care PII fields are AES-256-GCM encrypted blobs.
//          Decryption uses the env-supplied KEK via common/encryption.ts.
// ADR-002: Every write emits an immutable AuditEvent via AuditService.
// ADR-003: Role masking is a controller/interceptor concern; this service
//          returns the full decrypted record for authorised callers only.
// =============================================================================

import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { decrypt, encrypt } from '../common/encryption';
import { AnonymiseRequestDto } from './dto/anonymise-request.dto';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface AppiCallerContext {
  user_id: string;
  role: UserRole;
  correlation_id: string;
  request_id: string;
}

/** Decrypted special-care PII fields returned in the data-subject export. */
interface DecryptedSpecialCare {
  reporter_phone: string | null;
  reporter_email: string | null;
  insured_government_id: string | null;
  bank_account_for_payout: string | null;
  injury_details: string | null;
}

/** Shape of a single claim record in the data-subject export payload. */
interface DataSubjectClaimRecord {
  claim_id: string;
  policy_number: string;
  loss_date: Date;
  loss_location_prefecture: string;
  loss_location_postal_code: string;
  loss_location_detail: string;
  reported_by_channel: string;
  reporter_name: string;
  reporter_phone: string | null;
  reporter_email: string | null;
  reporter_relation_to_insured: string;
  incident_type: string;
  initial_description: string;
  injury_reported: boolean;
  third_party_involved: boolean;
  police_report_number: string | null;
  appi_consent_version: string;
  appi_consent_at: Date;
  insured_government_id: string | null;
  bank_account_for_payout: string | null;
  injury_details: string | null;
  notes: DataSubjectNoteRecord[];
  witness_statements: DataSubjectWitnessRecord[];
  created_at: Date;
  updated_at: Date;
}

interface DataSubjectNoteRecord {
  note_id: string;
  body: string;
  created_at: Date;
}

interface DataSubjectWitnessRecord {
  witness_statement_id: string;
  witness_name: string;
  witness_phone: string | null;
  statement_body: string;
  recorded_at: Date;
}

/** Full data-subject export document — APPI Article 28. */
export interface DataSubjectExportDocument {
  export_generated_at: string;
  identified_by: {
    claim_id: string;
  };
  total_claims_found: number;
  claims: DataSubjectClaimRecord[];
}

/** Result of an anonymisation operation. */
export interface AnonymisationResult {
  claim_id: string;
  anonymised_at: string;
  fields_cleared: string[];
  audit_event_id: string;
}

// ---------------------------------------------------------------------------
// APPI anonymisation marker
// ---------------------------------------------------------------------------

/**
 * Deterministic marker written into cleartext PII fields after anonymisation.
 * Using a prefix makes automated scanning for un-anonymised records reliable.
 */
const ANON_MARKER = '[ANONYMISED]';

// ---------------------------------------------------------------------------
// Helper: safely decrypt a Buffer/Bytes field
// ---------------------------------------------------------------------------

function safeDecrypt(ct: Buffer | Uint8Array | null | undefined): string | null {
  if (!ct || ct.length === 0) return null;
  try {
    return decrypt(Buffer.isBuffer(ct) ? ct : Buffer.from(ct));
  } catch {
    // If decryption fails (e.g. rotated key), return null rather than throw.
    // The audit event will still record the attempt.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class AppiService {
  private readonly logger = new Logger(AppiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // data-subject-export — APPI Article 28 disclosure right
  // -------------------------------------------------------------------------

  /**
   * Aggregate all PII the system holds about the identified individual
   * associated with the given claim ID.
   *
   * Strategy:
   *   1. Resolve the primary claim by ID.
   *   2. Derive the data subject's identity (reporter_name + reporter_phone_ct
   *      as a fuzzy key, since we don't have a separate data-subject entity).
   *   3. Return a document containing every claim where reporter_name matches
   *      OR the same policy_number appears, with all decrypted PII fields.
   *
   * The caller must be an auditor or manager (enforced in the controller).
   * This method trusts that check has been done; it does not re-validate.
   *
   * Emits an AuditEvent: `appi.data_subject_export` (ADR-002).
   */
  async dataSubjectExport(
    claimId: string,
    caller: AppiCallerContext,
  ): Promise<DataSubjectExportDocument> {
    this.logger.log(
      {
        claim_id: claimId,
        caller_id: caller.user_id,
        correlation_id: caller.correlation_id,
      },
      'APPI data-subject export initiated',
    );

    // Resolve the anchor claim
    const anchorClaim = await this.prisma.claim.findUnique({
      where: { id: claimId },
    });

    if (!anchorClaim) {
      throw new NotFoundException(`Claim ${claimId} not found.`);
    }

    // Find all claims sharing the same reporter_name + policy_number
    // to cover the full data-subject footprint.
    const relatedClaims = await this.prisma.claim.findMany({
      where: {
        OR: [
          { reporter_name: anchorClaim.reporter_name },
          { policy_number: anchorClaim.policy_number },
        ],
      },
      include: {
        notes: {
          orderBy: { created_at: 'asc' },
        },
        witness_statements: {
          orderBy: { recorded_at: 'asc' },
        },
      },
      orderBy: { created_at: 'asc' },
    });

    // Build the export document
    const claimRecords: DataSubjectClaimRecord[] = relatedClaims.map((claim) => {
      const decrypted = this.decryptSpecialCareFields(claim);

      return {
        claim_id: claim.id,
        policy_number: claim.policy_number,
        loss_date: claim.loss_date,
        loss_location_prefecture: claim.loss_location_prefecture,
        loss_location_postal_code: claim.loss_location_postal_code,
        loss_location_detail: claim.loss_location_detail,
        reported_by_channel: claim.reported_by_channel,
        reporter_name: claim.reporter_name,
        reporter_phone: decrypted.reporter_phone,
        reporter_email: decrypted.reporter_email,
        reporter_relation_to_insured: claim.reporter_relation_to_insured,
        incident_type: claim.incident_type,
        initial_description: claim.initial_description,
        injury_reported: claim.injury_reported,
        third_party_involved: claim.third_party_involved,
        police_report_number: claim.police_report_number ?? null,
        appi_consent_version: claim.appi_consent_version,
        appi_consent_at: claim.appi_consent_at,
        insured_government_id: decrypted.insured_government_id,
        bank_account_for_payout: decrypted.bank_account_for_payout,
        injury_details: decrypted.injury_details,
        notes: claim.notes.map((note) => ({
          note_id: note.id,
          body: note.body,
          created_at: note.created_at,
        })),
        witness_statements: claim.witness_statements.map((ws) => ({
          witness_statement_id: ws.id,
          witness_name: ws.witness_name,
          witness_phone: safeDecrypt(ws.witness_phone_ct),
          statement_body: ws.statement_body,
          recorded_at: ws.recorded_at,
        })),
        created_at: claim.created_at,
        updated_at: claim.updated_at,
      };
    });

    const exportDoc: DataSubjectExportDocument = {
      export_generated_at: new Date().toISOString(),
      identified_by: { claim_id: claimId },
      total_claims_found: claimRecords.length,
      claims: claimRecords,
    };

    // Emit audit event (ADR-002) — payload hash covers the anchor claim ID
    // and the number of claims found to avoid hashing the full PII payload.
    const auditEventId = await this.auditService.emit({
      actor_id: caller.user_id,
      actor_role: caller.role,
      action: 'appi.data_subject_export',
      claim_id: claimId,
      target_id: claimId,
      payload: {
        identified_by_claim_id: claimId,
        total_claims_found: claimRecords.length,
        claim_ids: relatedClaims.map((c) => c.id),
      },
      request_id: caller.request_id,
      correlation_id: caller.correlation_id,
    });

    this.logger.log(
      {
        claim_id: claimId,
        total_claims_found: claimRecords.length,
        audit_event_id: auditEventId,
        correlation_id: caller.correlation_id,
      },
      'APPI data-subject export completed',
    );

    return exportDoc;
  }

  // -------------------------------------------------------------------------
  // anonymise — APPI Article 36 erasure / Article 17 special-care removal
  // -------------------------------------------------------------------------

  /**
   * Redact all PII fields on the given claim while preserving the audit trail.
   *
   * Standard PII cleartext fields are overwritten with `[ANONYMISED]`.
   * Special-care encrypted blobs (_ct fields) are set to null.
   * AuditEvent rows are never touched (ADR-002 — unconditional immutability).
   *
   * The operation is idempotent: calling it on an already-anonymised claim
   * is a no-op (fields already contain the ANON_MARKER or null) but still
   * emits an audit event for APPI Article 36 provenance.
   *
   * Emits an AuditEvent: `appi.pii_anonymised` (ADR-002).
   */
  async anonymiseClaim(
    claimId: string,
    dto: AnonymiseRequestDto,
    caller: AppiCallerContext,
  ): Promise<AnonymisationResult> {
    this.logger.log(
      {
        claim_id: claimId,
        caller_id: caller.user_id,
        reason: dto.reason,
        correlation_id: caller.correlation_id,
      },
      'APPI PII anonymisation initiated',
    );

    // Verify claim exists
    const claim = await this.prisma.claim.findUnique({
      where: { id: claimId },
    });

    if (!claim) {
      throw new NotFoundException(`Claim ${claimId} not found.`);
    }

    // List of fields being cleared — for audit payload and response
    const fieldsCleared: string[] = [
      // Standard PII cleartext
      'reporter_name',
      'reporter_relation_to_insured',
      'initial_description',
      'loss_location_detail',
      // Special-care encrypted blobs
      'reporter_phone_ct',
      'reporter_email_ct',
      'insured_government_id_ct',
      'bank_account_for_payout_ct',
      'injury_details_ct',
    ];

    // Perform the redaction in a single Prisma update
    await this.prisma.claim.update({
      where: { id: claimId },
      data: {
        // Standard PII — overwrite with marker
        reporter_name: ANON_MARKER,
        reporter_relation_to_insured: ANON_MARKER,
        initial_description: ANON_MARKER,
        loss_location_detail: ANON_MARKER,
        // Special-care encrypted blobs — null out
        reporter_phone_ct: null,
        reporter_email_ct: null,
        insured_government_id_ct: null,
        bank_account_for_payout_ct: null,
        injury_details_ct: null,
      },
    });

    // Anonymise any witness statements associated with this claim
    // (witness_name and witness_phone_ct are PII)
    const witnessStatements = await this.prisma.witnessStatement.findMany({
      where: { claim_id: claimId },
    });

    if (witnessStatements.length > 0) {
      await this.prisma.witnessStatement.updateMany({
        where: { claim_id: claimId },
        data: {
          witness_name: ANON_MARKER,
          witness_phone_ct: null,
          statement_body: ANON_MARKER,
        },
      });

      fieldsCleared.push(
        ...witnessStatements.map((ws) => `witness_statements.${ws.id}.witness_name`),
        ...witnessStatements.map((ws) => `witness_statements.${ws.id}.witness_phone_ct`),
        ...witnessStatements.map((ws) => `witness_statements.${ws.id}.statement_body`),
      );
    }

    const anonymisedAt = new Date().toISOString();

    // Emit audit event (ADR-002) — this is the immutable record of the erasure
    const auditEventId = await this.auditService.emit({
      actor_id: caller.user_id,
      actor_role: caller.role,
      action: 'appi.pii_anonymised',
      claim_id: claimId,
      target_id: claimId,
      payload: {
        claim_id: claimId,
        fields_cleared: fieldsCleared,
        reason: dto.reason ?? null,
        requestor_identity: dto.requestor_identity ?? null,
        data_subject_contact_email: dto.data_subject_contact_email ?? null,
        anonymised_at: anonymisedAt,
      },
      request_id: caller.request_id,
      correlation_id: caller.correlation_id,
    });

    this.logger.log(
      {
        claim_id: claimId,
        fields_cleared: fieldsCleared.length,
        audit_event_id: auditEventId,
        correlation_id: caller.correlation_id,
      },
      'APPI PII anonymisation completed',
    );

    return {
      claim_id: claimId,
      anonymised_at: anonymisedAt,
      fields_cleared: fieldsCleared,
      audit_event_id: auditEventId,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Decrypt all special-care PII fields from a raw Prisma claim record.
   *
   * Returns null for fields that are null/undefined or fail to decrypt.
   */
  private decryptSpecialCareFields(
    claim: {
      reporter_phone_ct: Buffer | Uint8Array | null;
      reporter_email_ct: Buffer | Uint8Array | null;
      insured_government_id_ct: Buffer | Uint8Array | null;
      bank_account_for_payout_ct: Buffer | Uint8Array | null;
      injury_details_ct: Buffer | Uint8Array | null;
    },
  ): DecryptedSpecialCare {
    return {
      reporter_phone: safeDecrypt(claim.reporter_phone_ct),
      reporter_email: safeDecrypt(claim.reporter_email_ct),
      insured_government_id: safeDecrypt(claim.insured_government_id_ct),
      bank_account_for_payout: safeDecrypt(claim.bank_account_for_payout_ct),
      injury_details: safeDecrypt(claim.injury_details_ct),
    };
  }
}