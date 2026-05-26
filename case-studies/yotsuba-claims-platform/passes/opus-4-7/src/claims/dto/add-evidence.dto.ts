// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// Add-evidence DTO.
//
// Wire contract for `POST /claims/:id/evidence`. Evidence is the
// non-textual side of the case file — photographs of damage, scanned
// repair estimates, dash-cam clips, witness-statement attachments —
// and per the brief actual blob storage is stubbed in Track A: the
// API records a *reference* (`blob_ref`, e.g. `s3://stub/...`) and a
// `content_hash` (sha-256 hex) that gives the row tamper-evidence.
//
// Role authority:
//   * Only `adjuster` may attach evidence, and only on claims
//     assigned to them. The role check lives in the controller guard
//     and the assignee check in the service layer; this DTO only
//     validates request shape.
//
// Validation philosophy:
//   * `kind` must be a member of the `EvidenceKind` Prisma enum.
//   * `content_hash` must be a 64-character lowercase hex string — a
//     canonical sha-256 digest. We reject mixed case to keep the
//     audit `payload_hash` deterministic across clients.
//   * `blob_ref` is a bounded URI-shaped string. We do not bind to a
//     specific scheme here (the POC uses `s3://stub/...` but the
//     contract should survive a swap to a real object store) — we
//     only require a scheme prefix and a non-empty path.
//   * The trio `(kind, content_hash, blob_ref)` is what gets hashed
//     into `AuditEvent.payload_hash` on `action=claim.evidence.added`
//     (ADR-002), making the attachment record tamper-evident even
//     though the blob itself lives outside the database.
// ─────────────────────────────────────────────────────────────────────────

import { IsEnum, IsString, Matches, MaxLength, MinLength } from 'class-validator';

import { EvidenceKind } from '@prisma/client';

/**
 * Canonical sha-256 digest as a 64-character lowercase hex string.
 * The hash is computed by the client over the raw blob bytes before
 * upload; the server stores it verbatim and uses it later to detect
 * tampering should the blob store ever be re-fetched and re-hashed.
 */
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

/**
 * URI-shaped blob reference. Requires a non-empty scheme followed by
 * `://` and a non-empty opaque path. The POC uses `s3://stub/<id>`
 * but the regex is deliberately permissive so the contract survives a
 * swap to a real object store (`s3://`, `gs://`, `https://`, ...).
 */
const BLOB_REF_RE = /^[a-z][a-z0-9+.-]*:\/\/\S+$/;

/**
 * Request body for `POST /claims/:id/evidence`.
 *
 * The controller resolves the uploader from the JWT and the claim
 * from the path parameter; this body supplies only the attachment
 * metadata. The service is responsible for:
 *   * verifying the caller is the assigned adjuster on the claim;
 *   * persisting the `Evidence` row with a server-stamped
 *     `uploaded_at`;
 *   * emitting the `claim.evidence.added` audit event, whose
 *     `payload_hash` covers `(kind, content_hash, blob_ref)`.
 */
export class AddEvidenceDto {
  /**
   * Kind of evidence. Must be a member of the `EvidenceKind` enum
   * defined in the Prisma schema:
   * `photo` | `document` | `audio` | `video` |
   * `witness_statement_attachment`.
   */
  @IsEnum(EvidenceKind, {
    message:
      'kind must be one of: photo, document, audio, video, '
      + 'witness_statement_attachment.',
  })
  kind!: EvidenceKind;

  /**
   * sha-256 digest of the blob bytes, expressed as a 64-character
   * lowercase hex string. Used downstream to detect tampering: a
   * future audit job can re-hash the blob and compare. Mixed-case
   * submissions are rejected to keep the audit `payload_hash`
   * deterministic across clients.
   */
  @IsString()
  @Matches(SHA256_HEX_RE, {
    message:
      'content_hash must be a 64-character lowercase hex sha-256 digest.',
  })
  content_hash!: string;

  /**
   * Opaque reference to the blob in object storage. The POC uses
   * `s3://stub/<id>` placeholders, but any well-formed URI with a
   * scheme and a non-empty path is accepted so the contract survives
   * a swap to a real backend. Bounded to keep the audit hash cheap to
   * compute and the row size predictable.
   */
  @IsString()
  @MinLength(8, {
    message: 'blob_ref must be at least 8 characters.',
  })
  @MaxLength(1024, {
    message: 'blob_ref must be at most 1024 characters.',
  })
  @Matches(BLOB_REF_RE, {
    message:
      'blob_ref must be a URI with a scheme prefix '
      + '(e.g. s3://stub/<id>).',
  })
  blob_ref!: string;
}