import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private logger = new Logger("ExceptionFilter");

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const req = ctx.getRequest();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = "Internal server error";
    let code = "internal_error";
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body: any = exception.getResponse();
      message = (typeof body === "string" ? body : body?.message) ?? message;
      code = typeof body === "object" && body?.error ? body.error : exception.constructor.name;
    } else {
      this.logger.error(exception);
    }
    res.status(status).json({ error: code, message, request_id: req.id, timestamp: new Date().toISOString() });
  }
}
