// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// `@Audit(...)` route metadata decorator.
//
// Pairs with `AuditInterceptor` (see `src/common/audit.interceptor.ts`) which
// reads the metadata attached by this decorator and, on a successful response
// from the annotated handler, writes an immutable `AuditEvent` row capturing
// who did what, against which claim, with which request / correlation IDs.
//
// Usage:
//   @Audit({ action: 'claim.created', claimIdFrom: 'response' })
//   @Post()
//   create(...) { ... }
//
//   @Audit({ action: 'claim.note.add', claimIdFrom: 'param', paramName: 'id' })
//   @Post(':id/notes')
//   addNote(...) { ... }
//
//   @Audit({
//     action: 'reserve.proposed',
//     claimIdFrom: 'param',
//     paramName: 'id',
//     targetIdFrom: 'response',
//   })
//   @Post(':id/reserves')
//   propose(...) { ... }
//
// Notes:
//   * The accepted `action` strings follow the dotted, lowercase convention
//     used throughout the brief (e.g. `claim.created`, `reserve.approved`,
//     `evidence.added`). They are not enum-constrained at the type level on
//     purpose — the audit log accepts any string action so that new domain
//     events can be introduced without a schema migration — but the
//     `KnownAuditAction` union below documents the set in use today and
//     gives IDE autocomplete to callers.
//   * `AUDIT_KEY` is the canonical metadata key — the interceptor must read
//     via the exported symbol rather than re-declaring the string literal.
//   * `@Audit({...})` with an empty `action` is rejected at decoration time;
//     a missing action would produce a useless audit row.
//   * ADR-002 (audit immutability): this decorator is the only sanctioned
//     entry point for writing audit events from controller code. Services
//     that must emit out-of-band events use `AuditService` directly.
// ─────────────────────────────────────────────────────────────────────────

import { SetMetadata, CustomDecorator } from '@nestjs/common';

/**
 * Metadata key under which the audit options are stored on the route
 * handler. `AuditInterceptor` reads this key via `Reflector#get`; both
 * controller-level and method-level annotations are supported but
 * method-level always wins (last-write).
 */
export const AUDIT_KEY = 'yotsuba.audit';

/**
 * Where the interceptor should source the `claim_id` to record on the
 * `AuditEvent` row:
 *
 *   * `'param'`     — pull from a named route parameter (default name `id`);
 *                     used for `/claims/:id/...` style routes.
 *   * `'body'`      — pull from a named body field; used for routes whose
 *                     subject claim is identified in the payload rather than
 *                     the path (rare, but kept for completeness).
 *   * `'response'`  — pull from the handler's returned object (e.g. the
 *                     `id` of a newly-created claim, or a `claim_id` field
 *                     on a newly-created sub-resource).
 *   * `'none'`      — the action has no claim subject (e.g. login, export).
 */
export type AuditClaimIdSource = 'param' | 'body' | 'response' | 'none';

/**
 * Same source taxonomy, applied to the `target_id` field on `AuditEvent`.
 * `target_id` identifies the immediate object of the action when it is
 * distinct from the claim (e.g. a `Reserve.id` for `reserve.approved`, or
 * an `Evidence.id` for `evidence.added`).
 */
export type AuditTargetIdSource = 'param' | 'body' | 'response' | 'none';

/**
 * The set of audit action strings in use across the Track A modules. This
 * union is informational — callers may pass any string — but it gives
 * editor autocomplete and serves as a grep target when reasoning about
 * which events fire where.
 */
export type KnownAuditAction =
  | 'claim.created'
  | 'claim.assigned'
  | 'claim.note.added'
  | 'claim.evidence.added'
  | 'claim.witness_statement.recorded'
  | 'claim.status.transitioned'
  | 'claim.data_subject_export'
  | 'claim.personal_data_anonymised'
  | 'reserve.proposed'
  | 'reserve.approved'
  | 'reserve.director_approved'
  | 'reserve.rejected'
  | 'reserve.export'
  | 'jfsa.notification.emitted'
  | 'auth.login';

/**
 * Options accepted by `@Audit(...)`. Designed so that the common case
 * (`/claims/:id/...` style routes) needs only `{ action }` plus the
 * default `claimIdFrom: 'param'` with `paramName: 'id'`.
 */
export interface AuditOptions {
  /**
   * Dotted, lowercase action verb. Required. Stored verbatim on the
   * `AuditEvent.action` column. See `KnownAuditAction` for the set in
   * use today.
   */
  action: KnownAuditAction | string;

  /**
   * How the interceptor should resolve the `claim_id` for this event.
   * Defaults to `'param'` because the overwhelming majority of audited
   * routes are `/claims/:id/...`.
   */
  claimIdFrom?: AuditClaimIdSource;

  /**
   * Route-parameter or body-field name from which to read the claim id
   * when `claimIdFrom` is `'param'` or `'body'`. Defaults to `'id'`.
   * For `'response'`, this is the property name on the returned object
   * (defaults to `'id'`, which matches a freshly-created Claim row, or
   * `'claim_id'` if explicitly specified for a sub-resource handler).
   */
  claimIdField?: string;

  /**
   * How the interceptor should resolve the `target_id` for this event.
   * Defaults to `'none'` — most claim-scoped events don't have a
   * distinct sub-target. Reserve / evidence / note routes override this
   * to `'response'` so the new row's id is captured.
   */
  targetIdFrom?: AuditTargetIdSource;

  /**
   * Field name to read for `target_id`, with semantics analogous to
   * `claimIdField`. Defaults to `'id'`.
   */
  targetIdField?: string;
}

/**
 * Fully-resolved audit options with defaults applied. The interceptor
 * receives this shape (never the raw `AuditOptions`) so it can rely on
 * every field being populated.
 */
export interface ResolvedAuditOptions {
  action: string;
  claimIdFrom: AuditClaimIdSource;
  claimIdField: string;
  targetIdFrom: AuditTargetIdSource;
  targetIdField: string;
}

/**
 * Apply defaults to a partial `AuditOptions` object. Exported so the
 * interceptor and any tests can share the exact same resolution rules.
 */
export function resolveAuditOptions(opts: AuditOptions): ResolvedAuditOptions {
  return {
    action: opts.action,
    claimIdFrom: opts.claimIdFrom ?? 'param',
    claimIdField: opts.claimIdField ?? 'id',
    targetIdFrom: opts.targetIdFrom ?? 'none',
    targetIdField: opts.targetIdField ?? 'id',
  };
}

/**
 * Mark a controller route as audit-emitting. After the handler returns
 * successfully, `AuditInterceptor` writes an immutable `AuditEvent` row
 * with `actor`, `action`, `claim_id`, `target_id`, `request_id`,
 * `correlation_id`, and a `payload_hash` of the normalised event.
 *
 * @throws Error if `action` is missing or empty — silently writing
 *   action-less audit rows would defeat the entire mechanism, so we
 *   fail loudly at decoration time.
 */
export const Audit = (opts: AuditOptions): CustomDecorator<string> => {
  if (!opts || typeof opts.action !== 'string' || opts.action.length === 0) {
    throw new Error(
      '@Audit(...) requires a non-empty `action` string; refusing to register an action-less audit hook.',
    );
  }
  return SetMetadata(AUDIT_KEY, resolveAuditOptions(opts));
};