import {
  IsString,
  MinLength,
  MaxLength,
} from 'class-validator';

/**
 * DTO for appending a timestamped, immutable note to a claim.
 *
 * This DTO is used by adjusters and managers to add notes during the claim
 * investigation and settlement process. Notes are append-only and immutable;
 * corrections or updates are made by adding a new note rather than editing
 * an existing one.
 *
 * Validation rules:
 *   - body: required, non-empty string (>= 10 chars, <= 5000 chars)
 *
 * Authorization:
 *   - Adjusters can add notes to claims assigned to them.
 *   - Managers can add notes to claims in their reports' pool.
 *   - Agents cannot add notes after initial FNOL submission.
 *   - Auditors have read-only access; cannot add notes.
 *
 * Audit trail:
 *   Every note addition emits an AuditEvent with action='claim.note.added',
 *   capturing the actor (adjuster/manager), the claim_id, and the note body hash.
 *
 * Immutability:
 *   Notes are stored in the ClaimNote table with created_at timestamp and author_id.
 *   There is no UPDATE or DELETE pathway for notes in the codebase.
 *   If a note contains an error, a new note is added with a correction.
 *
 * Usage:
 *   const dto = new AddNoteDto();
 *   dto.body = 'Claimant contacted; confirmed loss date as 2024-01-15. Initial assessment suggests complex claim due to third-party involvement.';
 *   await claimsService.addNote(claimId, dto, adjuster);
 */
export class AddNoteDto {
  /**
   * Body of the note.
   * Required; must be a non-empty string of at least 10 characters and at most 5000 characters.
   * Stored as UTF-8 plaintext in the ClaimNote table.
   * Can include investigation findings, claimant statements, evidence observations,
   * reserve justifications, or any other relevant claim information.
   * Examples:
   *   - 'Claimant contacted; confirmed loss date as 2024-01-15.'
   *   - 'Site inspection completed. Photos attached. Damage consistent with reported incident.'
   *   - 'Third-party liability assessment: 70% claimant fault, 30% third party.'
   *   - 'Reserve increased to ¥5M based on medical report indicating ongoing treatment.'
   *   - 'Settlement offer prepared and sent to claimant on 2024-02-01.'
   */
  @IsString()
  @MinLength(10)
  @MaxLength(5000)
  body: string;
}