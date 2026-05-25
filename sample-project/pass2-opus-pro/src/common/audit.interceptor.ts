import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { PrismaService } from '../prisma.service';

/**
 * Metadata key for the @Audit decorator.
 */
export const AUDIT_KEY = 'audit';

/**
 * Defines the shape of the metadata for an auditable action.
 */
export interface AuditMeta {
  /**
   * A string identifier for the action being performed, e.g., 'UPDATE_EMPLOYEE'.
   */
  action: string;
  /**
   * Optional list of fields relevant to the action, e.g., ['email', 'phone'].
   */
  fields?: string[];
  /**
   * The name of the route parameter holding the ID of the target resource.
   * For example, in '/employees/:id', this would be 'id'.
   */
  targetIdParam?: string;
}

/**
 * A method decorator to mark a route handler for auditing.
 * The AuditInterceptor will pick up this metadata to create a log entry.
 * @param meta The metadata describing the auditable action.
 */
export const Audit = (meta: AuditMeta) => SetMetadata(AUDIT_KEY, meta);

/**
 * Intercepts requests to decorated routes and creates an audit log entry
 * after the handler has successfully completed.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.getAllAndOverride<AuditMeta>(AUDIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // If the handler is not decorated for auditing, pass through.
    if (!meta) {
      return next.handle();
    }

    return next.handle().pipe(
      tap(async () => {
        const req = context.switchToHttp().getRequest();

        // An authenticated user is required to attribute the action.
        if (!req.user?.id) {
          return;
        }

        const targetId = meta.targetIdParam
          ? req.params?.[meta.targetIdParam]
          : null;

        try {
          await this.prisma.auditLog.create({
            data: {
              actor_id: req.user.id,
              action: meta.action,
              target_id: targetId ?? null,
              fields: JSON.stringify(meta.fields ?? []),
              request_id: req.id ?? 'unknown',
            },
          });
        } catch (error) {
          // Audit logging must not fail the original request.
          // In a real-world scenario, this error should be logged to a monitoring service.
          // For now, we silently ignore it.
        }
      }),
    );
  }
}