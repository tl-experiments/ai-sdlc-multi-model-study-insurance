// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/common/error.filter.ts
//
// Global exception filter — catches all unhandled exceptions and returns
// a standardised error envelope. Per brief.md: no stack traces in API
// responses; standardised error envelope.
//
// Error envelope shape:
//   {
//     "statusCode": number,
//     "error": string,       // HTTP status text
//     "message": string,     // safe user-facing message
//     "request_id": string,  // from request context
//     "correlation_id": string,
//     "timestamp": string    // ISO-8601
//   }
//
// Stack traces are logged via Pino (with request_id + correlation_id
// correlation) but NEVER returned in the response body.
// =============================================================================

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Request shape augmented by our middleware-injected correlation IDs */
interface AugmentedRequest extends Request {
  requestId?: string;
  correlationId?: string;
}

/** Standardised error response envelope — never includes a stack trace */
export interface ErrorEnvelope {
  statusCode: number;
  error: string;
  message: string;
  request_id: string;
  correlation_id: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map an HTTP status code to its canonical reason phrase.
 * Covers all standard codes used by NestJS built-in exceptions.
 */
function httpStatusText(statusCode: number): string {
  const map: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    409: 'Conflict',
    410: 'Gone',
    413: 'Payload Too Large',
    415: 'Unsupported Media Type',
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    501: 'Not Implemented',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
  };
  return map[statusCode] ?? 'Unknown Error';
}

/**
 * Extract a safe, user-facing message from an HttpException.
 *
 * NestJS HttpException.getResponse() returns either:
 *   - A string (the message)
 *   - An object with { message: string | string[], error: string, statusCode }
 *
 * class-validator errors arrive as { message: string[] } — we join them.
 * We never expose internal details like table names or stack traces.
 */
function extractHttpMessage(exception: HttpException): string {
  const response = exception.getResponse();

  if (typeof response === 'string') {
    return response;
  }

  if (typeof response === 'object' && response !== null) {
    const resp = response as Record<string, unknown>;

    // class-validator produces { message: string[] }
    if (Array.isArray(resp['message'])) {
      return (resp['message'] as string[]).join('; ');
    }

    if (typeof resp['message'] === 'string') {
      return resp['message'];
    }
  }

  return exception.message;
}

/**
 * Map Prisma client errors to appropriate HTTP status codes and safe messages.
 *
 * We never expose Prisma meta (table names, column names, raw DB errors)
 * to the caller — only sanitised messages.
 */
function handlePrismaError(err: Prisma.PrismaClientKnownRequestError): {
  statusCode: number;
  message: string;
} {
  switch (err.code) {
    case 'P2002':
      // Unique constraint violation
      return {
        statusCode: HttpStatus.CONFLICT,
        message: 'A record with the provided value already exists.',
      };

    case 'P2003':
      // Foreign key constraint failed
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Referenced record does not exist.',
      };

    case 'P2025':
      // Record not found (e.g. update/delete on non-existent row)
      return {
        statusCode: HttpStatus.NOT_FOUND,
        message: 'The requested record was not found.',
      };

    case 'P2016':
      // Query interpretation error
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Invalid query parameters.',
      };

    case 'P2014':
      // Relation violation
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Operation would violate a relation constraint.',
      };

    default:
      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'A database error occurred. Please try again later.',
      };
  }
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

