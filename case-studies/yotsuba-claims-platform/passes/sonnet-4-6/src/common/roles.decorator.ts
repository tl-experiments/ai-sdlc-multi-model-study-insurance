// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/common/roles.decorator.ts
//
// Custom decorator for role-based access control.
// Used in conjunction with roles.guard.ts to enforce the role matrix
// defined in design.md §2 and brief.md.
// =============================================================================

import { SetMetadata } from '@nestjs/common';
import { UserRole } from '@prisma/client';

/**
 * Metadata key used by RolesGuard to read allowed roles from route handlers.
 */
export const ROLES_KEY = 'roles';

/**
 * @Roles(...roles) — attach to a controller method (or controller class) to
 * declare which UserRole values are permitted to access that route.
 *
 * Usage:
 *   @Roles(UserRole.manager, UserRole.auditor)
 *   @Get('/sensitive-resource')
 *   getSensitiveResource() { ... }
 *
 * When applied at the class level, applies to all methods unless overridden.
 * RolesGuard reads this metadata and compares against the authenticated user's role.
 *
 * If no @Roles decorator is present, RolesGuard allows any authenticated user through
 * (the JwtAuthGuard still enforces authentication).
 */
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);