// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// Add-witness-statement DTO.
//
// Wire contract for `POST /claims/:id/witness-statement`. A witness
// statement is a structured record of what a third party observed at
// the loss event — distinct from free-text `ClaimNote` entries (which
// are the adjuster's own narrative) and from `Evidence` attachments
// (which are opaque blobs). The brief calls out one Japan-specific
// element on this surface: an `inkan_seal_hash` field that stands in
// for the traditional 印鑑 (inkan) seal acknowledgement. The hash is
// computed by the client over the canonicalised statement body plus a
// timestamp and a witness identifier, and binds the witness to the
// statement in a tamper-evident way once persisted.
//
// Role authority:
//   * Only `adjuster` may record a witness statement, and only on
//     claims assigned to them. The role check lives in the controller
//     guard; the assignee check lives in the service layer. This DTO
//     only validates request shape.
//
// PII handling:
//   * `witness_name` is standard PII (stored cleartext, role-masked
//     on read — see ADR-003).
//   * `witness_phone` is standard PII; the service encrypts it into
//     `witness_phone_ct` (Bytes) before persistence using the same
//     AES-256-GCM envelope as the rest of the platform (ADR-001).
//     The DTO carries the cleartext on the wire — TLS is the transit
//     protection; encryption-at-rest is the storage protection.
//   * `statement_body` may contain narrative PII (names of other
//     parties, locations, injuries). It is bounded but not
//     encrypted; downstream APPI data-subject-export will surface it
//     verbatim when the witness is the identified individual.
//
// Validation philosophy:
//   * `witness_name` is required and bounded.
//   * `witness_phone` is optional — some witnesses decline to
//     provide one — but when present is bounded to a permissive
//     phone-number shape that accepts Japanese domestic formats
//     (`090-1234-5678`, `03-1234-5678`) as well as E.164
//     (`+81 90 1234 5678`).
//   * `statement_body` has a meaningful minimum length (a one-word
//     witness statement is not useful and likely a mistake) and a
//     ceiling consistent with `ClaimNote.body` and
//     `CreateClaimDto.initial_description`.
//   * `inkan_seal_hash` must be a 64-character lowercase hex sha-256
//     digest — the same canonical form used for `Evidence.content_hash`
//     so that the audit `payload_hash` is deterministic across
//     clients.
//   * The full tuple `(witness_name, statement_body, inkan_seal_hash)`
//     becomes part of the `AuditEvent.payload_hash` on
//     `action=claim.witness_statement.added` (ADR-002), making the
//     statement tamper-evident from the moment it is recorded.
// ─────────────────────────────────────────────────────────────────────────

import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Canonical sha-256 digest as a 64-character lowercase hex string.
 * Identical shape to `Evidence.content_hash` — kept in sync so that
 * any tooling that re-hashes and verifies one can verify the other
 * with the same routine.
 */
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

/**
 * Permissive phone-number shape. Accepts Japanese domestic formats
 * with hyphens (`090-1234-5678`, `03-1234-5678`), bare digit strings,
 * and E.164 international form (`+81 90 1234 5678`). Whitespace,
 * hyphens, parentheses, and a single leading `+` are tolerated; the
 * total digit count is bounded loosely to 7–20 to reject obvious
 * junk while accommodating both domestic and international shapes.
 */
const PHONE_RE = /^\+?[0-9\s\-()]{7,24}$/;

/**
 * Request body for `POST /claims/:id/witness-statement`.
 *
 * The controller resolves the recorder (`recorded_by_id`) from the
 * JWT and the claim from the path parameter; this body supplies the
 * structured statement content and the digital seal hash. The service
 * is responsible for:
 *   * verifying the caller is the assigned adjuster on the claim;
 *   * encrypting `witness_phone` into `witness_phone_ct` before
 *     persistence (AES-256-GCM via env KEK, ADR-001);
 *   * persisting the `WitnessStatement` row with a server-stamped
 *     `recorded_at`;
 *   * emitting the `claim.witness_statement.added` audit event,
 *     whose `payload_hash` covers the canonicalised tuple of
 *     `(witness_name, statement_body, inkan_seal_hash)`.
 */
export class AddWitnessStatementDto {
  /**
   * Full name of the witness as given at the time of statement.
   * Standard PII; stored cleartext and role-masked on read per
   * ADR-003. UTF-8 — Japanese names are expected and supported
   * natively by the underlying `text` column.
   */
  @IsString()
  @MinLength(1, {
    message: 'witness_name must be at least 1 character.',
  })
  @MaxLength(200, {
    message: 'witness_name must be at most 200 characters.',
  })
  witness_name!: string;

  /**
   * Optional contact number for the witness. When supplied, the
   * service encrypts it into `witness_phone_ct` (Bytes) before
   * persistence; the cleartext is never written to the row. Accepts
   * Japanese domestic formats as well as E.164.
   */
  @IsOptional()
  @IsString()
  @Matches(PHONE_RE, {
    message:
      'witness_phone must be a valid phone number '
      + '(Japanese domestic or E.164).',
  })
  witness_phone?: string;

  /**
   * The substantive content of the witness statement: what the
   * witness saw, heard, or otherwise observed. UTF-8; Japanese
   * narrative is expected. Bounded to keep the audit `payload_hash`
   * cheap to compute and the row size predictable. Once persisted,
   * the statement is immutable — corrections are recorded as new
   * witness statements or as `ClaimNote` entries on the timeline.
   */
  @IsString()
  @MinLength(10, {
    message: 'statement_body must be at least 10 characters.',
  })
  @MaxLength(4000, {
    message: 'statement_body must be at most 4000 characters.',
  })
  statement_body!: string;

  /**
   * Digital equivalent of the traditional 印鑑 (inkan) seal
   * acknowledgement: a sha-256 digest computed by the client over
   * the canonical concatenation of the statement body, the witness
   * identifier, and a client timestamp. Expressed as a 64-character
   * lowercase hex string for determinism. Recorded verbatim and
   * included in the audit `payload_hash`, so any subsequent change
   * to the underlying statement would be detectable by re-deriving
   * the seal.
   */
  @IsString()
  @Matches(SHA256_HEX_RE, {
    message:
      'inkan_seal_hash must be a 64-character lowercase hex sha-256 digest.',
  })
  inkan_seal_hash!: string;
}