// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// `RequestIdMiddleware` — stamps every inbound HTTP request with a stable
// `request_id` and echoes it back on the response.
//
// Pairs with `CorrelationIdMiddleware` (which handles cross-service trace
// propagation) and is consumed downstream by:
//
//   * `AuditInterceptor`         — copies `request.request_id` into the
//                                  immutable `AuditEvent.request_id` column.
//   * `GlobalExceptionFilter`    — surfaces `request_id` in the error
//                                  envelope so support tickets carry a
//                                  primary key into the structured logs.
//   * Pino structured logging    — every log line associated with the
//                                  request carries the same id.
//
// Resolution rules (in order):
//
//   1. If an inbound `X-Request-Id` header is present and conforms to a
//      conservative whitelist (printable ASCII, ≤128 chars, no control
//      characters), trust it. This lets upstream API gateways propagate
//      their own ids end-to-end.
//   2. Otherwise, generate a fresh id of the form `req_<22-char base64url>`
//      using `crypto.randomUUID()` collapsed to a url-safe slug. The
//      `req_` prefix makes greps trivially distinguishable from
//      `corr_…` correlation ids.
//
// The middleware is intentionally side-effect-light: it attaches the
// resolved id to the request object as `request.request_id`, sets the
// `X-Request-Id` response header, and calls `next()`. Nothing else.
//
// Tests rely on the exported `RequestIdMiddleware` class and the
// `REQUEST_ID_HEADER` constant; both are stable.
// ─────────────────────────────────────────────────────────────────────────

import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

/**
 * Canonical header name. Exported so that interceptors, the exception
 * filter, and tests can reference the same string rather than risk a
 * typo drifting one of them out of sync.
 */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Prefix applied to generated ids. Distinguishes request ids from
 * correlation ids (`corr_…`) at a glance in logs and dashboards.
 */
export const REQUEST_ID_PREFIX = 'req_';

/**
 * Maximum accepted length for an inbound `X-Request-Id` value. Chosen
 * generously enough to accept common formats (UUIDs, short ULIDs, AWS
 * X-Ray ids) while bounding log-line growth and rejecting pathological
 * upstream payloads.
 */
const MAX_INBOUND_ID_LENGTH = 128;

/**
 * Whitelist regex for inbound ids: printable ASCII excluding whitespace
 * and the obvious header-injection characters (CR, LF, NUL). Anything
 * outside this set causes us to discard the inbound value and generate
 * a fresh one rather than echo attacker-controlled data into the logs.
 */
const INBOUND_ID_PATTERN = /^[A-Za-z0-9._\-:+/=]{1,128}$/;

/**
 * Request shape extended with the fields this middleware populates.
 * Exported so other middlewares / interceptors in `common/` can refer
 * to the same augmented type without redeclaring it.
 */
export interface RequestWithIds extends Request {
  request_id?: string;
  correlation_id?: string;
}

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: RequestWithIds, res: Response, next: NextFunction): void {
    const inbound = readInboundHeader(req);
    const requestId = inbound ?? generateRequestId();

    req.request_id = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);

    next();
  }
}

// ─── helpers (file-scoped, pure) ─────────────────────────────────────────

/**
 * Read and validate an inbound `X-Request-Id` header. Returns the value
 * verbatim when it passes the whitelist; `null` otherwise. Array-shaped
 * headers (multiple identically-named headers on the wire) collapse to
 * the first element, matching Express's own normalisation behaviour.
 */
function readInboundHeader(req: Request): string | null {
  const raw = req.headers[REQUEST_ID_HEADER];
  let candidate: string | undefined;

  if (typeof raw === 'string') {
    candidate = raw;
  } else if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') {
    candidate = raw[0];
  }

  if (!candidate) return null;
  if (candidate.length === 0 || candidate.length > MAX_INBOUND_ID_LENGTH) return null;
  if (!INBOUND_ID_PATTERN.test(candidate)) return null;

  return candidate;
}

/**
 * Generate a fresh request id. Uses `crypto.randomUUID()` collapsed to a
 * url-safe slug (hyphens removed) and prefixed with `req_`. The result
 * is ASCII-only, ~36 chars total, and trivially distinguishable from
 * correlation ids by the prefix.
 */
function generateRequestId(): string {
  const slug = randomUUID().replace(/-/g, '');
  return `${REQUEST_ID_PREFIX}${slug}`;
}