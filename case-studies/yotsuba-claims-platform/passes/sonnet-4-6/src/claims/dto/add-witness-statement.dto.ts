// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/claims/dto/add-witness-statement.dto.ts
//
// DTO for the POST /claims/:id/witness-statement endpoint.
//
// Witness statements are append-only and immutable (brief.md §2 Adjuster
// Workbench). Once recorded, a witness statement cannot be edited. The
// inkan_seal_hash is the digital equivalent of a Japanese hanko seal
// acknowledgement — a SHA-256 digest of the canonical statement body
// concatenated with the recording timestamp, providing tamper-evidence
// and a culturally appropriate acknowledgement pattern for Japanese
// insurance practice.
//
// Role constraints (brief.md §2 role matrix):
//   - adjuster  — may record witness statements on assigned claims only.
//   - All other roles — no write access to witness statements.
// These constraints are enforced in the service layer, not here.
//
// Audit:
//   - Every successful witness statement addition emits an AuditEvent with
//     action 'claim.witness_statement.add', including a payload_hash that
//     binds the inkan_seal_hash for full tamper-evident chaining (ADR-002).
//
// APPI:
//   - witness_phone is treated as standard PII and stored encrypted as
//     witness_phone_ct (Bytes) in the WitnessStatement model per the
//     APPI-tiered protection scheme (ADR-001, ADR-003).
// =============================================================================

import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

export class AddWitnessStatementDto {
  /**
   * Full name of the witness providing the statement.
   *
   * Stored as UTF-8 cleartext (standard PII, APPI-tier: Standard per
   * ADR-003). Role-masked in API responses for non-adjuster roles.
   * Japanese names in full-width characters are supported and expected.
   *
   * Minimum 1 character; maximum 256 characters.
   */
  @ApiProperty({
    description:
      'Full name of the witness providing the statement. ' +
      'Stored as UTF-8 cleartext (standard PII). Role-masked in API responses ' +
      'for roles other than the assigned adjuster (ADR-003). ' +
      'Japanese names in full-width characters are fully supported. ' +
      'Minimum 1 character; maximum 256 characters.',
    example: '山田 太郎',
    minLength: 1,
    maxLength: 256,
  })
  @IsString()
  @IsNotEmpty({ message: 'witness_name must not be empty.' })
  @MaxLength(256, { message: 'witness_name must not exceed 256 characters.' })
  witness_name!: string;

  /**
   * Optional contact phone number for the witness.
   *
   * Treated as standard PII under the APPI tiering scheme (ADR-001,
   * ADR-003). The service layer encrypts this value into witness_phone_ct
   * (AES-256-GCM, env-supplied KEK) before persisting. The cleartext value
   * is never stored in the database.
   *
   * Japanese mobile and landline formats accepted:
   *   - Mobile: 090-XXXX-XXXX, 080-XXXX-XXXX, 070-XXXX-XXXX
   *   - Landline: 0X-XXXX-XXXX (geographic) or 0XX-XXX-XXXX
   * Hyphens optional; digits only also accepted.
   *
   * Maximum 20 characters to accommodate international format where needed.
   */
  @ApiPropertyOptional({
    description:
      'Contact phone number of the witness. Standard PII under APPI — ' +
      'encrypted at rest as witness_phone_ct (AES-256-GCM) in the ' +
      'WitnessStatement record (ADR-001). Cleartext is never persisted. ' +
      'Japanese mobile (090/080/070) and landline formats accepted. ' +
      'Maximum 20 characters.',
    example: '090-1234-5678',
    maxLength: 20,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'witness_phone must not be blank when provided.' })
  @MaxLength(20, { message: 'witness_phone must not exceed 20 characters.' })
  witness_phone?: string;

  /**
   * The full body of the witness statement.
   *
   * Stored as UTF-8 text and intended for entry in Japanese by adjusters
   * in the Adjuster Workbench. The content is immutable once persisted —
   * any correction requires a new WitnessStatement record referencing the
   * prior one.
   *
   * Minimum 20 characters to ensure meaningful statement content.
   * Maximum 16384 characters to accommodate detailed narrative statements
   * while preventing unbounded text storage.
   */
  @ApiProperty({
    description:
      'Full body text of the witness statement. ' +
      'Immutable once persisted — corrections require a new record ' +
      'referencing the prior statement (ADR-002). ' +
      'UTF-8 text; Japanese input expected in the adjuster workbench UI. ' +
      'Minimum 20 characters; maximum 16384 characters.',
    example:
      '事故発生時、私は現場の歩道を歩いていました。午後3時頃、' +
      '交差点において乗用車同士の衝突を目撃しました。' +
      '一方の車両が赤信号を無視して交差点に進入したように見えました。' +
      '負傷者の有無については確認できませんでした。',
    minLength: 20,
    maxLength: 16384,
  })
  @IsString()
  @IsNotEmpty({ message: 'statement_body must not be empty.' })
  @MinLength(20, { message: 'statement_body must be at least 20 characters.' })
  @MaxLength(16384, { message: 'statement_body must not exceed 16384 characters.' })
  statement_body!: string;

  /**
   * Digital seal hash — the Japanese inkan (印鑑) acknowledgement equivalent.
   *
   * This is the SHA-256 hex digest of the canonical statement body
   * concatenated with the recording timestamp (ISO-8601 UTC), serving as
   * the digital equivalent of a Japanese hanko seal affixed to a document.
   * It binds the witness's acknowledgement to a specific version of the
   * statement text at a specific moment in time.
   *
   * Canonical input format for hashing:
   *   `<statement_body>|<recorded_at_iso8601_utc>`
   *
   * The adjuster workbench computes this client-side before submission.
   * The service layer re-verifies the hash against the stored statement_body
   * and recorded_at timestamp to detect tampering (ADR-002).
   *
   * Must be a lowercase hex string of exactly 64 characters (SHA-256 output).
   */
  @ApiProperty({
    description:
      'Digital inkan (印鑑) seal hash — SHA-256 hex digest of the canonical ' +
      'statement body concatenated with the recording timestamp ' +
      '(format: `<statement_body>|<recorded_at_iso8601_utc>`). ' +
      'Serves as the digital equivalent of a Japanese hanko seal, binding ' +
      'the witness acknowledgement to the specific statement content and ' +
      'timestamp (ADR-002). ' +
      'Computed client-side by the Adjuster Workbench before submission. ' +
      'Exactly 64 lowercase hexadecimal characters.',
    example: 'b4c2d1e3f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2',
    pattern: '^[0-9a-f]{64}$',
    minLength: 64,
    maxLength: 64,
  })
  @IsString()
  @IsNotEmpty({ message: 'inkan_seal_hash must not be empty.' })
  @Matches(/^[0-9a-f]{64}$/, {
    message:
      'inkan_seal_hash must be a valid SHA-256 hex digest: exactly 64 lowercase ' +
      'hexadecimal characters (0-9, a-f). ' +
      'Compute as SHA-256 of `<statement_body>|<recorded_at_iso8601_utc>`.',
  })
  inkan_seal_hash!: string;
}