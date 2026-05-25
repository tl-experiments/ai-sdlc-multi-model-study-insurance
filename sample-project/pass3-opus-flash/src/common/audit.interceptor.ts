import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from "@nestjs/common";
import { Observable, tap } from "rxjs";
import { PrismaService } from "../prisma.service";
import { Reflector } from "@nestjs/core";

export const AUDIT_KEY = "audit";
export interface AuditMeta {
  action: string;
  fields?: string[];
  targetIdParam?: string;
}
export const Audit = (meta: AuditMeta) => SetMetadata(AUDIT_KEY, meta);

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService, private readonly reflector: Reflector) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.getAllAndOverride<AuditMeta>(AUDIT_KEY, [ctx.getHandler(), ctx.getClass()]);
    return next.handle().pipe(
      tap(async () => {
        if (!meta) return;
        const req = ctx.switchToHttp().getRequest<{
          user?: { id: string };
          params?: Record<string, string>;
          id?: string;
        }>();
        if (!req || !req.user) return;
        const target = meta.targetIdParam ? req.params?.[meta.targetIdParam] : null;
        try {
          await this.prisma.auditLog.create({
            data: {
              actor_id: req.user.id,
              action: meta.action,
              target_id: target ?? null,
              fields: JSON.stringify(meta.fields ?? []),
              request_id: req.id ?? "unknown",
            },
          });
        } catch {
          /* never break the response */
        }
      })
    );
  }
}