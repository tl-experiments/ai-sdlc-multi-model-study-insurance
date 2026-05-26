// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/claims/dto/add-note.dto.ts
//
// DTO for the POST /claims/:id/notes endpoint.
//
// Notes on a claim are append-only and immutable (brief.md §2 Adjuster
// Workbench). Once submitted, a note cannot be edited; corrections are
// made by appending a new note. This constraint is enforced at the
// persistence layer in claims.service.ts — there is no UPDATE pathway
// for ClaimNote rows.
//
// Role constraints (brief.md §2 role matrix):
//   - adjuster  — may add notes to assigned claims only.
//   - manager   — may add notes to claims in their reports pool.
//   - agent     — read-only after submission; cannot add notes.
//   - auditor   — read-only; no writes ever.
// These constraints are enforced in the service layer, not here.
//
// Audit:
//   - Every successful note addition emits an AuditEvent with action
//     'claim.note.add', including a payload_hash of the note body so the
//     content is tamper-evident (ADR-002).
//
// Search:
//   - Notes are full-text searchable via the claim detail endpoint but
//     the note body itself is never mutable after creation.
// =============================================================================

import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

export class AddNoteDto {
  /**
   * The body of the note to append to the claim.
   *
   * Notes are stored as UTF-8 text and are intended for entry in Japanese
   * by adjusters and managers. The content is immutable once persisted —
   * any correction requires a new note entry referencing the prior one.
   *
   * Minimum 10 characters to prevent trivial or accidental submissions.
   * Maximum 8192 characters to accommodate detailed investigation narratives.
   */
  @ApiProperty({
    description:
      'Body text of the note to append to the claim. ' +
      'Notes are immutable once submitted — corrections are made by adding ' +
      'a new note referencing the prior entry (ADR-002). ' +
      'UTF-8 text; Japanese input expected in the adjuster workbench UI. ' +
      'Minimum 10 characters; maximum 8192 characters.',
    example:
      '現地調査を実施しました。車両の損傷状況を確認し、修理見積もりを取得しました。' +
      '相手方との過失割合については引き続き協議が必要です。',
    minLength: 10,
    maxLength: 8192,
  })
  @IsString()
  @IsNotEmpty({ message: 'body must not be empty.' })
  @MinLength(10, { message: 'body must be at least 10 characters.' })
  @MaxLength(8192, { message: 'body must not exceed 8192 characters.' })
  body!: string;

  /**
   * Optional tag to categorise the note for filtering and display in the
   * Adjuster Workbench claim timeline.
   *
   * Suggested values (not enum-constrained to allow forward-compatibility):
   *   - 'investigation'  — field investigation finding
   *   - 'communication'  — communication with insured / third party
   *   - 'reserve'        — reserve-related observation
   *   - 'legal'          — legal or coverage question
   *   - 'correction'     — correction referencing a prior note
   *   - 'internal'       — internal administrative note
   *
   * Not validated as an enum at DTO level; freeform tagging is intentional
   * to avoid blocking adjuster workflows with overly rigid categorisation.
   */
  @ApiPropertyOptional({
    description:
      'Optional tag to categorise the note for timeline filtering in the ' +
      'Adjuster Workbench. Freeform string — not enum-constrained to allow ' +
      'forward-compatible tagging. Suggested values: investigation, ' +
      'communication, reserve, legal, correction, internal. ' +
      'Maximum 64 characters.',
    example: 'investigation',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'tag must not be blank when provided.' })
  @MaxLength(64, { message: 'tag must not exceed 64 characters.' })
  tag?: string;
}