// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// `@Roles(...)` route metadata decorator.
//
// Pairs with `RolesGuard` (see `src/common/roles.guard.ts`) which reads the
// metadata attached by this decorator and authorises the request against
// the JWT-resolved caller role.
//
// Usage:
//   @Roles('manager')
//   @Post(':id/assign')
//   assign(...) { ... }
//
//   @Roles('adjuster', 'manager')
//   @Post(':id/notes')
//   addNote(...) { ... }
//
// Notes:
//   * The accepted role strings mirror the Prisma `UserRole` enum exactly
//     (`agent` | `adjuster` | `manager` | `auditor` | `siu_referrer`).
//   * `ROLES_KEY` is the canonical metadata key — guards must use the
//     exported symbol rather than re-declaring the string literal.
//   * The decorator is variadic; calling `@Roles()` with no arguments is
//     a programmer error and is rejected at decoration time so that an
//     accidentally empty list cannot silently allow-all.
// ─────────────────────────────────────────────────────────────────────────

import { SetMetadata, CustomDecorator } from '@nestjs/common';
import { UserRole } from '@prisma/client';

/**
 * Metadata key under which the allowed-role list is stored on the route
 * handler. `RolesGuard` reads this key via `Reflector#getAllAndOverride`
 * so both controller-level and method-level `@Roles(...)` annotations
 * compose correctly.
 */
export const ROLES_KEY = 'yotsuba.roles';

/**
 * Allowed role identifiers. Kept in lock-step with the Prisma `UserRole`
 * enum so that a schema change surfaces here as a compile error rather
 * than a silent authorisation drift.
 */
export type AllowedRole = UserRole;

/**
 * Attach an allow-list of roles to a route handler (or an entire
 * controller). Requests whose JWT-resolved role is not in the list are
 * rejected by `RolesGuard` with HTTP 403.
 *
 * @throws Error if invoked with zero roles — an empty allow-list is
 *   almost always a bug (it would either deny everyone or, if the guard
 *   short-circuits on empty, allow everyone). Either outcome is worse
 *   than failing loudly at boot.
 */
export const Roles = (...roles: AllowedRole[]): CustomDecorator<string> => {
  if (roles.length === 0) {
    throw new Error(
      '@Roles(...) requires at least one role; an empty allow-list is not permitted.',
    );
  }
  return SetMetadata(ROLES_KEY, roles);
};