import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

/**
 * Correlation ID middleware.
 *
 * Propagates a `correlation_id` across the full chain of operations that
 * make up a single business transaction (e.g. agent intake → adjuster note
 * → reserve proposal → manager approval). Unlike `request_id`, which is
 * unique per HTTP request, `correlation_id` is intended to be reused by
 * upstream clients so a multi-call workflow can be reconstructed end-to-end.
 *
 *   - honours an incoming `X-Correlation-Id` header when present and well-formed
 *   - falls back to the request's `request_id` if already assigned (by
 *     `RequestIdMiddleware` running earlier in the pipeline)
 *   - otherwise generates a fresh UUIDv4
 *
 * The id is attached to `req.correlation_id`, mirrored back to the client
 * via the `X-Correlation-Id` response header, and consumed downstream by
 * the audit interceptor and Pino logger so every emitted `AuditEvent` row
 * carries both `request_id` and `correlation_id`.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  private static readonly HEADER_NAME = 'x-correlation-id';
  private static readonly MAX_LENGTH = 128;
  // Conservative allow-list: UUIDs, ULIDs, hex/base32-ish opaque tokens.
  private static readonly SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers[CorrelationIdMiddleware.HEADER_NAME];
    const candidate = Array.isArray(incoming) ? incoming[0] : incoming;

    const fromHeader =
      typeof candidate === 'string' &&
      candidate.length > 0 &&
      candidate.length <= CorrelationIdMiddleware.MAX_LENGTH &&
      CorrelationIdMiddleware.SAFE_ID.test(candidate)
        ? candidate
        : undefined;

    const existingRequestId = (req as Request & { request_id?: string }).request_id;

    const correlationId = fromHeader ?? existingRequestId ?? randomUUID();

    (req as Request & { correlation_id: string }).correlation_id = correlationId;
    res.setHeader('X-Correlation-Id', correlationId);

    next();
  }
}