import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Reflector } from '@nestjs/core';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma.service';
import { User, UserRole } from '@prisma/client';

/**
 * Audit interceptor that captures and persists audit events for all @Audit()-decorated routes.
 *
 * Context:
 *   Insurance regulators (JFSA) require tamper-evident audit trails. Every write to a claim,
 *   reserve, note, evidence, or witness statement must be recorded with:
 *   - actor_id (who made the change)
 *   - actor_role (their role at the time)
 *   - action (what they did, e.g., 'claim.created')
 *   - claim_id (which claim was affected, if applicable)
 *   - target_id (which sub-resource was affected, e.g., reserve ID)
 *   - payload_hash (sha-256 of normalized request body, for tamper detection)
 *   - request_id (unique per HTTP request, for tracing)
 *   - correlation_id (propagated across service boundaries)
 *   - ts (timestamp)
 *
 * This interceptor is the single writer of AuditEvent rows. No UPDATE/DELETE paths exist
 * in code; audit events are append-only. See ADR-002 for immutability guarantees.
 *
 * Behavior:
 *   1. Check if the route is decorated with @Audit({ action: '...' }).
 *   2. If not decorated, pass through without auditing.
 *   3. If decorated, extract request_id and correlation_id from the request context.
 *   4. Compute sha-256 hash of the normalized request body (JSON stringified).
 *   5. After the handler completes (success or error), emit an AuditEvent row.
 *   6. If the handler throws, still emit the audit event (with error context if available).
 *
 * The audit event is emitted asynchronously (fire-and-forget) to avoid blocking the response.
 * If the audit write fails, it is logged but does not fail the request.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const auditMetadata = this.reflector.get<{ action: string } | undefined>(
      'audit',
      context.getHandler(),
    );

    // If the route is not decorated with @Audit(), pass through without auditing.
    if (!auditMetadata) {
      return next.handle();
    }

    const action = auditMetadata.action;
    const user: User | undefined = request.user;
    const requestId: string = request.request_id || 'unknown';
    const correlationId: string = request.correlation_id || 'unknown';

    // Compute payload hash from the request body.
    const payloadHash = this.computePayloadHash(request.body);

    // Extract claim_id and target_id from the request context if available.
    const claimId: string | undefined = request.params?.id;
    const targetId: string | undefined = request.body?.reserve_id || request.body?.evidence_id;

    // Emit the audit event after the handler completes.
    return next.handle().pipe(
      tap(
        () => {
          // Success path: emit audit event asynchronously.
          this.emitAuditEvent({
            action,
            user,
            requestId,
            correlationId,
            payloadHash,
            claimId,
            targetId,
          }).catch((err) => {
            // Log audit write failures but do not fail the request.
            console.error(
              `Failed to write audit event for action '${action}':`,
              err,
            );
          });
        },
        (err) => {
          // Error path: still emit audit event, then re-throw.
          this.emitAuditEvent({
            action,
            user,
            requestId,
            correlationId,
            payloadHash,
            claimId,
            targetId,
          }).catch((auditErr) => {
            console.error(
              `Failed to write audit event for failed action '${action}':`,
              auditErr,
            );
          });
          throw err;
        },
      ),
    );
  }

  /**
   * Compute sha-256 hash of the normalized request body.
   *
   * Normalization:
   *   - If body is undefined or null, hash the empty string.
   *   - Otherwise, JSON.stringify the body (deterministic order).
   *   - Compute sha-256 of the stringified body.
   *
   * @param body The request body (typically a DTO object)
   * @returns Hex-encoded sha-256 hash
   */
  private computePayloadHash(body: any): string {
    const normalized = body ? JSON.stringify(body) : '';
    return createHash('sha256').update(normalized).digest('hex');
  }

  /**
   * Emit an audit event to the database.
   *
   * @param params Audit event parameters
   */
  private async emitAuditEvent(params: {
    action: string;
    user: User | undefined;
    requestId: string;
    correlationId: string;
    payloadHash: string;
    claimId: string | undefined;
    targetId: string | undefined;
  }): Promise<void> {
    const {
      action,
      user,
      requestId,
      correlationId,
      payloadHash,
      claimId,
      targetId,
    } = params;

    // If no user is authenticated, skip audit (should not happen for @Audit()-decorated routes,
    // as JwtAuthGuard should reject unauthenticated requests first).
    if (!user) {
      console.warn(
        `Audit event '${action}' has no authenticated user; skipping audit write.`,
      );
      return;
    }

    await this.prisma.auditEvent.create({
      data: {
        actor_id: user.id,
        actor_role: user.role,
        action,
        claim_id: claimId,
        target_id: targetId,
        payload_hash: payloadHash,
        request_id: requestId,
        correlation_id: correlationId,
        ts: new Date(),
      },
    });
  }
}