// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/common/audit.interceptor.ts
//
// NestJS interceptor that automatically emits an immutable AuditEvent row
// for every route handler decorated with @Audit().
//
// Per ADR-002: the audit log has no UPDATE/DELETE pathway in code.
// This interceptor is the SINGLE writer of AuditEvent records.
//
// Flow:
//   1. Before handler: extract request context (actor, request_id, correlation_id)
//   2. Tap the response observable (after handler completes successfully)
//   3. Read @Audit() metadata from the handler via Reflector
//   4. Build AuditEvent payload and write to DB
//   5. Never throw — audit failures are logged but do not fail the request
//
// Claim ID extraction strategy (per AuditOptions):
//   - extractClaimIdFromParam=true (default): read from route :id when under /claims/
//   - claim.created: read claim_id from response body (.id)
//   - reserve/evidence routes: read from :id param (claim_id) + response for target_id
// =============================================================================

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { createHash } from 'crypto';
import type { Request } from 'express';

import { PrismaService } from '../prisma.service';
import { AUDIT_KEY, getAuditOptions } from './audit.decorator';
import type { AuditOptions } from './audit.decorator';
import type { AuthenticatedUser } from './current-user.decorator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of request extended with our middleware-injected IDs */
interface AuditRequest extends Request {
  user?: AuthenticatedUser;
  requestId?: string;
  correlationId?: string;
}

/** Internal payload passed to the DB writer */
interface AuditEventPayload {
  actor_id: string;
  actor_role: string;
  action: string;
  claim_id: string | null;
  target_id: string | null;
  payload_hash: string;
  request_id: string;
  correlation_id: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a stable SHA-256 hash of the audit event payload.
 * The hash is content-binding evidence per ADR-002.
 *
 * We hash a canonical JSON representation that excludes mutable runtime
 * fields (ts, id) so the hash covers what the action *was*, not when.
 */
function hashPayload(data: Record<string, unknown>): string {
  const canonical = JSON.stringify(data, Object.keys(data).sort());
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Sanitise the request body before including it in the payload hash.
 * Strips any field names that contain 'password', '_ct', or known PII
 * field names, so encrypted blobs and passwords are not hashed.
 *
 * This is the APPI concern referenced in AuditOptions.includeBody.
 */
function sanitiseBodyForHash(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {};
  }

  const PII_FIELD_PATTERNS = [
    /password/i,
    /_ct$/,
    /government_id/i,
    /bank_account/i,
    /injury_details/i,
  ];

  const sanitised: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    const isPii = PII_FIELD_PATTERNS.some((re) => re.test(key));
    if (!isPii) {
      sanitised[key] = value;
    }
  }
  return sanitised;
}

/**
 * Extract the claim_id for the audit event based on options and context.
 *
 * Strategy:
 * - If extractClaimIdFromParam=true and there's a route :id param,
 *   use it as claim_id when the path suggests it's a claim route.
 * - For claim.created, the claim_id comes from the response body.
 * - Falls back to null if undetermined.
 */
function extractClaimId(
  options: Required<AuditOptions>,
  req: AuditRequest,
  responseBody: unknown,
): string | null {
  // For claim creation, the claim doesn't exist yet when we enter the handler
  // — extract from response body after handler completes
  if (
    options.action === 'claim.created' ||
    options.action === 'claim.created.mobile' ||
    options.action === 'claim.created.broker' ||
    options.action === 'claim.created.email'
  ) {
    if (responseBody && typeof responseBody === 'object' && !Array.isArray(responseBody)) {
      const body = responseBody as Record<string, unknown>;
      if (typeof body['id'] === 'string') return body['id'];
      if (typeof body['claim_id'] === 'string') return body['claim_id'];
    }
    return null;
  }

  // For routes with :id in the path — check if this is under /claims/
  if (options.extractClaimIdFromParam) {
    const params = req.params as Record<string, string>;
    const path = req.path || req.url || '';

    // /claims/:id routes — the :id IS the claim_id
    if (/^\/claims\/[^/]+/.test(path) && typeof params['id'] === 'string') {
      return params['id'];
    }

    // /reserves/:id routes — claim_id comes from response or body
    if (/^\/reserves\/[^/]+/.test(path)) {
      if (responseBody && typeof responseBody === 'object') {
        const body = responseBody as Record<string, unknown>;
        if (typeof body['claim_id'] === 'string') return body['claim_id'];
      }
      const reqBody = req.body as Record<string, unknown> | undefined;
      if (reqBody && typeof reqBody['claim_id'] === 'string') return reqBody['claim_id'];
      return null;
    }
  }

  return null;
}

/**
 * Extract the target_id for the audit event.
 * Used for sub-resource operations (notes, evidence, witness statements, reserves).
 *
 * target_id is the ID of the created/modified sub-resource, read from the
 * response body after the handler completes.
 */
