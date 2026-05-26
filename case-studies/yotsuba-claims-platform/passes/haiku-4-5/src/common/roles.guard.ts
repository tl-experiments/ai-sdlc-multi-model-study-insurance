import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { UserRole } from '@prisma/client';

/**
 * Role-based access control (RBAC) guard for Yotsuba Claims Platform.
 *
 * Enforces role-based authorization on routes decorated with @Roles(...).
 * The guard extracts the user's role from the JWT payload (attached by JwtAuthGuard)
 * and checks it against the required roles for the route.
 *
 * Usage:
 *   @UseGuards(JwtAuthGuard, RolesGuard)
 *   @Roles('manager', 'auditor')
 *   @Post('/claims/:id/assign')
 *   assignClaim(@Param('id') id: string) { ... }
 *
 * If the user's role is not in the required set, a ForbiddenException is thrown.
 * If no roles are specified on the route, the guard allows access (assumes public or JWT-only).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  /**
   * Determine if the request is allowed based on the user's role.
   *
   * @param context The execution context (contains request, response, etc.)
   * @returns true if the user's role is in the required set; false otherwise
   * @throws ForbiddenException if the user's role is not authorized
   */
  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.get<UserRole[]>(
      'roles',
      context.getHandler(),
    );

    // If no roles are specified, allow access (assume public or JWT-only)
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as { id: string; role: UserRole; is_claims_director?: boolean };

    if (!user) {
      throw new ForbiddenException('User not found in request context');
    }

    // Check if the user's role is in the required set
    if (!requiredRoles.includes(user.role)) {
      throw new ForbiddenException(
        `Access denied. Required roles: ${requiredRoles.join(', ')}. Your role: ${user.role}`,
      );
    }

    return true;
  }
}