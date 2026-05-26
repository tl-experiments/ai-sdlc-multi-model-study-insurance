import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { User } from '@prisma/client';

/**
 * Decorator to inject the current authenticated user into a route handler.
 *
 * Usage:
 *   @Get('claims/:id')
 *   getClaim(
 *     @Param('id') claimId: string,
 *     @CurrentUser() user: User,
 *   ) { ... }
 *
 * The JwtAuthGuard must be applied to the route for this decorator to work.
 * If no user is authenticated, the guard will reject the request before this
 * decorator is evaluated.
 *
 * The user object is extracted from the request.user property, which is set
 * by the JwtAuthGuard after validating the JWT token.
 */
export const CurrentUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): User => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as User;
  },
);