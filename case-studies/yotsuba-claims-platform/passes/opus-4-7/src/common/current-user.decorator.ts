// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// `@CurrentUser()` parameter decorator.
//
// Resolves the authenticated caller from the request object onto a
// controller method parameter. The user payload is placed on the request
// by `JwtAuthGuard` (see `src/common/jwt-auth.guard.ts`) after the bearer
// token has been verified.
//
// Usage:
//   @Get('me')
//   me(@CurrentUser() user: CurrentUserPayload) { ... }
//
//   // Pluck a single field:
//   @Get(':id')
//   one(@CurrentUser('id') userId: string) { ... }
//
// Notes:
//   * The shape returned here is the canonical caller projection used
//     across every controller, every service, and every guard. Keeping
//     it in one place means changes to the JWT claim set surface as
//     compile errors in every consumer.
//   * `is_claims_director` is included on the payload because the
//     reserve-approval tier rules (ADR-005) require checking the flag at
//     request time without an additional database round-trip.
//   * If the guard chain did not attach a user (e.g. the decorator was
//     used on an unguarded route by mistake), we throw rather than
//     return `undefined` — silent `undefined` here is the most common
//     source of authorisation bypass bugs in NestJS code.
// ─────────────────────────────────────────────────────────────────────────

import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';

/**
 * Canonical projection of the authenticated caller. Attached to the
 * Express request as `request.user` by `JwtAuthGuard` after the bearer
 * token has been verified and the matching `User` row has been loaded.
 *
 * This is the only shape controllers and services should depend on when
 * they need to know "who is calling"; never reach into `request.user`
 * directly from a handler.
 */
export interface CurrentUserPayload {
  /** Stable database identifier (cuid). */
  id: string;
  /** Login handle; unique. */
  username: string;
  /** RBAC role; mirrors the Prisma `UserRole` enum. */
  role: UserRole;
  /** Human-readable display name for UI / audit log surfaces. */
  display_name: string;
  /** Contact email; unique. */
  email: string;
  /**
   * Manager that this user reports to, if any. Used by the role-scoping
   * logic (e.g. "manager can see their reports' claims").
   */
  reports_to_id: string | null;
  /**
   * Whether this user holds the claims-director flag. Required at
   * request time for the >¥10M reserve director-approval gate
   * (ADR-005) without a second DB round-trip.
   */
  is_claims_director: boolean;
}

/**
 * Keys of `CurrentUserPayload` that may be plucked via the field-pick
 * overload, e.g. `@CurrentUser('id')`.
 */
export type CurrentUserField = keyof CurrentUserPayload;

/**
 * Extract the authenticated caller (or one of its fields) from the
 * request. Throws `InternalServerErrorException` if no user is present —
 * this indicates the route is missing `JwtAuthGuard` and we prefer a
 * loud failure over a silent `undefined` that could be misread as
 * "unauthenticated but permitted".
 */
export const CurrentUser = createParamDecorator(
  (
    field: CurrentUserField | undefined,
    ctx: ExecutionContext,
  ): CurrentUserPayload | CurrentUserPayload[CurrentUserField] => {
    const request = ctx.switchToHttp().getRequest<{
      user?: CurrentUserPayload;
    }>();
    const user = request.user;
    if (!user || typeof user !== 'object' || typeof user.id !== 'string') {
      throw new InternalServerErrorException(
        '@CurrentUser() used on a route without an authenticated principal; ensure JwtAuthGuard is applied.',
      );
    }
    if (field !== undefined) {
      return user[field];
    }
    return user;
  },
);