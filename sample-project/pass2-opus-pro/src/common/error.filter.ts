import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * A global exception filter to catch and process all unhandled exceptions
 * across the application. It ensures that all error responses sent to the
 * client follow a consistent, structured format.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  /**
   * The central method to handle exceptions. It determines the appropriate
   * HTTP status code and response body based on the type of exception.
   *
   * @param exception The exception object caught by NestJS.
   * @param host The execution context, used to access HTTP request and response.
   */
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { id?: string }>();

    // Default to a 500 Internal Server Error
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';
    let code = 'internal_error';

    if (exception instanceof HttpException) {
      // If the exception is an HttpException, it's a controlled error.
      // We can extract the status and message from it.
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      // The response can be a string or an object (NestJS default).
      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
        code = exception.constructor.name;
      } else if (
        typeof exceptionResponse === 'object' &&
        exceptionResponse !== null
      ) {
        const body = exceptionResponse as {
          message?: string | string[];
          error?: string;
        };
        message = body.message ?? message;
        code = body.error ?? exception.constructor.name;
      }
    } else {
      // If it's not an HttpException, it's an unexpected error.
      // Log it for debugging, as it indicates a bug or system failure.
      this.logger.error(exception);
    }

    // Construct the standardized JSON response payload.
    const responsePayload = {
      error: code,
      message,
      request_id: request.id,
      timestamp: new Date().toISOString(),
    };

    response.status(status).json(responsePayload);
  }
}