function extractTargetId(
  options: Required<AuditOptions>,
  req: AuditRequest,
  responseBody: unknown,
): string | null {
  if (!options.extractTargetId) return null;

  if (responseBody && typeof responseBody === 'object' && !Array.isArray(responseBody)) {
    const body = responseBody as Record<string, unknown>;
    if (typeof body['id'] === 'string') return body['id'];
  }

  // For /reserves/:id approve/reject — the reserve id is in the route params
  const params = req.params as Record<string, string>;
  const path = req.path || req.url || '';
  if (/^\/reserves\/[^/]+/.test(path) && typeof params['id'] === 'string') {
    return params['id'];
  }

  return null;
}

// ---------------------------------------------------------------------------
// Interceptor
// ---------------------------------------------------------------------------

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Read @Audit() metadata from the handler
    const handler = context.getHandler();
    const options = getAuditOptions(this.reflector, handler);

    // If the route is not annotated with @Audit(), pass through untouched
    if (!options) {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest<AuditRequest>();

    // Capture request context synchronously before the handler runs
    const actor = req.user;
    const requestId = req.requestId ?? (req.headers['x-request-id'] as string) ?? 'unknown';
    const correlationId =
      req.correlationId ??
      (req.headers['x-correlation-id'] as string) ??
      requestId;

    return next.handle().pipe(
      tap({
        next: (responseBody: unknown) => {
          // Handler completed successfully — emit audit event asynchronously
          // We use void + Promise to fire-and-forget without blocking the response
          void this.emitAuditEvent(
            options,
            req,
            actor,
            requestId,
            correlationId,
            responseBody,
          );
        },
        error: (_err: unknown) => {
          // Do not emit audit events for failed requests.
          // If needed in future, Track B can add failure audit events here.
          // For now, only successful mutations are audited.
        },
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Private — audit event builder + writer
  // ---------------------------------------------------------------------------

  private async emitAuditEvent(
    options: Required<AuditOptions>,
    req: AuditRequest,
    actor: AuthenticatedUser | undefined,
    requestId: string,
    correlationId: string,
    responseBody: unknown,
  ): Promise<void> {
    try {
      // If there's no authenticated user (should not happen on guarded routes,
      // but guard defensively), log and skip rather than throw
      if (!actor) {
        this.logger.warn(
          { action: options.action, requestId },
          'AuditInterceptor: no authenticated user on request; skipping audit event',
        );
        return;
      }

      const claimId = extractClaimId(options, req, responseBody);
      const targetId = extractTargetId(options, req, responseBody);

      // Build the payload to hash
      const rawBody = options.includeBody
        ? sanitiseBodyForHash(req.body as unknown)
        : {};

      const hashInput: Record<string, unknown> = {
        action: options.action,
        actor_id: actor.id,
        actor_role: actor.role,
        claim_id: claimId,
        target_id: targetId,
        request_id: requestId,
        correlation_id: correlationId,
        body: rawBody,
      };

      const payloadHash = hashPayload(hashInput);

      const payload: AuditEventPayload = {
        actor_id: actor.id,
        actor_role: actor.role,
        action: options.action,
        claim_id: claimId,
        target_id: targetId,
        payload_hash: payloadHash,
        request_id: requestId,
        correlation_id: correlationId,
      };

      await this.writeAuditEvent(payload);

      this.logger.debug(
        {
          action: options.action,
          actor_id: actor.id,
          claim_id: claimId,
          request_id: requestId,
        },
        'AuditInterceptor: audit event written',
      );
    } catch (err: unknown) {
      // Audit failures MUST NOT propagate to the caller.
      // Log the failure and continue — the response has already been sent.
      this.logger.error(
        {
          action: options.action,
          requestId,
          error: err instanceof Error ? err.message : String(err),
        },
        'AuditInterceptor: failed to write audit event',
      );
    }
  }

  /**
   * Write the AuditEvent row to the database.
   *
   * Per ADR-002: this is the ONLY write path for audit_events.
   * There is no UPDATE or DELETE pathway anywhere in the codebase.
   *
   * The Prisma call is intentionally not wrapped in the caller's transaction
   * (audit events are independent records — if the main transaction rolls back,
   * we still want to capture that an attempt was made).
   */
  private async writeAuditEvent(payload: AuditEventPayload): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actor_id: payload.actor_id,
        actor_role: payload.actor_role as import('@prisma/client').UserRole,
        action: payload.action,
        claim_id: payload.claim_id ?? undefined,
        target_id: payload.target_id ?? undefined,
        payload_hash: payload.payload_hash,
        request_id: payload.request_id,
        correlation_id: payload.correlation_id,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Re-export key for convenience (so consumers can import from one place)
// ---------------------------------------------------------------------------
export { AUDIT_KEY };