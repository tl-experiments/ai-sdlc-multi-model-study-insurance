// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/common/audit.decorator.ts
//
// Method decorator that marks a route handler for automatic audit event
// emission. Used in conjunction with audit.interceptor.ts, which reads
// the metadata attached here and writes an AuditEvent row after the
// handler completes successfully.
//
// Per ADR-002: every write operation must emit an immutable AuditEvent.
// The interceptor is the single writer; this decorator is the single
// way to declare "this route is audited".
//
// Usage:
//   @Audit({ action: 'claim.note.add' })
//   @Post(':id/notes')
//   async addNote(...) { ... }
//
// The interceptor will read the AuditOptions metadata and emit:
//   { actor_id, actor_role, action, claim_id?, target_id?,
//     payload_hash, request_id, correlation_id, ts }
// =============================================================================

import { SetMetadata } from '@nestjs/common';

// ---------------------------------------------------------------------------
// Metadata key
// ---------------------------------------------------------------------------

/**
 * Metadata key used by AuditInterceptor to read audit options from route
 * handler metadata. Must match the key used in audit.interceptor.ts.
 */
export const AUDIT_KEY = 'audit_options';

// ---------------------------------------------------------------------------
// Canonical action strings
// ---------------------------------------------------------------------------

/**
 * Canonical audit action strings for all write operations across the platform.
 *
 * Centralising these here means:
 * - Grep for a string shows every place it's used.
 * - Typos are caught at compile time (TypeScript literal union).
 * - Audit log queries can reference the same constants.
 *
 * Format: <resource>.<operation>
 * Matches the examples in brief.md ("claim.created", "reserve.approved", "evidence.added").
 */
export type AuditAction =
  // Claims — FNOL intake
  | 'claim.created'
  | 'claim.created.mobile'
  | 'claim.created.broker'
  | 'claim.created.email'

  // Claims — Adjuster Workbench
  | 'claim.assigned'
  | 'claim.reassigned'
  | 'claim.status.updated'
  | 'claim.note.add'
  | 'claim.evidence.add'
  | 'claim.witness_statement.add'

  // Reserves
  | 'reserve.proposed'
  | 'reserve.approved'
  | 'reserve.director_approved'
  | 'reserve.rejected'

  // APPI
  | 'appi.data_subject.exported'
  | 'appi.personal_data.anonymised'

  // Auth
  | 'auth.login'
  | 'auth.login.failed';

// ---------------------------------------------------------------------------
// Options interface
// ---------------------------------------------------------------------------

/**
 * Options passed to the @Audit() decorator.
 *
 * These are stored as route-handler metadata and read by AuditInterceptor
 * after the handler completes. The interceptor combines these static options
 * with runtime values (actor, request_id, correlation_id, payload_hash)
 * to build the full AuditEvent record.
 */
export interface AuditOptions {
  /**
   * The canonical action string describing what this route does.
   * Written verbatim into AuditEvent.action.
   *
   * Use one of the AuditAction literal values for type safety:
   *   @Audit({ action: 'claim.note.add' })
   */
  action: AuditAction | string; // string fallback allows extension without modifying this file

  /**
   * Whether to include the request body in the payload hash computation.
   * Default: true.
   *
   * Set to false for routes whose bodies may contain unmasked PII that
   * should not be hashed into the audit log (APPI concern). In those cases
   * the interceptor hashes a sanitised body instead.
   */
  includeBody?: boolean;

  /**
   * Optional static description — stored as a comment in the event but not
   * persisted to the database. Useful for developer documentation.
   */
  description?: string;

  /**
   * If true, the interceptor will attempt to extract `claim_id` from the
   * route params (:id) and attach it to the AuditEvent.
   * Default: true when the route has a `:id` param under /claims/.
   *
   * Set to false for top-level routes (e.g. POST /claims creates the claim
   * and the interceptor reads claim_id from the response body instead).
   */
  extractClaimIdFromParam?: boolean;

  /**
   * If true, the interceptor will attempt to extract `target_id` from the
   * route params or response body. Used for reserve and evidence audit events
   * where the target is a sub-resource of the claim.
   * Default: false.
   */
  extractTargetId?: boolean;
}

// ---------------------------------------------------------------------------
// Decorator
// ---------------------------------------------------------------------------

/**
 * @Audit(options) — mark a route handler for automatic audit event emission.
 *
 * Attach to any controller method that mutates state. The AuditInterceptor
 * will read this metadata after the handler completes and write an immutable
 * AuditEvent row to the database.
 *
 * For read-only routes, do NOT attach @Audit — reads are not audited per
 * brief.md (only writes emit audit events).
 *
 * Example:
 *
 *   @Audit({ action: 'claim.note.add', extractClaimIdFromParam: true })
 *   @Post(':id/notes')
 *   async addNote(@Param('id') id: string, @Body() dto: AddNoteDto) { ... }
 *
 *   @Audit({ action: 'reserve.proposed', extractTargetId: true })
 *   @Post(':id/reserves')
 *   async proposeReserve(...) { ... }
 *
 * Interceptor contract:
 *   - Reads AUDIT_KEY metadata from the handler.
 *   - If not present, skips audit (route is not annotated — read-only).
 *   - Builds AuditEvent from: static options + runtime context.
 *   - Writes AuditEvent inside the same async context as the request.
 *   - Never throws — audit failures are logged but do not fail the request.
 */
export const Audit = (options: AuditOptions): MethodDecorator =>
  SetMetadata(AUDIT_KEY, {
    includeBody: true,
    extractClaimIdFromParam: true,
    extractTargetId: false,
    ...options,
  } satisfies Required<AuditOptions>);

// ---------------------------------------------------------------------------
// Helper — read audit metadata from a handler reference
// ---------------------------------------------------------------------------

/**
 * Retrieve the AuditOptions stored on a handler by @Audit().
 * Used internally by AuditInterceptor; not for general use.
 *
 * Returns undefined if the handler has no @Audit() decorator.
 */
export function getAuditOptions(
  reflector: { get: <T>(key: string, target: object) => T | undefined },
  handler: object,
): Required<AuditOptions> | undefined {
  return reflector.get<Required<AuditOptions>>(AUDIT_KEY, handler);
}