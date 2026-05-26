// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/appi/dto/anonymise-request.dto.ts
//
// DTO for the APPI PII anonymisation request.
//
// Design reference: design.md §3 Module structure (appi/dto/anonymise-request.dto.ts)
// Brief reference:  brief.md §1 APPI compliance hooks
//                   DELETE /claims/:id/personal-data-anonymise — redacts PII
//                   while preserving the audit trail.
//
// APPI context:
//   Article 17 special-care PII fields (_ct encrypted blobs) must be
//   zeroed/nulled; standard PII cleartext fields are overwritten with a
//   deterministic anonymisation marker. The audit trail (AuditEvent rows)
//   is never touched — immutability is unconditional (ADR-002).
//
// The DTO is intentionally minimal: the claim ID comes from the route
// parameter (:id), and the anonymisation operation is idempotent. The body
// carries only an optional `reason` for the audit event and an optional
// `requestor_identity` field for APPI Article 28 provenance tracking.
// =============================================================================

import { IsString, IsOptional, MinLength, MaxLength, IsEmail } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Request body for POST /claims/:id/personal-data-anonymise.
 *
 * All fields are optional — the anonymisation operation is valid with an
 * empty body. Providing `reason` and `requestor_identity` enriches the
 * audit event that is emitted on every anonymisation write (ADR-002).
 */
export class AnonymiseRequestDto {
  /**
   * Human-readable justification for the anonymisation request.
   *
   * Stored in the AuditEvent payload so that the data-subject's erasure
   * request (APPI Article 36) or correction request is traceable.
   *
   * Minimum 10 characters to prevent accidental empty-reason submissions.
   * Maximum 500 characters to keep audit payloads bounded.
   */
  @ApiPropertyOptional({
    description:
      'Justification for the anonymisation — e.g. data-subject withdrawal ' +
      'request reference number or regulatory instruction. Stored verbatim ' +
      'in the AuditEvent payload (ADR-002).',
    example: 'Data-subject erasure request ref DS-2024-00312 received via compliance portal.',
    minLength: 10,
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MinLength(10, {
    message: 'reason must be at least 10 characters when provided.',
  })
  @MaxLength(500, {
    message: 'reason must not exceed 500 characters.',
  })
  reason?: string;

  /**
   * Identity of the person or system that initiated the anonymisation
   * request on behalf of the data subject.
   *
   * Typical values:
   *   - A manager's display_name / employee ID (manual compliance workflow).
   *   - A system identifier (e.g. "compliance-portal-batch-job") for
   *     automated erasure pipelines.
   *
   * Not validated against the User table — this is a free-text provenance
   * field for the audit record, not an authentication mechanism.
   */
  @ApiPropertyOptional({
    description:
      'Display name or system identifier of the requestor acting on behalf ' +
      'of the data subject. Recorded in the AuditEvent for APPI Article 36 ' +
      'provenance.',
    example: 'Compliance Officer — Tanaka Keiko (emp-00441)',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200, {
    message: 'requestor_identity must not exceed 200 characters.',
  })
  requestor_identity?: string;

  /**
   * Optional contact email for the data subject making the erasure request.
   *
   * This is the *requestor's* or *data subject's* contact address for the
   * erasure acknowledgement, NOT a system-internal email. It is stored only
   * in the AuditEvent payload and is never persisted to the Claim record
   * (which already has `reporter_email_ct` as an encrypted APPI special-care
   * field). Storing it here allows compliance officers to send confirmation
   * without accessing the claim's encrypted fields.
   */
  @ApiPropertyOptional({
    description:
      'Contact email address for the data subject or their representative ' +
      'to receive anonymisation confirmation. Stored in the AuditEvent ' +
      'payload only — never persisted to the Claim record.',
    example: 'tanaka.ichiro@example.com',
    maxLength: 254,
  })
  @IsOptional()
  @IsEmail(
    {},
    {
      message: 'data_subject_contact_email must be a valid email address when provided.',
    },
  )
  @MaxLength(254, {
    message: 'data_subject_contact_email must not exceed 254 characters (RFC 5321).',
  })
  data_subject_contact_email?: string;
}