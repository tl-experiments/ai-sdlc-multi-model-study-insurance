// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// APPI anonymise-request DTO — input shape for the
// `DELETE /claims/:id/personal-data-anonymise` route.
//
// The APPI (Act on the Protection of Personal Information)
// grants data subjects a right to request erasure of their
// personal information under defined circumstances. The brief
// (brief.md §Non-functional requirements — APPI compliance
// hooks) translates this into a redaction-with-audit-preserved
// operation: PII fields are scrubbed from the live record, but
// the `AuditEvent` trail of *what happened on this claim* is
// kept intact so the regulator can still reconstruct the
// claim's lifecycle.
//
// The role matrix in brief.md restricts this operation tightly
// (Track A scopes it to no-one — Track B opens it to manager).
// We nonetheless capture the DTO here so the surface is stable
// across passes, and so the audit interceptor has a canonical
// payload to hash when the route is exercised in tests.
//
// Required fields:
//   * `reason`         — a free-text justification (≥ 20 chars).
//                        APPI demands a record of *why* erasure
//                        was performed; the audit row carries it.
//   * `data_subject_name` — the name of the individual whose
//                        PII is being scrubbed. We accept this
//                        as an explicit confirmation rather than
//                        inferring from the claim — anonymise is
//                        destructive, so the caller must state
//                        whose data they're erasing.
//   * `appi_request_reference` — the carrier's internal ticket
//                        ID for the data-subject request. APPI
//                        Article 28/30 expects insurers to log
//                        and respond to such requests in a
//                        traceable manner; this field links the
//                        anonymise action back to the originating
//                        request packet.
//
// Optional:
//   * `acknowledge_irreversible` — a client-side confirmation
//                        flag. When `true` the caller asserts
//                        they understand the operation cannot be
//                        reversed; service-layer code rejects
//                        the request when this is missing or
//                        false, defence in depth against
//                        accidental destructive calls.
// ─────────────────────────────────────────────────────────────────────────

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class AnonymiseRequestDto {
  /**
   * Justification for the anonymisation, captured into the
   * audit trail. APPI requires a documented reason for any
   * erasure of personal data; the minimum-length check is a
   * crude but effective guard against empty / placeholder
   * reasons such as "ok" or "test".
   */
  @ApiProperty({
    description:
      'Free-text justification for the anonymisation. Captured immutably into the audit log.',
    minLength: 20,
    maxLength: 1000,
    example:
      'Data subject erasure request APPI-2024-0312 received via legal@. Verified identity.',
  })
  @IsString()
  @MinLength(20, {
    message: 'reason must be at least 20 characters.',
  })
  @MaxLength(1000, {
    message: 'reason must be at most 1000 characters.',
  })
  reason!: string;

  /**
   * The name of the individual whose PII is being erased.
   * Required as an explicit confirmation — anonymise is
   * destructive and must not be triggerable by claim-id alone.
   */
  @ApiProperty({
    description:
      'Name of the data subject whose personal information is being anonymised. Explicit confirmation — must match the claim record.',
    minLength: 1,
    maxLength: 200,
    example: '山田 太郎',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  data_subject_name!: string;

  /**
   * The carrier's internal reference ID for the originating
   * APPI data-subject request packet. Links the anonymise
   * action back to the request envelope for regulatory
   * traceability.
   */
  @ApiProperty({
    description:
      'Carrier-internal reference ID for the originating APPI data-subject request packet.',
    minLength: 1,
    maxLength: 100,
    example: 'APPI-2024-0312',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  appi_request_reference!: string;

  /**
   * Client-side acknowledgement that the operation is
   * irreversible. The service refuses to proceed unless this
   * is explicitly `true`.
   */
  @ApiPropertyOptional({
    description:
      'Caller confirms understanding that anonymisation is irreversible. Must be true for the request to proceed.',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  acknowledge_irreversible?: boolean;
}