// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/common/current-user.decorator.ts
//
// Parameter decorator that extracts the authenticated user from the request
// object. The user is attached by JwtAuthGuard after JWT validation.
//
// Usage:
//   @Get('/me')
//   getMe(@CurrentUser() user: AuthenticatedUser) { ... }
// =============================================================================

import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { Request } from 'express';

// ---------------------------------------------------------------------------
// Authenticated user shape
// ---------------------------------------------------------------------------

/**
 * The shape of the authenticated user object attached to the request by
 * JwtAuthGuard. This is the decoded + validated JWT payload, enriched with
 * the full user record from the database during token validation.
 *
 * All downstream guards (RolesGuard) and services consume this interface.
 */
export interface AuthenticatedUser {
  /** Prisma cuid — primary key of the User record */
  id: string;

  /** Unique login handle */
  username: string;

  /** RBAC role — single role per user per design.md */
  role: UserRole;

  /** Human-readable display name */
  display_name: string;

  /** User's email address */
  email: string;

  /**
   * Whether this user holds the claims-director flag.
   * Required for reserve approval tiers > ¥10M (ADR-005).
   */
  is_claims_director: boolean;

  /**
   * The id of the user this person reports to, if set.
   * Used for manager-scoped access (managers see only their reports' claims).
   */
  reports_to_id: string | null;
}

// ---------------------------------------------------------------------------
// Decorator
// ---------------------------------------------------------------------------

/**
 * @CurrentUser() — extract the authenticated user from the Express request.
 *
 * JwtAuthGuard attaches the validated user as `request.user` after successful
 * JWT verification. This decorator provides ergonomic access to that object
 * in controller methods.
 *
 * An optional property key can be passed to extract a single field:
 *   @CurrentUser('id')   → string
 *   @CurrentUser('role') → UserRole
 *   @CurrentUser()       → AuthenticatedUser (full object)
 *
 * If no user is present on the request (route is not guarded), returns undefined.
 * Routes that require authentication must be decorated with @UseGuards(JwtAuthGuard).
 */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext): AuthenticatedUser | AuthenticatedUser[keyof AuthenticatedUser] | undefined => {
    const request = ctx.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const user    = request.user;

    if (!user) {
      return undefined;
    }

    if (data) {
      return user[data];
    }

    return user;
  },
);