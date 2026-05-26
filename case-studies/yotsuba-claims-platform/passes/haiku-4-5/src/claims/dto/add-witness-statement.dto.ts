import {
  IsString,
  MinLength,
  MaxLength,
} from 'class-validator';

/**
 * DTO for recording a structured witness statement on a claim.
 *
 * This DTO is used by adjusters to capture witness testimony during the claim
 * investigation process. Witness statements are append-only and immutable;
 * each statement is recorded with a digital seal hash (inkan_seal_hash) that
 * serves as the equivalent of a Japanese seal acknowledgement.
 *
 * Validation rules:
 *   - witness_name: required, non-empty string (>= 5 chars, <= 200 chars)
 *   - witness_phone: optional, non-empty string if provided (>= 10 chars, <= 20 chars)
 *   - statement_body: required, non-empty string (>= 20 chars, <= 10000 chars)
 *   - inkan_seal_hash: required, non-empty string (SHA-256 hex, 64 chars)
 *
 * Authorization:
 *   Only adjusters assigned to the claim can record witness statements.
 *   Managers cannot directly record witness statements; they can only review claims.
 *   Agents and auditors have no witness statement recording capability.
 *
 * Digital seal (inkan_seal_hash):
 *   The inkan_seal_hash is a SHA-256 hash of the canonical statement content
 *   (witness_name + statement_body + recorded_at timestamp) combined with a
 *   digital seal. This serves as the equivalent of a Japanese inkan (seal)
 *   acknowledgement, providing non-repudiation and tamper evidence.
 *   The hash is computed by the client before submission and verified by the backend.
 *
 * Audit trail:
 *   Every witness statement recording emits an AuditEvent with action='claim.witness_statement.recorded',
 *   capturing the actor (adjuster), the claim_id, the witness_name, and the inkan_seal_hash.
 *
 * Immutability:
 *   Witness statements are stored in the WitnessStatement table with recorded_at timestamp
 *   and recorded_by_id. There is no UPDATE or DELETE pathway for witness statements in the codebase.
 *   If a statement contains an error, a new statement is recorded with a correction note.
 *
 * Usage:
 *   const dto = new AddWitnessStatementDto();
 *   dto.witness_name = '田中太郎';
 *   dto.witness_phone = '09012345678';
 *   dto.statement_body = 'I witnessed the collision at the intersection of Shibuya and Omotesando at approximately 14:30 on 2024-01-15. The red vehicle ran the red light and struck the blue vehicle on the driver side.';
 *   dto.inkan_seal_hash = 'a1b2c3d4e5f6...'; // SHA-256 of canonical statement + seal
 *   await claimsService.addWitnessStatement(claimId, dto, adjuster);
 */
export class AddWitnessStatementDto {
  /**
   * Name of the witness.
   * Required; must be a non-empty string of at least 5 characters and at most 200 characters.
   * Stored as UTF-8 plaintext in the WitnessStatement table.
   * Can be in Japanese (e.g., '田中太郎') or other scripts.
   * Examples:
   *   - '田中太郎'
   *   - 'John Smith'
   *   - 'Maria García'
   */
  @IsString()
  @MinLength(5)
  @MaxLength(200)
  witness_name: string;

  /**
   * Phone number of the witness (optional).
   * If provided, must be a non-empty string of at least 10 characters and at most 20 characters.
   * Stored as encrypted blob (APPI standard PII) in the WitnessStatement table.
   * Can include country codes, hyphens, or spaces.
   * Examples:
   *   - '09012345678'
   *   - '+81-90-1234-5678'
   *   - '(555) 123-4567'
   */
  @IsString()
  @MinLength(10)
  @MaxLength(20)
  witness_phone?: string;

  /**
   * Body of the witness statement.
   * Required; must be a non-empty string of at least 20 characters and at most 10000 characters.
   * Stored as UTF-8 plaintext in the WitnessStatement table.
   * Should contain a detailed account of what the witness observed, including:
   *   - Date and time of the incident
   *   - Location details
   *   - Description of the incident
   *   - Parties involved
   *   - Sequence of events
   *   - Any relevant observations about fault or causation
   * Examples:
   *   - 'I witnessed the collision at the intersection of Shibuya and Omotesando at approximately 14:30 on 2024-01-15. The red vehicle ran the red light and struck the blue vehicle on the driver side. I was waiting at the pedestrian crossing and have a clear view of the traffic lights.'
   *   - 'I was working in the adjacent office when I heard a loud crash. I went outside and saw the fire had already spread to the second floor. The sprinkler system appeared to be malfunctioning.'
   */
  @IsString()
  @MinLength(20)
  @MaxLength(10000)
  statement_body: string;

  /**
   * Digital seal hash of the witness statement.
   * Required; must be a 64-character hexadecimal string (SHA-256).
   * Computed as the SHA-256 hash of the canonical statement content
   * (witness_name + statement_body + recorded_at timestamp) combined with a digital seal.
   * This serves as the equivalent of a Japanese inkan (seal) acknowledgement,
   * providing non-repudiation and tamper evidence.
   * The hash is computed by the client before submission and verified by the backend
   * to ensure the statement has not been modified after sealing.
   * Example: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6'
   */
  @IsString()
  @MinLength(64)
  @MaxLength(64)
  inkan_seal_hash: string;
}