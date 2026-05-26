// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// Add-note DTO.
//
// Wire contract for `POST /claims/:id/notes`. Notes are append-only and
// immutable — the brief is explicit that "corrections add a new note
// rather than mutate" — so this DTO has only the minimum surface area
// required to capture the body of a timestamped entry. The claim and
// author are resolved from the URL path and the JWT respectively, and
// the timestamp is server-stamped at persistence time.
//
// Role authority:
//   * `adjuster` may add notes only to claims assigned to them.
//   * `manager` may add notes on claims belonging to their reports.
//   * `agent`, `auditor`, and `siu_referrer` may not add notes via
//     this route (the SIU flag path is a Track B concern).
// These authority checks live in the service layer, not the DTO.
//
// Validation philosophy:
//   * The DTO enforces only the *shape* of the request: `body` is a
//     bounded non-empty UTF-8 string. UTF-8 includes Japanese
//     characters natively, so no special handling is required at the
//     DTO layer — the database column is `text` and the audit
//     `payload_hash` is computed over the canonicalised UTF-8 bytes.
//   * A minimum length of 1 keeps the contract permissive enough for
//     legitimately short notes (e.g. `paid`, `closed per §4.2`) while
//     still rejecting empty submissions. The 4000-char ceiling matches
//     `initial_description` on `CreateClaimDto` — long enough for a
//     substantive update, short enough to keep the audit hash cheap to
//     compute and the row size predictable.
//   * The note body becomes part of the `AuditEvent.payload_hash`
//     (ADR-002) on `action=claim.note.added`, making the content
//     tamper-evident once written.
// ─────────────────────────────────────────────────────────────────────────

import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Request body for appending an immutable note to a claim's timeline.
 *
 * The controller resolves the author from the JWT and the claim from
 * the path parameter; this body supplies only the note text. The
 * service is responsible for:
 *   * verifying the caller's authority over the claim (assigned
 *     adjuster, or manager-over-reports);
 *   * persisting the `ClaimNote` row with a server-stamped
 *     `created_at`;
 *   * emitting the `claim.note.added` audit event.
 */
export class AddNoteDto {
  /**
   * The body of the note. UTF-8; Japanese input is expected from the
   * adjuster channel. Bounded to keep payloads sane and to make the
   * audit `payload_hash` cheap to compute. Once persisted, the note
   * cannot be edited — corrections are appended as new notes.
   */
  @IsString()
  @MinLength(1, {
    message: 'body must be at least 1 character.',
  })
  @MaxLength(4000, {
    message: 'body must be at most 4000 characters.',
  })
  body!: string;
}