import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("ExceptionFilter");

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<any>();
    const req = ctx.getRequest<any>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = "Internal server error";
    let code = "internal_error";

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === "string") {
        message = body;
        code = exception.constructor.name;
      } else if (body && typeof body === "object") {
        const bodyObj = body as Record<string, any>;
        message = bodyObj.message ?? message;
        code = typeof bodyObj.error === "string" ? bodyObj.error : exception.constructor.name;
      }
    } else {
      this.logger.error(exception);
    }

    res.status(status).json({
      error: code,
      message,
      request_id: req?.id,
      timestamp: new Date().toISOString(),
    });
  }
}