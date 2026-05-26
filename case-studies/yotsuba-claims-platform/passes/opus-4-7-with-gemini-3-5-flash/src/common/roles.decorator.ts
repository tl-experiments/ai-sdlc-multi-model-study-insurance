import { SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';

export const ROLES_KEY = 'roles';

/**
 * Decorator to specify which user roles are allowed to access a route.
 * @param roles One or more roles from the Prisma Role enum.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);