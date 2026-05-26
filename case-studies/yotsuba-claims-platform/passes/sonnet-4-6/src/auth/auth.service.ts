// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/auth/auth.service.ts
//
// Authentication service. Handles:
//   - Login: validate credentials, issue a signed JWT.
//   - Me: return the current authenticated user's profile.
//
// JWT payload shape is shared with jwt-auth.guard.ts (JwtPayload interface).
// Password hashing uses bcrypt (12 rounds); no plaintext passwords are stored.
// =============================================================================

import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../prisma.service';
import type { JwtPayload } from '../common/jwt-auth.guard';
import type { LoginDto } from './dto/login.dto';

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface LoginResponse {
  access_token: string;
  expires_in: number;   // seconds
  role: string;
  is_claims_director: boolean;
  user_id: string;
  username: string;
  display_name: string;
}

export interface MeResponse {
  user_id: string;
  username: string;
  display_name: string;
  email: string;
  role: string;
  is_claims_director: boolean;
  reports_to_id: string | null;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class AuthService {
  /** JWT lifetime: 8 hours — sensible for an adjuster's working shift. */
  private static readonly JWT_EXPIRES_IN_SECONDS = 8 * 60 * 60;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // login
  // ---------------------------------------------------------------------------

  /**
   * Validates credentials and returns a signed JWT.
   *
   * Flow:
   *   1. Look up user by username (case-sensitive; usernames are normalised at
   *      registration to lowercase).
   *   2. Reject if the user has been soft-deleted (deleted_at is set).
   *   3. Compare the supplied password against the stored bcrypt hash.
   *   4. Sign and return a JWT carrying the standard payload.
   */
  async login(dto: LoginDto): Promise<LoginResponse> {
    const user = await this.prisma.user.findUnique({
      where: { username: dto.username },
      select: {
        id: true,
        username: true,
        password_hash: true,
        role: true,
        display_name: true,
        email: true,
        is_claims_director: true,
        reports_to_id: true,
        deleted_at: true,
      },
    });

    // Uniform 401 — do not leak whether username exists.
    if (!user || user.deleted_at !== null) {
      // Still run a dummy compare to prevent timing attacks that can reveal
      // whether the user record was found.
      await bcrypt.compare(dto.password, '$2b$12$dummyhashtopreventtimingattacks0000000000000000000');
      throw new UnauthorizedException('Invalid username or password.');
    }

    const passwordValid = await bcrypt.compare(dto.password, user.password_hash);
    if (!passwordValid) {
      throw new UnauthorizedException('Invalid username or password.');
    }

    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      is_claims_director: user.is_claims_director,
    };

    const secret = this.getJwtSecret();
    const access_token = jwt.sign(payload, secret, {
      expiresIn: AuthService.JWT_EXPIRES_IN_SECONDS,
    });

    return {
      access_token,
      expires_in: AuthService.JWT_EXPIRES_IN_SECONDS,
      role: user.role,
      is_claims_director: user.is_claims_director,
      user_id: user.id,
      username: user.username,
      display_name: user.display_name,
    };
  }

  // ---------------------------------------------------------------------------
  // me
  // ---------------------------------------------------------------------------

  /**
   * Returns the authenticated user's profile.
   *
   * Called by GET /auth/me. The JwtAuthGuard has already verified the token;
   * this method fetches a fresh record from the DB so that stale JWT claims
   * (e.g. a role change) can be surfaced.
   *
   * @param userId  The `sub` field from the verified JWT payload.
   */
  async me(userId: string): Promise<MeResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        display_name: true,
        email: true,
        role: true,
        is_claims_director: true,
        reports_to_id: true,
        created_at: true,
        deleted_at: true,
      },
    });

    if (!user || user.deleted_at !== null) {
      throw new NotFoundException('User account not found or has been deactivated.');
    }

    return {
      user_id: user.id,
      username: user.username,
      display_name: user.display_name,
      email: user.email,
      role: user.role,
      is_claims_director: user.is_claims_director,
      reports_to_id: user.reports_to_id,
      created_at: user.created_at,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Hashes a plaintext password with bcrypt at cost factor 12.
   * Exposed so seed.ts and future admin endpoints can create users safely.
   */
  static async hashPassword(plaintext: string): Promise<string> {
    return bcrypt.hash(plaintext, 12);
  }

  /**
   * Retrieves and validates the JWT secret from config.
   * Throws a configuration error at runtime (not at startup) so tests can
   * supply the value via environment variables.
   */
  private getJwtSecret(): string {
    const secret = this.configService.get<string>('JWT_SECRET');
    if (!secret) {
      throw new Error(
        'JWT_SECRET environment variable is not set. ' +
        'Cannot issue tokens without a secret.',
      );
    }
    return secret;
  }
}