import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Parameter decorator to retrieve the current authenticated user from the request object.
 * Can optionally retrieve a specific property from the user object if a key is provided.
 */
export const CurrentUser = createParamDecorator(
  (data: string | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user;
    return data ? user?.[data] : user;
  },
);