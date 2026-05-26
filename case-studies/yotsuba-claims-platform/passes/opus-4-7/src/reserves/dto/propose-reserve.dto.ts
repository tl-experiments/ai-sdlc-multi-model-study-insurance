// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// Propose-reserve DTO — payload for `POST /claims/:id/reserves`.
//
// The brief specifies (Module 3 — Reserves Management):
//
//   * `category` ∈ `loss_paid` | `loss_unpaid` | `alae` | `ulae` —
//     the IFRS17-aligned reserve buckets (ADR-005, design.md §6);
//   * `proposed_yen` — the new reserve figure, in whole yen. Yen
//     are an indivisible currency unit; the Prisma column is
//     `Decimal(15,0)` and we mirror that here by accepting either
//     a numeric or a string representation and parsing into a
//     `Prisma.Decimal` in the service. At the DTO boundary we
//     validate it as a non-negative integer-valued number-or-string
//     so that JSON clients can submit either shape without losing
//     precision on values above `Number.MAX_SAFE_INTEGER` (a real
//     concern at the JFSA ¥100M threshold and beyond);
//   * `justification` — free text; the brief mandates `>= 50 chars`.
//
// We intentionally do *not* accept `prior_yen` on the DTO: the
// service computes the prior from the most recent approved reserve
// row, so that the API surface cannot be used to misrepresent the
// walk-forward delta. That decision is reinforced by ADR-005 and
// the IFRS17 export shape in `reserves-export.service.ts`.
// ─────────────────────────────────────────────────────────────────────────

import { ReserveCategory } from '@prisma/client';
import {
  IsEnum,
  IsString,
  Matches,
  MinLength,
  ValidateIf,
} from 'class-validator';

/**
 * The set of valid reserve categories, mirrored verbatim from the
 * Prisma enum so that `class-validator`'s `@IsEnum` can do its
 * runtime check. Keeping this here (rather than importing the
 * Prisma enum into the decorator) avoids `class-validator`'s
 * known quirk of mis-reading the const-enum shape that Prisma
 * sometimes emits.
 */
const RESERVE_CATEGORIES: readonly ReserveCategory[] = [
  'loss_paid',
  'loss_unpaid',
  'alae',
  'ulae',
];

/**
 * DTO for `POST /claims/:id/reserves`. See file header for the
 * full rationale on each field.
 */
export class ProposeReserveDto {
  /**
   * IFRS17-aligned reserve bucket. The four buckets are policy
   * (see ADR-005) and not configurable at runtime.
   */
  @IsEnum(RESERVE_CATEGORIES, {
    message: `category must be one of: ${RESERVE_CATEGORIES.join(', ')}.`,
  })
  category!: ReserveCategory;

  /**
   * The proposed reserve in whole yen. Accepts either a JSON
   * number or a string of decimal digits — the latter is required
   * to preserve precision above `Number.MAX_SAFE_INTEGER`
   * (¥9,007,199,254,740,991), which is well within the range of
   * a catastrophic-tier reserve at a top-tier carrier. The service
   * parses this into a `Prisma.Decimal` before persistence.
   *
   * Validation: must match `^\d{1,15}$` after normalisation to a
   * string — i.e. a non-negative integer up to the 15-digit
   * precision of the underlying `Decimal(15,0)` column. Negative
   * reserves are rejected at the DTO boundary; a reserve
   * *reduction* is expressed by proposing a smaller positive
   * figure than the prior.
   */
  @ValidateIf((o: ProposeReserveDto) => typeof o.proposed_yen !== 'string')
  @Matches(/^\d{1,15}$/, {
    message:
      'proposed_yen must be a non-negative integer of at most 15 digits (whole yen).',
  })
  @ValidateIf((o: ProposeReserveDto) => typeof o.proposed_yen === 'string')
  @IsString({ message: 'proposed_yen must be a number or a numeric string.' })
  @Matches(/^\d{1,15}$/, {
    message:
      'proposed_yen must be a non-negative integer of at most 15 digits (whole yen).',
  })
  proposed_yen!: number | string;

  /**
   * Free-text rationale. The brief mandates `>= 50 chars`; the
   * floor reflects the audit-and-actuarial expectation that a
   * reserve change carries a substantive explanation, not a
   * one-word note.
   */
  @IsString({ message: 'justification must be a string.' })
  @MinLength(50, {
    message: 'justification must be at least 50 characters.',
  })
  justification!: string;
}