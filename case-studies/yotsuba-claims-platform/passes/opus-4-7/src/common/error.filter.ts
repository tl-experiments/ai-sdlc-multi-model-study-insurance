// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// Global exception filter — standardised error envelope.
//
// Every error that escapes a controller or service is funnelled through
// this filter so that:
//
//   1. Clients receive a single, predictable JSON shape regardless of where
//      the error originated (validation, guard, business rule, Prisma, or
//      an uncaught throw). The brief mandates "no stack traces in API
//      responses; standardised error envelope" — this is that contract.
//
//   2. Operators receive a richly-structured Pino log line correlated to
//      the failing request via `request_id` + `correlation_id`, including
//      the original error / stack for post-hoc forensics.
//
//   3. APPI-sensitive material in error payloads (HttpException bodies
//      occasionally include the request body when validation fails) is
//      scrubbed before it ever reaches the wire. The `REDACTED_FIELDS`
//      list mirrors the audit interceptor's redaction set so the two
//      egress points agree on what is never safe to surface.
//
// Envelope shape (stable, documented as part of the API contract):
//
//   {
//     "error": {
//       "code": "VALIDATION_FAILED",       // SCREAMING_SNAKE_CASE token
//       "message": "loss_date is required",// human-readable, never a stack
//       "status": 422,                     // HTTP status echo
//       "request_id": "req_…",             // for support tickets
//       "correlation_id": "corr_…",        // for cross-service tracing
//       "details": [ … ]                   // optional, validator-shape
//     }
//   }
//
// Prisma errors are translated to friendly equivalents — P2002 unique
// constraint → 409 CONFLICT, P2025 not-found → 404 NOT_FOUND — so that
// service code can rely on `prisma.x.create()` throwing without having to
// wrap each call in a try/catch.
// ─────────────────────────────────────────────────────────────────────────

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';

/**
 * Stable error-code tokens emitted in the `error.code` field. New codes
 * may be added; existing ones must not change meaning. Clients are
 * encouraged to switch on `code` rather than `message`.
 */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE_ENTITY'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

/**
 * Wire shape of the JSON body. Exposed as a type so e2e tests can assert
 * against it without duplicating the structure.
 */
export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    status: number;
    request_id: string;
    correlation_id: string;
    details?: unknown;
  };
}

/**
 * Body fields that must never appear in either the wire envelope or the
 * structured log line. Mirrors `audit.interceptor#REDACTED_BODY_FIELDS`.
 */
const REDACTED_FIELDS = new Set<string>([
  'password',
  'password_hash',
  'access_token',
  'refresh_token',
  'insured_government_id',
  'bank_account_for_payout',
  'injury_details',
]);

/**
 * Minimal request shape we rely on. Express decorates the request with
 * far more than this, but pinning the surface area keeps type-checking
 * honest, exactly as the audit interceptor does.
 */
interface ErrorContextRequest extends Request {
  request_id?: string;
  correlation_id?: string;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<ErrorContextRequest>();
    const response = ctx.getResponse<Response>();

    const requestId =
      request.request_id ?? headerString(request, 'x-request-id') ?? 'unknown';
    const correlationId =
      request.correlation_id ??
      headerString(request, 'x-correlation-id') ??
      requestId;

    const translated = translate(exception);

    const envelope: ErrorEnvelope = {
      error: {
        code: translated.code,
        message: translated.message,
        status: translated.status,
        request_id: requestId,
        correlation_id: correlationId,
        ...(translated.details !== undefined
          ? { details: translated.details }
          : {}),
      },
    };

    // Structured log: full context for operators, including the original
    // error name + stack, never the wire envelope's sanitised summary.
    const logPayload = {
      request_id: requestId,
      correlation_id: correlationId,
      method: request.method,
      path: request.originalUrl ?? request.url,
      status: translated.status,
      code: translated.code,
      err_name: errorName(exception),
      err_message: errorMessage(exception),
      // Stack only at server-error severity — client errors are noise.
      ...(translated.status >= 500
        ? { stack: errorStack(exception) }
        : {}),
    };

    if (translated.status >= 500) {
      this.logger.error(logPayload, 'request_failed');
    } else {
      this.logger.warn(logPayload, 'request_rejected');
    }

    // Always set the correlation headers on the response so a failing
    // caller can still trace the request without inspecting the body.
    response.setHeader('x-request-id', requestId);
    response.setHeader('x-correlation-id', correlationId);
    response.status(translated.status).json(envelope);
  }
}

// ─── translation: exception → wire-ready summary ─────────────────────────

interface TranslatedError {
  status: number;
  code: ErrorCode;
  message: string;
  details?: unknown;
}

/**
 * Map an arbitrary thrown value to a stable error summary. The cascade
 * checks the most-specific shape first (Nest's `HttpException`, then
 * Prisma's typed errors) before falling through to the generic
 * `INTERNAL_ERROR` bucket.
 */
