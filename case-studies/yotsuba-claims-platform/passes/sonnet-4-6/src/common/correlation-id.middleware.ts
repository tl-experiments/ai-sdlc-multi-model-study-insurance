// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/common/correlation-id.middleware.ts
//
// NestJS middleware that attaches a correlation_id to every incoming HTTP
// request. The correlation_id is:
//   - Read from the incoming `X-Correlation-Id` header if present
//     (propagated from an upstream service or API gateway)
//   - Falls back to the request_id set by RequestIdMiddleware if not supplied
//   - Generated as a new UUID v4 if neither is available
//
// The correlation_id is then:
//   - Attached to `req.correlationId` for downstream use (interceptors, filters)
//   - Set on the response as `X-Correlation-Id` so callers can trace chains
//
// Per design.md §6: Every request has a `correlation_id` propagated through
// every audit event, so the full chain of
//   "agent intake → adjuster note → reserve proposal → approval"
// is reconstructible.
//
// Per brief.md: Pino structured logging with `request_id` + `correlation_id`
// correlation across services.
//
// MUST be registered AFTER RequestIdMiddleware so that `req.requestId` is
// already set when this middleware runs (used as fallback).
//
// Usage in AppModule:
//   consumer
//     .apply(RequestIdMiddleware, CorrelationIdMiddleware)
//     .forRoutes('*');
// =============================================================================

import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The HTTP header name used to carry the correlation ID both inbound and
 * outbound. Lowercased per Node HTTP header normalisation convention.
 */
export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * Maximum length we accept for a caller-supplied correlation ID.
 * Prevents header-injection attacks with oversized values.
 */
const MAX_CORRELATION_ID_LENGTH = 128;

// ---------------------------------------------------------------------------
// Type augmentation
// ---------------------------------------------------------------------------

/**
 * Augment Express Request to carry the correlation_id field injected by
 * this middleware.
 *
 * These fields are read by:
 *   - AuditInterceptor (audit.interceptor.ts)
 *   - GlobalExceptionFilter (error.filter.ts)
 *
 * `requestId` augmentation lives in request-id.middleware.ts; we extend the
 * same interface here for correlationId.
 */
declare module 'express' {
  interface Request {
    /**
     * Correlation ID for this request — either propagated from upstream via
     * X-Correlation-Id, inherited from requestId, or generated as a UUID v4.
     * Set by CorrelationIdMiddleware.
     */
    correlationId?: string;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate and sanitise a caller-supplied correlation ID header value.
 *
 * Accepts values that:
 *   - Are non-empty strings
 *   - Do not exceed MAX_CORRELATION_ID_LENGTH characters
 *   - Contain only URL-safe printable ASCII (alphanumeric, hyphen, underscore,
 *     dot) — same policy as RequestIdMiddleware for consistency
 *
 * Returns the sanitised value, or null if the value is invalid (in which case
 * the middleware falls back to requestId or generates a fresh UUID).
 */
function validateCorrelationId(value: string): string | null {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  if (trimmed.length === 0 || trimmed.length > MAX_CORRELATION_ID_LENGTH) {
    return null;
  }

  // Allow alphanumeric, hyphen, underscore, dot — standard UUID and trace ID chars
  const SAFE_PATTERN = /^[A-Za-z0-9\-_.]+$/;
  if (!SAFE_PATTERN.test(trimmed)) {
    return null;
  }

  return trimmed;
}

/**
 * Extract a correlation ID from the incoming request headers.
 *
 * Checks `x-correlation-id` (canonical lowercase, per Node HTTP headers
 * normalisation). Returns the validated value, or null if absent or invalid.
 */
function extractCorrelationIdFromHeaders(req: Request): string | null {
  const headerValue = req.headers[CORRELATION_ID_HEADER];

  if (!headerValue) {
    return null;
  }

  // Header values can be string or string[] — use only the first value
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  return validateCorrelationId(raw ?? '');
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * CorrelationIdMiddleware — attaches a `correlationId` to every request for
 * cross-service tracing.
 *
 * Resolution order:
 *   1. `X-Correlation-Id` header from the caller (validated)
 *   2. `req.requestId` set by RequestIdMiddleware (inherits within the same
 *      originating request, so single-service flows stay correlated)
 *   3. Freshly generated UUID v4 (last resort — should not happen in practice
 *      when RequestIdMiddleware runs first)
 *
 * Attaches the resolved ID to:
 *   - `req.correlationId` — for downstream NestJS interceptors and filters
 *   - `res.setHeader('X-Correlation-Id', ...)` — for propagation to callers
 *     and downstream services
 *
 * Design note: For multi-service call chains, the originating service sets a
 * correlation_id and every downstream hop preserves it unchanged. This
 * middleware implements the *receiver* side: accept what came in, never
 * generate a new one if a valid one exists. This allows the full chain of
 *   agent intake → adjuster note → reserve proposal → approval
 * to be reconstructible in the audit log by querying correlation_id.
 *
 * Registration (AppModule) — MUST come after RequestIdMiddleware:
 *   consumer
 *     .apply(RequestIdMiddleware, CorrelationIdMiddleware)
 *     .forRoutes('*');
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  private readonly logger = new Logger(CorrelationIdMiddleware.name);

  use(req: Request, res: Response, next: NextFunction): void {
    // Strategy 1: use caller-supplied X-Correlation-Id if present and valid
    const callerSupplied = extractCorrelationIdFromHeaders(req);

    let correlationId: string;
    let source: 'caller' | 'request_id' | 'generated';

    if (callerSupplied !== null) {
      correlationId = callerSupplied;
      source = 'caller';
    } else if (req.requestId) {
      // Strategy 2: inherit from requestId (set by RequestIdMiddleware)
      // This ensures single-hop requests always have correlation_id === request_id
      // so the audit trail is self-consistent without upstream plumbing
      correlationId = req.requestId;
      source = 'request_id';
    } else {
      // Strategy 3: generate a fresh UUID as a last resort
      correlationId = randomUUID();
      source = 'generated';
    }

    // Attach to the request object for downstream consumers
    req.correlationId = correlationId;

    // Echo back on the response so downstream services can propagate it
    // Set before next() so it's included even if the handler throws
    res.setHeader(CORRELATION_ID_HEADER, correlationId);

    this.logger.debug(
      {
        correlation_id: correlationId,
        request_id: req.requestId,
        source,
        path: req.path,
        method: req.method,
      },
      `CorrelationIdMiddleware: correlation_id resolved from ${source}`,
    );

    next();
  }
}