import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Reflector } from "@nestjs/core";
import { IS_PUBLIC_KEY } from "./roles.decorator";

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService, private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    const req = ctx.switchToHttp().getRequest();
    const auth = req.headers["authorization"] as string | undefined;
    if (!auth?.startsWith("Bearer ")) throw new UnauthorizedException("missing bearer token");
    const token = auth.slice(7);
    try {
      const payload = await this.jwt.verifyAsync(token, { secret: process.env.JWT_SECRET });
      req.user = { id: payload.sub, role: payload.role, username: payload.username };
      return true;
    } catch { throw new UnauthorizedException("invalid token"); }
  }
}
