import { IsString, IsNotEmpty, MinLength } from 'class-validator';

/**
 * AnonymiseRequestDto
 *
 * Request body for anonymising personal data in a claim.
 *
 * APPI compliance:
 *   - Article 17 (special-care PII) and standard PII fields are redacted
 *   - Audit trail is preserved (claim record remains, but PII is cleared)
 *   - Anonymisation is irreversible; a new data-subject-export will show redacted fields
 *
 * Fields:
 *   - reason: string (>= 50 characters) — justification for anonymisation
 *     (e.g. 'Data subject requested deletion per APPI Article 17')
 */
export class AnonymiseRequestDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(50, {
    message: 'reason must be at least 50 characters',
  })
  reason: string;
}