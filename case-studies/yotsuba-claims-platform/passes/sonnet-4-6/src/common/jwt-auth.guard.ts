// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/common/jwt-auth.guard.ts
//
// JWT authentication guard. Validates Bearer tokens issued by auth.service.ts.
// Attaches the decoded payload to request.user for downstream guards and
// decorators (CurrentUser, Roles).
//
// Usage:
//   @UseGuards(JwtAuthGuard)                — single route
//   app.useGlobalGuards(new JwtAuthGuard()) — global (via APP_GUARD)
// =============================================================================

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import * as jwt from 'jsonwebtoken';
import { IS_PUBLIC_KEY } from './public.decorator';

// ---------------------------------------------------------------------------
// Token payload shape — mirrors what auth.service.ts signs.
// ---------------------------------------------------------------------------

export interface JwtPayload {
  sub: string;           // user.id (cuid)
  username: string;
  role: string;          // UserRole enum value
  is_claims_director: boolean;
  iat?: number;
  exp?: number;
}

// Augment Express Request so TypeScript knows about request.user downstream.
declare module 'express' {
  interface Request {
    user?: JwtPayload;
  }
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly configService: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    // Allow routes decorated with @Public() to bypass JWT verification.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const token   = this.extractBearerToken(request);

    if (!token) {
      throw new UnauthorizedException('Missing or malformed Authorization header.');
    }

    const secret = this.configService.get<string>('JWT_SECRET');
    if (!secret) {
      // Configuration error — should never reach production without this set.
      throw new UnauthorizedException('JWT secret is not configured.');
    }

    try {
      const payload = jwt.verify(token, secret) as JwtPayload;
      request.user  = payload;
      return true;
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        throw new UnauthorizedException('Token has expired.');
      }
      if (err instanceof jwt.JsonWebTokenError) {
        throw new UnauthorizedException('Invalid token.');
      }
      throw new UnauthorizedException('Token verification failed.');
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private extractBearerToken(request: Request): string | null {
    const authHeader = request.headers['authorization'];
    if (typeof authHeader !== 'string') {
      return null;
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
      return null;
    }

    return parts[1] ?? null;
  }
}