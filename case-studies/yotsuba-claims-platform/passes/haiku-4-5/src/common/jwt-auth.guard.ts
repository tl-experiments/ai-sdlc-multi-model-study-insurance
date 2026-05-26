import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

/**
 * JWT authentication guard for Yotsuba Claims Platform.
 *
 * Extracts and validates JWT tokens from the Authorization header (Bearer scheme).
 * Attaches the decoded payload (user ID, role, etc.) to the request object for downstream use.
 *
 * Usage:
 *   @UseGuards(JwtAuthGuard)
 *   @Get('/protected')
 *   getProtected(@Req() req: Request) { ... }
 *
 * The decoded token is available as req.user (typed as JwtPayload).
 */
@Injectable()
export class JwtAuthGuard {
  constructor(private readonly jwtService: JwtService) {}

  /**
   * Validate the request and extract the JWT token.
   *
   * @param request The incoming HTTP request
   * @returns The decoded JWT payload
   * @throws UnauthorizedException if token is missing, malformed, or invalid
   */
  canActivate(context: any): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }

    try {
      const payload = this.jwtService.verify(token, {
        secret: process.env.JWT_SECRET || 'your-secret-key-change-in-production',
      });
      request.user = payload;
      return true;
    } catch (error) {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  /**
   * Extract the Bearer token from the Authorization header.
   *
   * @param request The incoming HTTP request
   * @returns The token string, or undefined if not found
   */
  private extractTokenFromHeader(request: Request): string | undefined {
    const authHeader = request.headers.authorization;
    if (!authHeader) {
      return undefined;
    }

    const [scheme, token] = authHeader.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return undefined;
    }

    return token;
  }
}