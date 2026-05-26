// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// Role-based access guard.
//
// Responsibilities:
//   * Read the role allow-list declared on a handler (or its containing
//     controller) via the `@Roles(...)` decorator.
//   * Compare against the authenticated actor that `JwtAuthGuard` placed
//     on `request.user`.
//   * Additionally honour the `@RequireClaimsDirector()` decorator, which
//     gates routes that need the `is_claims_director` flag in addition to
//     a `manager` role (used by `POST /reserves/:id/director-approve`).
//
// What this guard deliberately does NOT do:
//   * Per-resource ownership checks ("is this adjuster the assigned one?",
//     "does this manager report to this claim's adjuster?"). Those are
//     domain checks that depend on database state and live in the relevant
//     service. This guard is the coarse envelope filter only.
//
// Ordering: this guard MUST run after `JwtAuthGuard`. In `app.module.ts`
// the two are registered as global guards in that order so handlers can
// rely on `request.user` being populated by the time this runs.
// ─────────────────────────────────────────────────────────────────────────

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { UserRole } from '@prisma/client';

import {
  CLAIMS_DIRECTOR_KEY,
  ROLES_KEY,
} from './roles.decorator';
import type { AuthenticatedRequest, AuthenticatedUser } from './jwt-auth.guard';
import { IS_PUBLIC_KEY } from './jwt-auth.guard';

@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Public routes (e.g. `/auth/login`) bypass role checks entirely; the
    // JWT guard has already short-circuited for them.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const requiredRoles = this.reflector.getAllAndOverride<
      ReadonlyArray<UserRole> | undefined
    >(ROLES_KEY, [context.getHandler(), context.getClass()]);

    const requireDirector = this.reflector.getAllAndOverride<boolean>(
      CLAIMS_DIRECTOR_KEY,
      [context.getHandler(), context.getClass()],
    );

    // If no metadata is present, the route is authenticated-but-unrestricted.
    // JwtAuthGuard has already enforced presence of a valid actor.
    if (
      (!requiredRoles || requiredRoles.length === 0) &&
      !requireDirector
    ) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    if (!user) {
      // This indicates a misconfiguration — `RolesGuard` ran without a
      // preceding `JwtAuthGuard`. Fail closed.
      this.logger.error(
        'RolesGuard invoked without an authenticated user on the request; '
          + 'check global guard ordering in AppModule.',
      );
      throw new UnauthorizedException('Authentication required.');
    }

    if (requiredRoles && requiredRoles.length > 0) {
      if (!requiredRoles.includes(user.role)) {
        this.logger.warn(
          `Forbidden: actor ${user.username} (role=${user.role}) attempted `
            + `access to route requiring one of [${requiredRoles.join(', ')}].`,
        );
        throw new ForbiddenException(
          'Your role is not permitted to perform this action.',
        );
      }
    }

    if (requireDirector && !this.isClaimsDirector(user)) {
      this.logger.warn(
        `Forbidden: actor ${user.username} (role=${user.role}, `
          + `is_claims_director=${user.is_claims_director}) attempted access to `
          + 'a claims-director-gated route.',
      );
      throw new ForbiddenException(
        'This action requires claims-director authority.',
      );
    }

    return true;
  }

  /**
   * Claims-director authority is modelled as a flag on `User` rather than
   * a distinct role (a director is still functionally a manager). The flag
   * is carried in the JWT so this guard can decide without a DB round-trip.
   */
  private isClaimsDirector(user: AuthenticatedUser): boolean {
    return user.role === 'manager' && user.is_claims_director === true;
  }
}