import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

/**
 * Request ID middleware.
 *
 * Ensures every inbound HTTP request carries a stable `request_id`:
 *   - honours an incoming `X-Request-Id` header when present and well-formed
 *   - otherwise generates a fresh UUIDv4
 *
 * The id is attached to `req.request_id`, mirrored back to the client via
 * the `X-Request-Id` response header, and consumed downstream by the audit
 * interceptor / Pino logger to bind log lines, audit events, and API
 * responses to a single traceable identifier.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  private static readonly HEADER_NAME = 'x-request-id';
  private static readonly MAX_LENGTH = 128;
  // Conservative allow-list: UUIDs, ULIDs, hex/base32-ish opaque tokens.
  private static readonly SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers[RequestIdMiddleware.HEADER_NAME];
    const candidate = Array.isArray(incoming) ? incoming[0] : incoming;

    const requestId =
      typeof candidate === 'string' &&
      candidate.length > 0 &&
      candidate.length <= RequestIdMiddleware.MAX_LENGTH &&
      RequestIdMiddleware.SAFE_ID.test(candidate)
        ? candidate
        : randomUUID();

    (req as Request & { request_id: string }).request_id = requestId;
    res.setHeader('X-Request-Id', requestId);

    next();
  }
}