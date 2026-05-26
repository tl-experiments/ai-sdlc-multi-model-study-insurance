import {
  IsString,
  IsEnum,
  MinLength,
  MaxLength,
} from 'class-validator';
import { EvidenceKind } from '@prisma/client';

/**
 * DTO for attaching evidence to a claim.
 *
 * This DTO is used by adjusters to upload and record evidence such as photos,
 * documents, audio recordings, video, or witness statement attachments during
 * the claim investigation process.
 *
 * Validation rules:
 *   - kind: required, must be a valid EvidenceKind enum value
 *   - content_hash: required, non-empty string (SHA-256 hex, 64 chars)
 *   - blob_ref: required, non-empty string (S3-compatible URI)
 *
 * Authorization:
 *   Only adjusters assigned to the claim can attach evidence.
 *   Managers cannot directly attach evidence; they can only review and approve reserves.
 *   Agents and auditors have no evidence attachment capability.
 *
 * Blob storage:
 *   The actual blob (image, document, etc.) is stored in an S3-compatible stub.
 *   The DTO captures the content_hash (SHA-256) for tamper detection and the blob_ref
 *   (URI) for retrieval. The blob storage itself is out of scope for Track A.
 *
 * Audit trail:
 *   Every evidence attachment emits an AuditEvent with action='claim.evidence.added',
 *   capturing the actor (adjuster), the claim_id, the evidence kind, and the content_hash.
 *
 * Immutability:
 *   Evidence records are append-only. Once attached, evidence cannot be deleted or modified.
 *   If evidence is incorrectly attached, a note is added to the claim explaining the error.
 *
 * Usage:
 *   const dto = new AddEvidenceDto();
 *   dto.kind = EvidenceKind.photo;
 *   dto.content_hash = 'a1b2c3d4e5f6...'; // SHA-256 of the image file
 *   dto.blob_ref = 's3://stub/claims/clm_abc123/photo_20240115_001.jpg';
 *   await claimsService.addEvidence(claimId, dto, adjuster);
 */
export class AddEvidenceDto {
  /**
   * Kind of evidence being attached.
   * Must be a valid EvidenceKind enum value:
   *   - photo: photograph of the loss site or damage
   *   - document: PDF, invoice, repair estimate, medical report, etc.
   *   - audio: voice recording of claimant statement or witness interview
   *   - video: video recording of the loss site or damage assessment
   *   - witness_statement_attachment: supporting document for a witness statement
   */
  @IsEnum(EvidenceKind)
  kind: EvidenceKind;

  /**
   * SHA-256 hash of the evidence blob.
   * Required; must be a 64-character hexadecimal string.
   * Used for tamper detection and content binding.
   * Computed by the client before upload; the backend verifies the hash
   * matches the actual blob content when retrieved from storage.
   * Example: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6'
   */
  @IsString()
  @MinLength(64)
  @MaxLength(64)
  content_hash: string;

  /**
   * S3-compatible URI reference for the blob.
   * Required; must be a non-empty string.
   * Format: 's3://bucket/path/to/object' or equivalent stub URI.
   * The blob storage service uses this reference to retrieve the actual file.
   * Examples:
   *   - 's3://stub/claims/clm_abc123/photo_20240115_001.jpg'
   *   - 's3://stub/claims/clm_abc123/repair_estimate.pdf'
   *   - 's3://stub/claims/clm_abc123/witness_audio_001.m4a'
   */
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  blob_ref: string;
}