import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

/**
 * Correlation ID middleware that generates and propagates a correlation_id across service boundaries.
 *
 * Context:
 *   In a distributed system, a single user action (e.g., "agent submits FNOL claim") may trigger
 *   multiple internal service calls, database writes, and asynchronous events. The correlation_id
 *   is a unique identifier that ties all of these together, enabling end-to-end tracing and audit
 *   reconstruction.
 *
 *   For example:
 *     - Agent submits FNOL claim via POST /claims
 *     - Backend generates correlation_id (or accepts one from X-Correlation-Id header)
 *     - Claim is created, AuditEvent is written, NotificationToRegulator may be emitted
 *     - All events share the same correlation_id
 *     - Later, auditor queries audit log and can reconstruct the entire chain
 *
 * Behavior:
 *   1. Check if the request already has a correlation_id header (e.g., from an upstream proxy,
 *      or from a client that wants to group multiple requests).
 *   2. If not present, generate a new UUID v4.
 *   3. Attach the correlation_id to the request object as `request.correlation_id`.
 *   4. Attach the correlation_id to the response headers as `X-Correlation-Id` for client tracing.
 *   5. Pass control to the next middleware/handler.
 *
 * Usage:
 *   In app.module.ts, register this middleware globally:
 *     app.use(CorrelationIdMiddleware);
 *
 * The correlation_id is then available in:
 *   - Controllers via `request.correlation_id`
 *   - Interceptors via `context.switchToHttp().getRequest().correlation_id`
 *   - Audit events via the AuditInterceptor (stored in AuditEvent.correlation_id)
 *   - Logs via Pino structured logging (injected as a request-scoped context)
 *   - Asynchronous event emitters (e.g., reserves-jfsa.service.ts)
 *
 * Difference from request_id:
 *   - request_id: unique per HTTP request; used for single-request tracing.
 *   - correlation_id: may span multiple requests; used for end-to-end tracing of a business action.
 *
 * See also: request-id.middleware.ts, which handles per-request unique identification.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    // Check if correlation_id is already present (e.g., from upstream proxy or client header).
    const existingCorrelationId =
      (req.headers['x-correlation-id'] as string) ||
      (req.headers['correlation-id'] as string);

    // Use existing correlation_id or generate a new one.
    const correlationId = existingCorrelationId || uuidv4();

    // Attach correlation_id to the request object for use by handlers, services, and interceptors.
    (req as any).correlation_id = correlationId;

    // Attach correlation_id to the response headers for client tracing.
    res.setHeader('X-Correlation-Id', correlationId);

    // Pass control to the next middleware/handler.
    next();
  }
}