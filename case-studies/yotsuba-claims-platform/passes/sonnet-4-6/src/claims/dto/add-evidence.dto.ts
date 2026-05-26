// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/claims/dto/add-evidence.dto.ts
//
// DTO for the POST /claims/:id/evidence endpoint.
//
// Evidence attached to a claim is append-only and immutable (brief.md §2
// Adjuster Workbench). Actual blob storage is stubbed; the platform records
// the content-hash (SHA-256 of the blob) for tamper detection and a blob_ref
// for future retrieval from an S3-compatible store.
//
// Role constraints (brief.md §2 role matrix):
//   - adjuster  — may attach evidence to assigned claims only.
//   - All other roles — no write access to evidence.
// These constraints are enforced in the service layer, not here.
//
// Audit:
//   - Every successful evidence attachment emits an AuditEvent with action
//     'evidence.added', including a payload_hash that binds the content_hash
//     so the tamper-evidence chain is reconstructible (ADR-002).
//
// Content hash:
//   - The content_hash is the SHA-256 hex digest of the raw blob computed
//     client-side (or by the channel ingestion service) before upload.
//     The platform stores it as a string; no server-side re-hashing is
//     performed in the POC. Production Track B will add server-side
//     re-verification on retrieval.
// =============================================================================

import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EvidenceKind } from '@prisma/client';

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

export class AddEvidenceDto {
  /**
   * The type / kind of evidence being attached.
   *
   * Corresponds to the EvidenceKind enum in the Prisma schema:
   *   - photo                     — photograph from the scene or vehicle
   *   - document                  — PDF, scan, or other document
   *   - audio                     — recorded phone call or statement
   *   - video                     — dashcam, CCTV, or field video
   *   - witness_statement_attachment — a document attachment supplementing
   *                                   a structured WitnessStatement record
   */
  @ApiProperty({
    description:
      'Category of the evidence item being attached. ' +
      'Determines how the Adjuster Workbench renders it in the evidence gallery. ' +
      'witness_statement_attachment links this item to a structured ' +
      'WitnessStatement record on the same claim.',
    enum: EvidenceKind,
    example: EvidenceKind.photo,
  })
  @IsEnum(EvidenceKind, {
    message: `kind must be one of: ${Object.values(EvidenceKind).join(', ')}.`,
  })
  kind!: EvidenceKind;

  /**
   * SHA-256 hex digest of the raw blob, computed before upload.
   *
   * This is the tamper-detection anchor for the stored evidence. It must
   * be a lowercase hex string of exactly 64 characters (256 bits / 4 bits
   * per hex digit = 64 hex chars).
   *
   * The platform records the hash against the Evidence row. In Track B,
   * server-side re-verification on retrieval will compare stored vs
   * recomputed hash and alert on mismatch.
   */
  @ApiProperty({
    description:
      'SHA-256 hex digest of the evidence blob, computed client-side prior ' +
      'to upload. Exactly 64 lowercase hex characters. Stored against the ' +
      'Evidence row and included in the AuditEvent payload_hash chain for ' +
      'tamper detection (ADR-002). Track B will add server-side ' +
      're-verification on retrieval.',
    example: 'a3f1c2e4b5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2',
    pattern: '^[0-9a-f]{64}$',
    minLength: 64,
    maxLength: 64,
  })
  @IsString()
  @IsNotEmpty({ message: 'content_hash must not be empty.' })
  @Matches(/^[0-9a-f]{64}$/, {
    message:
      'content_hash must be a valid SHA-256 hex digest: exactly 64 lowercase ' +
      'hexadecimal characters (0-9, a-f).',
  })
  content_hash!: string;

  /**
   * Logical reference to the blob in the (stubbed) S3-compatible object store.
   *
   * Format convention: `s3://stub/<claim_id>/<uuid>.<ext>`
   *
   * In the POC, blob storage is fully stubbed — the platform records only
   * the reference string and does not validate reachability. Track B will
   * wire this to a real object-store client with pre-signed URL generation.
   *
   * Maximum 1024 characters to accommodate deep key paths without unbounded
   * storage in the database.
   */
  @ApiProperty({
    description:
      'Logical reference to the evidence blob in the S3-compatible object ' +
      'store. Format convention: s3://stub/<claim_id>/<uuid>.<ext>. ' +
      'Blob storage is stubbed in Track A — the platform records the ' +
      'reference string without validating reachability. ' +
      'Maximum 1024 characters.',
    example: 's3://stub/clx1a2b3c4d5e6f7g8h9i0j1k/e9f0a1b2-c3d4-e5f6-a7b8-c9d0e1f2a3b4.jpg',
    maxLength: 1024,
  })
  @IsString()
  @IsNotEmpty({ message: 'blob_ref must not be empty.' })
  @MinLength(1)
  @MaxLength(1024, { message: 'blob_ref must not exceed 1024 characters.' })
  blob_ref!: string;

  /**
   * Optional human-readable description of the evidence item.
   *
   * Provides context for the adjuster and reviewer when viewing the evidence
   * gallery in the Adjuster Workbench. Not required but strongly recommended
   * for document and audio evidence where the kind alone is insufficient to
   * identify the item's relevance.
   *
   * Stored as UTF-8; Japanese input expected in the workbench UI.
   * Maximum 512 characters.
   */
  @ApiPropertyOptional({
    description:
      'Optional human-readable description of the evidence item. ' +
      'Displayed in the Adjuster Workbench evidence gallery alongside the ' +
      'kind badge. UTF-8 text; Japanese input expected. ' +
      'Strongly recommended for document and audio evidence. ' +
      'Maximum 512 characters.',
    example: '事故現場の車両損傷状況を撮影した写真（前方右側）。',
    maxLength: 512,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'description must not be blank when provided.' })
  @MaxLength(512, { message: 'description must not exceed 512 characters.' })
  description?: string;
}