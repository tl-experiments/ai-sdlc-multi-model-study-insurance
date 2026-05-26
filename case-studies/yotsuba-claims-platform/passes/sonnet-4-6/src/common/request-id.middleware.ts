// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/common/request-id.middleware.ts
//
// NestJS middleware that attaches a unique request_id to every incoming HTTP
// request. The request_id is:
//   - Read from the incoming `X-Request-Id` header if present (caller-supplied)
//   - Generated as a new UUID v4 if not supplied
//
// The request_id is then:
//   - Attached to `req.requestId` for downstream use (interceptors, filters)
//   - Set on the response as `X-Request-Id` so callers can correlate
//
// Per brief.md: Pino structured logging with `request_id` + `correlation_id`
// correlation across services. This middleware handles the request_id half;
// correlation-id.middleware.ts handles correlation_id propagation.
//
// Usage in AppModule:
//   consumer
//     .apply(RequestIdMiddleware)
//     .forRoutes('*');
// =============================================================================

import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The HTTP header name used to carry the request ID both inbound and outbound.
 * Using a standard header name that API gateways and load balancers recognise.
 */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Maximum length we accept for a caller-supplied request ID.
 * Prevents header-injection attacks with oversized values.
 */
const MAX_REQUEST_ID_LENGTH = 128;

// ---------------------------------------------------------------------------
// Type augmentation
// ---------------------------------------------------------------------------

/**
 * Augment Express Request to carry our middleware-injected fields.
 *
 * These are read by:
 *   - AuditInterceptor (audit.interceptor.ts)
 *   - CorrelationIdMiddleware (correlation-id.middleware.ts)
 *   - GlobalExceptionFilter (error.filter.ts)
 *
 * Declaring the interface extension here (rather than globally) keeps the
 * augmentation co-located with the middleware that sets the field.
 */
declare module 'express' {
  interface Request {
    /**
     * Unique ID for this request — either caller-supplied via X-Request-Id
     * or generated as a UUID v4. Set by RequestIdMiddleware.
     */
    requestId?: string;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate and sanitise a caller-supplied request ID header value.
 *
 * Accepts values that:
 *   - Are non-empty strings
 *   - Do not exceed MAX_REQUEST_ID_LENGTH characters
 *   - Contain only URL-safe printable ASCII (alphanumeric, hyphen, underscore, dot)
 *
 * Returns the sanitised value, or null if the value is invalid (in which case
 * the middleware will generate a fresh UUID instead).
 */
function validateRequestId(value: string): string | null {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  if (trimmed.length === 0 || trimmed.length > MAX_REQUEST_ID_LENGTH) {
    return null;
  }

  // Allow alphanumeric, hyphen, underscore, dot — standard UUID and trace ID chars
  // Reject anything that looks like injection or unusual encoding
  const SAFE_PATTERN = /^[A-Za-z0-9\-_.]+$/;
  if (!SAFE_PATTERN.test(trimmed)) {
    return null;
  }

  return trimmed;
}

/**
 * Extract a request ID from the incoming request headers.
 *
 * Checks `x-request-id` (canonical lowercase, per Node HTTP headers normalisation).
 * Returns the validated value, or null if absent or invalid.
 */
function extractRequestIdFromHeaders(req: Request): string | null {
  const headerValue = req.headers[REQUEST_ID_HEADER];

  if (!headerValue) {
    return null;
  }

  // Header values can be string or string[] (multiple headers with same name)
  // We use only the first value if multiple are supplied
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  return validateRequestId(raw ?? '');
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * RequestIdMiddleware — attaches a unique `requestId` to every request.
 *
 * Reads `X-Request-Id` from incoming headers; generates a UUID v4 if absent
 * or invalid. Attaches the resolved ID to both:
 *   - `req.requestId` — for downstream NestJS interceptors and filters
 *   - `res.setHeader('X-Request-Id', ...)` — for the caller to correlate
 *
 * This middleware MUST be registered before CorrelationIdMiddleware so that
 * CorrelationIdMiddleware can fall back to requestId when no X-Correlation-Id
 * header is present.
 *
 * Registration (AppModule):
 *   consumer
 *     .apply(RequestIdMiddleware, CorrelationIdMiddleware)
 *     .forRoutes('*');
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestIdMiddleware.name);

  use(req: Request, res: Response, next: NextFunction): void {
    // Attempt to use caller-supplied request ID
    const callerSupplied = extractRequestIdFromHeaders(req);

    let requestId: string;

    if (callerSupplied !== null) {
      // Use the validated caller-supplied ID
      requestId = callerSupplied;

      this.logger.debug(
        { request_id: requestId, path: req.path, method: req.method },
        'RequestIdMiddleware: using caller-supplied request ID',
      );
    } else {
      // Generate a fresh UUID v4
      requestId = randomUUID();

      this.logger.debug(
        { request_id: requestId, path: req.path, method: req.method },
        'RequestIdMiddleware: generated new request ID',
      );
    }

    // Attach to the request object for downstream consumers
    req.requestId = requestId;

    // Echo back on the response so callers can correlate their logs
    // Set before next() so it's included even if the handler throws
    res.setHeader(REQUEST_ID_HEADER, requestId);

    next();
  }
}