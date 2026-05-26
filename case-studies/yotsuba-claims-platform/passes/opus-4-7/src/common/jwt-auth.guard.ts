// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// JWT authentication guard.
//
// Responsibilities:
//   * Extract a bearer token from the `Authorization` header.
//   * Verify the token's signature and expiry against `JWT_SECRET`.
//   * Hydrate the verified payload onto `request.user` so downstream
//     guards (`RolesGuard`), decorators (`@CurrentUser`), interceptors
//     (`AuditInterceptor`), and controllers can rely on a typed actor.
//
// This guard is intentionally stateless — it does not hit the database.
// The token payload carries enough to authorise the request envelope:
//   { sub, username, role, is_claims_director, iat, exp }.
// Per-resource ownership checks (e.g. "is this adjuster assigned to this
// claim?") live in the relevant service, not here.
//
// Routes opt out of authentication by annotating the handler or its
// containing controller with `@Public()`. The login route is the only
// expected consumer of that escape hatch in Track A.
// ─────────────────────────────────────────────────────────────────────────

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JsonWebTokenError, TokenExpiredError, verify } from 'jsonwebtoken';
import type { Request } from 'express';

import type { UserRole } from '@prisma/client';

// ─── public-route opt-out ────────────────────────────────────────────────

export const IS_PUBLIC_KEY = 'yotsuba:isPublic';

/**
 * Mark a controller or handler as publicly reachable, skipping JWT
 * verification. Only `/auth/login` is expected to use this in Track A.
 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);

// ─── request augmentation ───────────────────────────────────────────────

/**
 * The shape of the JWT payload this platform issues. Kept narrow on
 * purpose: anything the guard cannot vouch for at verify-time should be
 * looked up in the database by the consuming service.
 */
export interface JwtPayload {
  /** User id (cuid). Mirrors the standard `sub` claim. */
  sub: string;
  username: string;
  role: UserRole;
  is_claims_director: boolean;
  iat?: number;
  exp?: number;
}

/**
 * What gets attached to `request.user`. The id is duplicated as both
 * `id` and `sub` so downstream code can use whichever feels natural
 * without an extra mapping step.
 */
export interface AuthenticatedUser {
  id: string;
  sub: string;
  username: string;
  role: UserRole;
  is_claims_director: boolean;
}

/**
 * Express request enriched with the verified actor. Exported so other
 * modules (decorators, interceptors) can type their handlers uniformly.
 */
export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

// ─── guard ───────────────────────────────────────────────────────────────

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException('Missing bearer token.');
    }

    const secret = process.env.JWT_SECRET;
    if (!secret || secret.trim() === '') {
      // Fail closed: a misconfigured server must not silently accept tokens.
      this.logger.error(
        'JWT_SECRET is not configured; refusing to authorise request.',
      );
      throw new UnauthorizedException('Authentication is not configured.');
    }

    let payload: JwtPayload;
    try {
      payload = verify(token, secret) as JwtPayload;
    } catch (err) {
      if (err instanceof TokenExpiredError) {
        throw new UnauthorizedException('Token has expired.');
      }
      if (err instanceof JsonWebTokenError) {
        throw new UnauthorizedException('Invalid token.');
      }
      throw new UnauthorizedException('Could not verify token.');
    }

    if (!this.isWellFormedPayload(payload)) {
      throw new UnauthorizedException('Token payload is malformed.');
    }

    request.user = {
      id: payload.sub,
      sub: payload.sub,
      username: payload.username,
      role: payload.role,
      is_claims_director: Boolean(payload.is_claims_director),
    };

    return true;
  }

  /**
   * Pull the bearer token from the standard `Authorization` header. The
   * scheme match is case-insensitive (RFC 7235 §2.1) but we don't accept
   * tokens passed via query string or cookie — those broaden the attack
   * surface (logs, referer leakage) without buying anything for this POC.
   */
  private extractBearerToken(req: AuthenticatedRequest): string | null {
    const header = req.headers['authorization'];
    if (!header || typeof header !== 'string') return null;
    const [scheme, value] = header.split(' ');
    if (!scheme || !value) return null;
    if (scheme.toLowerCase() !== 'bearer') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private isWellFormedPayload(payload: unknown): payload is JwtPayload {
    if (!payload || typeof payload !== 'object') return false;
    const p = payload as Record<string, unknown>;
    if (typeof p.sub !== 'string' || p.sub.length === 0) return false;
    if (typeof p.username !== 'string' || p.username.length === 0) return false;
    if (typeof p.role !== 'string') return false;
    const allowedRoles: ReadonlyArray<UserRole> = [
      'agent',
      'adjuster',
      'manager',
      'auditor',
      'siu_referrer',
    ];
    if (!allowedRoles.includes(p.role as UserRole)) return false;
    // `is_claims_director` may be absent in older tokens; default to false.
    if (
      p.is_claims_director !== undefined &&
      typeof p.is_claims_director !== 'boolean'
    ) {
      return false;
    }
    return true;
  }
}