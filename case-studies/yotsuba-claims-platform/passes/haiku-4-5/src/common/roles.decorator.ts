import { SetMetadata } from '@nestjs/common';
import { UserRole } from '@prisma/client';

/**
 * Decorator to specify which roles are allowed to access a route or handler.
 *
 * Usage:
 *   @Roles('adjuster', 'manager')
 *   @Post('claims/:id/notes')
 *   addNote(@Param('id') claimId: string, @Body() dto: AddNoteDto) { ... }
 *
 * The RolesGuard will check the current user's role against the allowed roles.
 * If the user's role is not in the allowed list, a 403 Forbidden is returned.
 *
 * Roles are defined in the Prisma schema as UserRole enum:
 *   - agent
 *   - adjuster
 *   - manager
 *   - auditor
 *   - siu_referrer
 */
export const Roles = (...roles: UserRole[]) => SetMetadata('roles', roles);