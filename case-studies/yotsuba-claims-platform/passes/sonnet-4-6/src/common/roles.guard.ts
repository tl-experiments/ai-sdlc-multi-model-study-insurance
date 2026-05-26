// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/common/roles.guard.ts
//
// Role-based access control guard. Checks that the authenticated user's role
// matches one of the roles declared via the @Roles() decorator.
//
// Must be applied AFTER JwtAuthGuard so that request.user is populated.
//
// Usage:
//   @Roles(UserRole.manager, UserRole.adjuster)
//   @UseGuards(JwtAuthGuard, RolesGuard)
//   async myRoute() { ... }
// =============================================================================

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { ROLES_KEY } from './roles.decorator';
import type { JwtPayload } from './jwt-auth.guard';

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Retrieve the roles declared on the handler or the controller class.
    // Handler-level metadata takes precedence over class-level.
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // If no @Roles() decorator is present, the route is unrestricted by role
    // (authentication is still enforced by JwtAuthGuard).
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const user    = request.user as JwtPayload | undefined;

    if (!user) {
      // JwtAuthGuard should have rejected the request before we get here,
      // but guard defensively.
      throw new ForbiddenException('No authenticated user found on request.');
    }

    if (!requiredRoles.includes(user.role)) {
      throw new ForbiddenException(
        `Role '${user.role}' is not authorised to access this resource. ` +
        `Required: ${requiredRoles.join(' | ')}.`,
      );
    }

    return true;
  }
}

// ---------------------------------------------------------------------------
// Supplemental guard: ClaimsDirectorGuard
//
// Some routes (e.g. POST /reserves/:id/director-approve) require the caller
// to hold the manager role AND have is_claims_director=true in their JWT.
// This guard enforces that compound requirement.
// ---------------------------------------------------------------------------

/**
 * Metadata key used by @RequiresClaimsDirector().
 */
export const REQUIRES_CLAIMS_DIRECTOR_KEY = 'requires_claims_director';

@Injectable()
export class ClaimsDirectorGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean>(
      REQUIRES_CLAIMS_DIRECTOR_KEY,
      [context.getHandler(), context.getClass()],
    );

    // If @RequiresClaimsDirector() is not present, pass through.
    if (!required) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const user    = request.user as JwtPayload | undefined;

    if (!user) {
      throw new ForbiddenException('No authenticated user found on request.');
    }

    if (user.role !== 'manager') {
      throw new ForbiddenException(
        'Claims-director approval requires the manager role.',
      );
    }

    if (!user.is_claims_director) {
      throw new ForbiddenException(
        'This action requires claims-director authority (is_claims_director=true).',
      );
    }

    return true;
  }
}