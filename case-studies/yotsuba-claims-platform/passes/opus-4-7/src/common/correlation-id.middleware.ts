// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// `CorrelationIdMiddleware` — stamps every inbound HTTP request with a
// stable `correlation_id` and echoes it back on the response.
//
// Where `request_id` (see `request-id.middleware.ts`) identifies a single
// HTTP hop, `correlation_id` identifies an end-to-end *business chain* —
// e.g. an agent FNOL intake (one request) followed by an adjuster note
// (a second request) followed by a reserve proposal + approval (two more)
// can all share a single correlation id so the full claim journey is
// reconstructible from the audit log and structured logs.
//
// Consumers downstream:
//
//   * `AuditInterceptor`         — copies `request.correlation_id` into
//                                  `AuditEvent.correlation_id`, giving the
//                                  audit log a join key across actions.
//   * `GlobalExceptionFilter`    — surfaces `correlation_id` in the error
//                                  envelope alongside `request_id`.
//   * Pino structured logging    — every log line carries the same id.
//
// Resolution rules (in order):
//
//   1. If an inbound `X-Correlation-Id` header is present and conforms to
//      the same conservative whitelist used for request ids (printable
//      ASCII subset, ≤128 chars), trust it. This is the *normal* case:
//      an upstream caller (mobile app, broker portal, API gateway) is
//      already participating in a correlation chain and we honour it.
//   2. Otherwise, generate a fresh id of the form
//      `corr_<32-char hex>` using `crypto.randomUUID()` collapsed to a
//      url-safe slug. The `corr_` prefix makes greps trivially
//      distinguishable from `req_…` request ids.
//
// Ordering note: this middleware MUST run after `RequestIdMiddleware` so
// that the generated fallback can default to the request id when no
// correlation header is present. That fallback is the deliberate design
// choice — for an unchained inbound request, the request id IS the start
// of a new correlation chain, and downstream services receive
// `X-Correlation-Id: <request_id>` so they can join in.
//
// The middleware is side-effect-light: it attaches the resolved id to
// the request object as `request.correlation_id`, sets the
// `X-Correlation-Id` response header, and calls `next()`. Nothing else.
//
// Tests rely on the exported `CorrelationIdMiddleware` class and the
// `CORRELATION_ID_HEADER` constant; both are stable.
// ─────────────────────────────────────────────────────────────────────────

import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

import { RequestWithIds } from './request-id.middleware';

/**
 * Canonical header name. Exported so that interceptors, the exception
 * filter, and tests can reference the same string rather than risk a
 * typo drifting one of them out of sync.
 */
export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * Prefix applied to generated ids. Distinguishes correlation ids from
 * request ids (`req_…`) at a glance in logs and dashboards.
 */
export const CORRELATION_ID_PREFIX = 'corr_';

/**
 * Maximum accepted length for an inbound `X-Correlation-Id` value.
 * Mirrors the request-id middleware's bound so both ingress points
 * impose the same upstream-payload ceiling.
 */
const MAX_INBOUND_ID_LENGTH = 128;

/**
 * Whitelist regex for inbound ids: printable ASCII excluding whitespace
 * and the obvious header-injection characters (CR, LF, NUL). Anything
 * outside this set causes us to discard the inbound value and generate
 * a fresh one rather than echo attacker-controlled data into the logs.
 * Identical to the request-id pattern by design — both ids share the
 * same threat model and the same log-safety constraints.
 */
const INBOUND_ID_PATTERN = /^[A-Za-z0-9._\-:+/=]{1,128}$/;

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: RequestWithIds, res: Response, next: NextFunction): void {
    const inbound = readInboundHeader(req);
    const correlationId =
      inbound ?? req.request_id ?? generateCorrelationId();

    req.correlation_id = correlationId;
    res.setHeader(CORRELATION_ID_HEADER, correlationId);

    next();
  }
}

// ─── helpers (file-scoped, pure) ─────────────────────────────────────────

/**
 * Read and validate an inbound `X-Correlation-Id` header. Returns the
 * value verbatim when it passes the whitelist; `null` otherwise.
 * Array-shaped headers (multiple identically-named headers on the wire)
 * collapse to the first element, matching Express's own normalisation
 * behaviour and the request-id middleware's handling.
 */
function readInboundHeader(req: Request): string | null {
  const raw = req.headers[CORRELATION_ID_HEADER];
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
 * Generate a fresh correlation id. Uses `crypto.randomUUID()` collapsed
 * to a url-safe slug (hyphens removed) and prefixed with `corr_`. The
 * result is ASCII-only, ~37 chars total, and trivially distinguishable
 * from request ids by the prefix.
 */
function generateCorrelationId(): string {
  const slug = randomUUID().replace(/-/g, '');
  return `${CORRELATION_ID_PREFIX}${slug}`;
}