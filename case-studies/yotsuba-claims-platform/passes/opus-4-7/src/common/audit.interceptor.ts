// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// `AuditInterceptor` — the single sanctioned writer of `AuditEvent` rows
// from controller code (ADR-002, audit immutability).
//
// Pairs with `@Audit({...})` (see `src/common/audit.decorator.ts`) which
// attaches `ResolvedAuditOptions` metadata under the `AUDIT_KEY` key. After
// the annotated handler resolves successfully, this interceptor:
//
//   1. Extracts the authenticated caller (`request.user`, attached by
//      `JwtAuthGuard`). If no user is present we still write the audit row
//      with a sentinel actor — auth routes (`auth.login`) legitimately fire
//      before a JWT exists; the auth controller passes the resolved user id
//      through the response body so we can read it back.
//   2. Resolves `claim_id` and `target_id` per the metadata's source
//      directives (`param` | `body` | `response` | `none`).
//   3. Computes a SHA-256 `payload_hash` over a canonicalised projection of
//      the request — method, path, sanitised body, resolved ids, response
//      id — giving the audit row content-binding without storing PII
//      verbatim in the audit log.
//   4. Pulls `request_id` + `correlation_id` from the request (populated by
//      `RequestIdMiddleware` / `CorrelationIdMiddleware`).
//   5. Calls `AuditService.record(...)` to persist the immutable row.
//
// Failures inside the audit-write path are logged but never propagated to
// the caller — refusing to deliver a successful response because the audit
// sidecar hiccupped would be a worse outcome than a logged write failure;
// the surrounding observability (Pino structured logs with correlation_id)
// makes such gaps recoverable. This trade-off is documented in ADR-002.
//
// On handler error the interceptor does NOT write an audit row — the
// action did not take effect, so there is nothing to audit. Authentication
// / authorisation failures are captured separately at the guard layer.
// ─────────────────────────────────────────────────────────────────────────

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'crypto';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { UserRole } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import {
  AUDIT_KEY,
  AuditClaimIdSource,
  AuditTargetIdSource,
  ResolvedAuditOptions,
} from './audit.decorator';
import { CurrentUserPayload } from './current-user.decorator';

/**
 * Shape of the request object the interceptor cares about. Express puts
 * far more on the request than this, but pinning the surface area keeps
 * type-checking honest and prevents accidental reliance on undocumented
 * internals.
 */