/**
 * GlobalExceptionFilter — catches all exceptions thrown anywhere in the
 * NestJS request pipeline and returns a standardised ErrorEnvelope.
 *
 * Register globally in main.ts:
 *   app.useGlobalFilters(new GlobalExceptionFilter());
 *
 * Handles:
 *   - HttpException (including NestJS built-ins + class-validator)
 *   - Prisma.PrismaClientKnownRequestError (DB constraint / not-found)
 *   - Prisma.PrismaClientValidationError (invalid query shape)
 *   - Prisma.PrismaClientInitializationError (connection failures)
 *   - All other errors → 500 with a generic message
 *
 * In all cases:
 *   - Stack traces are logged via Logger but NEVER returned to the caller.
 *   - request_id and correlation_id are extracted from the request and
 *     included in both the log entry and the response envelope for
 *     cross-service tracing.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<AugmentedRequest>();
    const res = ctx.getResponse<Response>();

    // Extract correlation IDs injected by middleware
    const requestId =
      req.requestId ??
      (req.headers['x-request-id'] as string | undefined) ??
      'unknown';
    const correlationId =
      req.correlationId ??
      (req.headers['x-correlation-id'] as string | undefined) ??
      requestId;

    const timestamp = new Date().toISOString();

    // ------------------------------------------------------------------
    // Determine status code + safe message based on exception type
    // ------------------------------------------------------------------

    let statusCode: number;
    let message: string;

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      message = extractHttpMessage(exception);

      // Log at warn level for client errors, error level for server errors
      if (statusCode >= 500) {
        this.logger.error(
          {
            statusCode,
            request_id: requestId,
            correlation_id: correlationId,
            method: req.method,
            path: req.path,
            // Stack only in logs, never in response
            stack: exception.stack,
          },
          `HttpException [${statusCode}]: ${message}`,
        );
      } else {
        this.logger.warn(
          {
            statusCode,
            request_id: requestId,
            correlation_id: correlationId,
            method: req.method,
            path: req.path,
          },
          `HttpException [${statusCode}]: ${message}`,
        );
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = handlePrismaError(exception);
      statusCode = mapped.statusCode;
      message = mapped.message;

      this.logger.error(
        {
          statusCode,
          prisma_code: exception.code,
          request_id: requestId,
          correlation_id: correlationId,
          method: req.method,
          path: req.path,
          // Prisma meta may contain table/field names — log but don't expose
          meta: exception.meta,
          stack: exception.stack,
        },
        `PrismaClientKnownRequestError [${exception.code}]: ${message}`,
      );
    } else if (exception instanceof Prisma.PrismaClientValidationError) {
      statusCode = HttpStatus.BAD_REQUEST;
      message = 'Invalid request data. Please check your input and try again.';

      this.logger.error(
        {
          statusCode,
          request_id: requestId,
          correlation_id: correlationId,
          method: req.method,
          path: req.path,
          stack: exception.stack,
        },
        `PrismaClientValidationError: ${exception.message}`,
      );
    } else if (exception instanceof Prisma.PrismaClientInitializationError) {
      statusCode = HttpStatus.SERVICE_UNAVAILABLE;
      message = 'Service temporarily unavailable. Please try again later.';

      this.logger.error(
        {
          statusCode,
          request_id: requestId,
          correlation_id: correlationId,
          method: req.method,
          path: req.path,
          stack: exception instanceof Error ? exception.stack : undefined,
        },
        `PrismaClientInitializationError: database unavailable`,
      );
    } else if (exception instanceof Prisma.PrismaClientRustPanicError) {
      statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'An unexpected database error occurred. Please try again later.';

      this.logger.error(
        {
          statusCode,
          request_id: requestId,
          correlation_id: correlationId,
          method: req.method,
          path: req.path,
          stack: exception instanceof Error ? exception.stack : undefined,
        },
        `PrismaClientRustPanicError: critical database failure`,
      );
    } else if (exception instanceof Error) {
      // Unknown application error — 500, no internal detail exposed
      statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'An unexpected error occurred. Please try again later.';

      this.logger.error(
        {
          statusCode,
          request_id: requestId,
          correlation_id: correlationId,
          method: req.method,
          path: req.path,
          error_name: exception.name,
          stack: exception.stack,
        },
        `Unhandled Error [${exception.name}]: ${exception.message}`,
      );
    } else {
      // Non-Error thrown (string, object, etc.) — treat as 500
      statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'An unexpected error occurred. Please try again later.';

      this.logger.error(
        {
          statusCode,
          request_id: requestId,
          correlation_id: correlationId,
          method: req.method,
          path: req.path,
          thrown_value: String(exception),
        },
        `Non-Error thrown: ${String(exception)}`,
      );
    }

    // ------------------------------------------------------------------
    // Build and send the standardised error envelope
    // ------------------------------------------------------------------

    const envelope: ErrorEnvelope = {
      statusCode,
      error: httpStatusText(statusCode),
      message,
      request_id: requestId,
      correlation_id: correlationId,
      timestamp,
    };

    res.status(statusCode).json(envelope);
  }
}