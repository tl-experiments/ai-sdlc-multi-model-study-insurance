import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

/**
 * Global exception filter for standardized error responses.
 *
 * Context:
 *   The API must return consistent error envelopes across all endpoints.
 *   Stack traces must never be exposed to clients (security).
 *   All errors (HTTP exceptions, validation errors, database errors) are normalized
 *   into a single response shape with status, message, and optional details.
 *
 * Behavior:
 *   1. Catch all exceptions (both HttpException and unhandled errors).
 *   2. Log the full error (including stack trace) server-side for debugging.
 *   3. Return a sanitized error envelope to the client:
 *      {
 *        "statusCode": number,
 *        "message": string,
 *        "error": string | undefined,
 *        "details": any | undefined,
 *        "timestamp": ISO8601 string,
 *        "path": string,
 *        "request_id": string | undefined
 *      }
 *   4. Never include stack traces, internal error details, or sensitive information.
 *   5. Preserve request_id from the request context for tracing.
 *
 * HTTP exceptions (thrown by guards, pipes, or handlers) are returned as-is with
 * their status code and message. Unhandled errors are converted to 500 Internal Server Error.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let error: string | undefined;
    let details: any | undefined;

    // Log the full exception server-side for debugging.
    this.logger.error(
      `Unhandled exception: ${exception instanceof Error ? exception.message : String(exception)}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    // Classify the exception and extract status/message.
    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      // HttpException.getResponse() returns either a string or an object.
      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object') {
        const responseObj = exceptionResponse as any;
        message = responseObj.message || 'HTTP exception';
        error = responseObj.error;
        // For validation errors, include the details array (class-validator format).
        if (Array.isArray(responseObj.message)) {
          details = responseObj.message;
          message = 'Validation failed';
        }
      }
    } else if (exception instanceof Error) {
      // Unhandled Error: log the stack, return generic 500.
      statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'Internal server error';
      // Never expose the actual error message or stack to the client.
    } else {
      // Unknown exception type: log and return generic 500.
      statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'Internal server error';
    }

    // Build the standardized error response.
    const errorResponse = {
      statusCode,
      message,
      ...(error && { error }),
      ...(details && { details }),
      timestamp: new Date().toISOString(),
      path: request.url,
      ...(request.request_id && { request_id: request.request_id }),
    };

    response.status(statusCode).json(errorResponse);
  }
}