function translate(exception: unknown): TranslatedError {
  if (exception instanceof HttpException) {
    return translateHttpException(exception);
  }
  if (exception instanceof Prisma.PrismaClientKnownRequestError) {
    return translatePrismaKnownError(exception);
  }
  if (exception instanceof Prisma.PrismaClientValidationError) {
    return {
      status: HttpStatus.BAD_REQUEST,
      code: 'VALIDATION_FAILED',
      message: 'Invalid database operation payload.',
    };
  }
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    code: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred.',
  };
}

/**
 * Translate Nest's `HttpException` hierarchy. The body returned by
 * `getResponse()` is sometimes a string (the raw message) and sometimes
 * an object (validator output with a `message` array); both are handled.
 */
function translateHttpException(exception: HttpException): TranslatedError {
  const status = exception.getStatus();
  const responseBody = exception.getResponse();

  const code = codeForStatus(status);
  let message: string = exception.message;
  let details: unknown;

  if (typeof responseBody === 'string') {
    message = responseBody;
  } else if (responseBody && typeof responseBody === 'object') {
    const obj = responseBody as Record<string, unknown>;
    const rawMessage = obj.message;
    if (Array.isArray(rawMessage)) {
      // class-validator emits `message: string[]`.
      message = rawMessage.length > 0 ? String(rawMessage[0]) : message;
      details = sanitiseForWire(rawMessage);
    } else if (typeof rawMessage === 'string') {
      message = rawMessage;
    }
    if (typeof obj.error === 'string' && !details) {
      // Preserve secondary context (e.g. `error: 'Bad Request'`) only
      // when no validator details were attached.
      details = sanitiseForWire(obj.error);
    }
  }

  return {
    status,
    code,
    message,
    ...(details !== undefined ? { details } : {}),
  };
}

/**
 * Translate Prisma's documented error codes to our envelope. Only the
 * handful we actually encounter in Track A are mapped explicitly; the
 * rest fall through to a generic 500 so they show up loudly in logs and
 * get a proper mapping added on next encounter.
 *
 * See https://www.prisma.io/docs/reference/api-reference/error-reference
 */
function translatePrismaKnownError(
  exception: Prisma.PrismaClientKnownRequestError,
): TranslatedError {
  switch (exception.code) {
    case 'P2002': {
      // Unique constraint violation — most commonly `username` or
      // `email` on `User`. The `target` meta tells the caller which.
      const target = (exception.meta?.target as string[] | string | undefined) ?? undefined;
      return {
        status: HttpStatus.CONFLICT,
        code: 'CONFLICT',
        message: 'A record with the same unique identifier already exists.',
        ...(target !== undefined ? { details: { fields: target } } : {}),
      };
    }
    case 'P2025':
      return {
        status: HttpStatus.NOT_FOUND,
        code: 'NOT_FOUND',
        message: 'The requested record was not found.',
      };
    case 'P2003':
      return {
        status: HttpStatus.CONFLICT,
        code: 'CONFLICT',
        message: 'Foreign-key constraint failed.',
      };
    case 'P2000':
      return {
        status: HttpStatus.BAD_REQUEST,
        code: 'VALIDATION_FAILED',
        message: 'Provided value is too long for the target column.',
      };
    default:
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: 'INTERNAL_ERROR',
        message: 'A database error occurred.',
      };
  }
}

/**
 * HTTP status → stable `ErrorCode` token. Any unmapped 4xx collapses to
 * `VALIDATION_FAILED`; any unmapped 5xx collapses to `INTERNAL_ERROR`.
 */
function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'VALIDATION_FAILED';
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHENTICATED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.CONFLICT:
      return 'CONFLICT';
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return 'UNPROCESSABLE_ENTITY';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'RATE_LIMITED';
    default:
      if (status >= 500) return 'INTERNAL_ERROR';
      return 'VALIDATION_FAILED';
  }
}

// ─── helpers (file-scoped, pure) ─────────────────────────────────────────

/**
 * Deep-clone an arbitrary value with `REDACTED_FIELDS` stripped at every
 * level. Used to scrub validator-emitted `details` arrays/objects before
 * placing them on the wire — class-validator messages occasionally
 * include the offending field name, but defence-in-depth dictates we
 * scrub the value space regardless.
 */
function sanitiseForWire(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((v) => sanitiseForWire(v));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (REDACTED_FIELDS.has(k)) {
      out[k] = '[redacted]';
      continue;
    }
    out[k] = sanitiseForWire(v);
  }
  return out;
}

function headerString(
  request: ErrorContextRequest,
  name: string,
): string | null {
  const h = request.headers?.[name];
  if (typeof h === 'string' && h.length > 0) return h;
  if (Array.isArray(h) && h.length > 0 && typeof h[0] === 'string') return h[0];
  return null;
}

function errorName(exception: unknown): string {
  if (exception instanceof Error) return exception.name;
  return typeof exception;
}

function errorMessage(exception: unknown): string {
  if (exception instanceof Error) return exception.message;
  if (typeof exception === 'string') return exception;
  try {
    return JSON.stringify(exception);
  } catch {
    return '[unserialisable error]';
  }
}

function errorStack(exception: unknown): string | undefined {
  if (exception instanceof Error && typeof exception.stack === 'string') {
    return exception.stack;
  }
  return undefined;
}