interface AuditableRequest {
  method: string;
  originalUrl?: string;
  url?: string;
  params?: Record<string, string>;
  body?: unknown;
  user?: CurrentUserPayload;
  request_id?: string;
  correlation_id?: string;
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Sentinel constants used when we cannot resolve a real value. These are
 * stable strings (not nulls) so that downstream queries / dashboards can
 * group on them without special-casing missing data.
 */
const UNKNOWN_ACTOR_ID = 'unknown';
const UNKNOWN_ROLE: UserRole = 'agent' as UserRole; // safest default; never granted by it

/**
 * Body fields that must never appear in the canonicalised payload we hash.
 * Hashing secrets would let an audit-log reader confirm a guess at the
 * value; we keep the audit log free of any material that could be used
 * for confirmation oracles.
 */
const REDACTED_BODY_FIELDS = new Set<string>([
  'password',
  'password_hash',
  'access_token',
  'refresh_token',
  'insured_government_id',
  'bank_account_for_payout',
  'injury_details',
]);

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly auditService: AuditService,
  ) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const options = this.reflector.get<ResolvedAuditOptions | undefined>(
      AUDIT_KEY,
      context.getHandler(),
    );

    // Route not annotated — pass through untouched. This makes the
    // interceptor safe to register globally.
    if (!options) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<AuditableRequest>();

    return next.handle().pipe(
      tap({
        next: (response: unknown) => {
          // Fire-and-forget; never block the response. Errors inside the
          // promise are logged but not surfaced to the caller.
          void this.writeAuditEvent(options, request, response).catch(
            (err: unknown) => {
              this.logger.error(
                {
                  err,
                  action: options.action,
                  request_id: request.request_id,
                  correlation_id: request.correlation_id,
                },
                'audit_event_write_failed',
              );
            },
          );
        },
        // On error: do not write an audit row. The action did not take
        // effect, so there is no auditable state change. The exception
        // filter and access logger will still capture the failure with
        // the same request_id / correlation_id for traceability.
        error: () => undefined,
      }),
    );
  }

  /**
   * Persist a single `AuditEvent` row for the just-completed handler.
   * Separated from `intercept` so the async/await surface stays tidy and
   * unit tests can drive it directly.
   */
  private async writeAuditEvent(
    options: ResolvedAuditOptions,
    request: AuditableRequest,
    response: unknown,
  ): Promise<void> {
    const actor = request.user;
    const actorId = actor?.id ?? this.fallbackActorId(response) ?? UNKNOWN_ACTOR_ID;
    const actorRole = actor?.role ?? UNKNOWN_ROLE;

    const claimId = this.resolveId(
      options.claimIdFrom,
      options.claimIdField,
      request,
      response,
    );
    const targetId = this.resolveId(
      options.targetIdFrom,
      options.targetIdField,
      request,
      response,
    );

    const requestId =
      request.request_id ?? this.headerString(request, 'x-request-id') ?? 'unknown';
    const correlationId =
      request.correlation_id ??
      this.headerString(request, 'x-correlation-id') ??
      requestId;

    const payloadHash = this.computePayloadHash({
      action: options.action,
      method: request.method,
      path: request.originalUrl ?? request.url ?? '',
      params: request.params ?? {},
      body: sanitiseForHash(request.body),
      claim_id: claimId,
      target_id: targetId,
      actor_id: actorId,
      response_id: extractIdFromResponse(response),
    });

    await this.auditService.record({
      actor_id: actorId,
      actor_role: actorRole,
      action: options.action,
      claim_id: claimId,
      target_id: targetId,
      payload_hash: payloadHash,
      request_id: requestId,
      correlation_id: correlationId,
    });
  }

  /**
   * Resolve a `claim_id` or `target_id` per the source directive on the
   * audit metadata.
   */
  private resolveId(
    source: AuditClaimIdSource | AuditTargetIdSource,
    field: string,
    request: AuditableRequest,
    response: unknown,
  ): string | null {
    switch (source) {
      case 'none':
        return null;
      case 'param': {
        const v = request.params?.[field];
        return typeof v === 'string' && v.length > 0 ? v : null;
      }
      case 'body': {
        const body = request.body;
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          const v = (body as Record<string, unknown>)[field];
          return typeof v === 'string' && v.length > 0 ? v : null;
        }
        return null;
      }
      case 'response': {
        if (response && typeof response === 'object' && !Array.isArray(response)) {
          const v = (response as Record<string, unknown>)[field];
          return typeof v === 'string' && v.length > 0 ? v : null;
        }
        return null;
      }
      default: {
        const _exhaustive: never = source;
        void _exhaustive;
        return null;
      }
    }
  }

  /**
   * For pre-authentication actions (`auth.login`), the handler returns a
   * payload that includes the resolved user id. Pull it from the response
   * so the audit row attributes the action to a real principal rather
   * than the `unknown` sentinel.
   */
  private fallbackActorId(response: unknown): string | null {
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      return null;
    }
    const r = response as Record<string, unknown>;
    const candidates = ['user_id', 'actor_id', 'id'];
    for (const key of candidates) {
      const v = r[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return null;
  }

  /**
   * Read a header value as a single string (collapsing array-shaped
   * headers to their first element). Returns `null` when absent.
   */
  private headerString(
    request: AuditableRequest,
    name: string,
  ): string | null {
    const h = request.headers?.[name];
    if (typeof h === 'string' && h.length > 0) return h;
    if (Array.isArray(h) && h.length > 0 && typeof h[0] === 'string') return h[0];
    return null;
  }

  /**
   * Compute the SHA-256 `payload_hash` over a canonicalised JSON
   * projection. Keys are sorted recursively so that two semantically
   * equivalent payloads always produce the same digest.
   */
  private computePayloadHash(envelope: Record<string, unknown>): string {
    const canonical = canonicalJsonStringify(envelope);
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  }
}

// ─── helpers (file-scoped, pure) ─────────────────────────────────────────

/**
 * Deep-clone the body with redacted-field removal applied at every level.
 * Returning a fresh object protects against later mutation by the handler
 * pipeline and guarantees the hash domain is exactly what we intended.
 */
function sanitiseForHash(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((v) => sanitiseForHash(v));
  }
  // Bytes / Buffers must not appear in the audit hash domain — they are
  // ciphertext blobs whose hash carries no auditable meaning. Collapse to
  // a length marker.
  if (Buffer.isBuffer(value)) {
    return { __bytes_len__: value.length };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (REDACTED_BODY_FIELDS.has(k)) {
      out[k] = '[redacted]';
      continue;
    }
    out[k] = sanitiseForHash(v);
  }
  return out;
}

/**
 * `JSON.stringify` with recursively sorted object keys — produces a
 * stable canonical form suitable for hashing. Arrays preserve order.
 */
function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJsonStringify(v)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const inner = entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJsonStringify(v)}`)
    .join(',');
  return `{${inner}}`;
}

/**
 * Best-effort extraction of an `id` from a handler response, used to
 * stamp the payload hash with the created-row identifier when present.
 */
function extractIdFromResponse(response: unknown): string | null {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return null;
  }
  const v = (response as Record<string, unknown>).id;
  return typeof v === 'string' && v.length > 0 ? v : null;
}