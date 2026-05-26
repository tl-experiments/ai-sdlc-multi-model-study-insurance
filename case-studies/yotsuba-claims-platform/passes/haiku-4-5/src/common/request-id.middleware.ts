import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

/**
 * Request ID middleware that generates and attaches a unique request_id to every incoming request.
 *
 * Context:
 *   Every HTTP request must be traceable through logs, audit events, and service boundaries.
 *   The request_id is a unique identifier (UUID v4) generated at the entry point and attached
 *   to the request object for use by controllers, services, and interceptors.
 *
 * Behavior:
 *   1. Check if the request already has a request_id header (e.g., from an upstream proxy).
 *   2. If not present, generate a new UUID v4.
 *   3. Attach the request_id to the request object as `request.request_id`.
 *   4. Attach the request_id to the response headers as `X-Request-Id` for client tracing.
 *   5. Pass control to the next middleware/handler.
 *
 * Usage:
 *   In app.module.ts, register this middleware globally:
 *     app.use(RequestIdMiddleware);
 *
 * The request_id is then available in:
 *   - Controllers via `request.request_id`
 *   - Interceptors via `context.switchToHttp().getRequest().request_id`
 *   - Audit events via the AuditInterceptor
 *   - Logs via Pino structured logging (injected as a request-scoped context)
 *
 * See also: correlation-id.middleware.ts, which handles correlation_id propagation
 * across service boundaries.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    // Check if request_id is already present (e.g., from upstream proxy or forwarded header).
    const existingRequestId =
      (req.headers['x-request-id'] as string) ||
      (req.headers['request-id'] as string);

    // Use existing request_id or generate a new one.
    const requestId = existingRequestId || uuidv4();

    // Attach request_id to the request object for use by handlers, services, and interceptors.
    (req as any).request_id = requestId;

    // Attach request_id to the response headers for client tracing.
    res.setHeader('X-Request-Id', requestId);

    // Pass control to the next middleware/handler.
    next();
  }
}