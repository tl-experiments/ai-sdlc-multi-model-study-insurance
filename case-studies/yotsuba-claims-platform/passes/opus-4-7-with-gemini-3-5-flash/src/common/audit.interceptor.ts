import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { AUDIT_KEY, AuditOptions } from './audit.decorator';
import { maskObject } from './pii-mask.util';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger('AuditInterceptor');

  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const hostType = context.getType();
    if (hostType !== 'http') {
      return next.handle();
    }

    const handler = context.getHandler();
    const controller = context.getClass();

    const auditOptions = this.reflector.getAllAndOverride<AuditOptions>(AUDIT_KEY, [
      handler,
      controller,
    ]);

    if (!auditOptions) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const startTime = Date.now();

    const { method, url, ip, query, params, body } = request;
    const user = request.user;

    const maskedBody = body ? maskObject(body) : undefined;

    return next.handle().pipe(
      tap({
        next: (responseData) => {
          const duration = Date.now() - startTime;
          const statusCode = response.statusCode;

          let maskedResponse = responseData;
          if (auditOptions.maskResponse !== false && responseData) {
            maskedResponse = maskObject(responseData);
          }

          const auditLog = {
            timestamp: new Date().toISOString(),
            action: auditOptions.action,
            resource: auditOptions.resource || controller.name,
            status: 'SUCCESS',
            statusCode,
            duration,
            user: user
              ? maskObject({
                  id: user.id || user._id || user.sub,
                  email: user.email,
                  username: user.username || user.name,
                })
              : null,
            request: {
              method,
              url,
              ip,
              query,
              params,
              body: maskedBody,
            },
            response: maskedResponse,
          };

          this.logger.log(JSON.stringify(auditLog));
        },
        error: (err) => {
          const duration = Date.now() - startTime;
          const statusCode = err.status || 500;

          const auditLog = {
            timestamp: new Date().toISOString(),
            action: auditOptions.action,
            resource: auditOptions.resource || controller.name,
            status: 'FAILURE',
            statusCode,
            duration,
            user: user
              ? maskObject({
                  id: user.id || user._id || user.sub,
                  email: user.email,
                  username: user.username || user.name,
                })
              : null,
            request: {
              method,
              url,
              ip,
              query,
              params,
              body: maskedBody,
            },
            error: {
              message: err.message,
              name: err.name,
            },
          };

          this.logger.error(JSON.stringify(auditLog));
        },
      }),
    );
  }
}