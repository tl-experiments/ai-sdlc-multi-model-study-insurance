// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// Authentication service.
//
// Responsibilities:
//   * Validate a username/password pair against the `User` table.
//   * Issue a short-lived JWT carrying the actor envelope that
//     `JwtAuthGuard` + `RolesGuard` rely on (sub, username, role,
//     is_claims_director).
//   * Resolve the current user record for `GET /auth/me`.
//
// What this service deliberately does NOT do:
//   * User creation / password rotation — out of scope for Track A;
//     accounts are provisioned by `prisma/seed.ts`.
//   * Refresh tokens — Track A uses a single short-lived access token.
//   * Account lockout on repeated failures — handled at the edge by
//     `@nestjs/throttler` on `/auth/login` (5 req/min/IP per brief).
//
// Security notes:
//   * Failure messages are intentionally generic ("Invalid credentials")
//     so the endpoint does not leak whether a username exists. The bcrypt
//     compare runs even on unknown usernames against a fixed dummy hash,
//     so attacker-observable timing is roughly the same for the two
//     cases.
//   * Soft-deleted users (`deleted_at != null`) cannot log in.
//   * `JWT_SECRET` is required — if absent, the service refuses to mint
//     tokens rather than falling back to a weak default.
// ─────────────────────────────────────────────────────────────────────────

import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { sign, type SignOptions } from 'jsonwebtoken';

import type { User, UserRole } from '@prisma/client';

import { PrismaService } from '../prisma.service';
import type { JwtPayload } from '../common/jwt-auth.guard';
import type { LoginDto } from './dto/login.dto';

/**
 * Shape returned to the client on successful login. Mirrors the contract
 * declared in design.md §2: `{ access_token, role }`. We additionally
 * surface a couple of fields the workbench UI needs immediately after
 * login so it can render the role badge without a second round-trip.
 */
export interface LoginResult {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  role: UserRole;
  user: AuthenticatedUserView;
}

/**
 * Sanitised projection of `User` — never includes `password_hash` and is
 * safe to embed in API responses.
 */
export interface AuthenticatedUserView {
  id: string;
  username: string;
  display_name: string;
  email: string;
  role: UserRole;
  is_claims_director: boolean;
  reports_to_id: string | null;
}

/**
 * A pre-computed bcrypt hash used to keep the timing of unknown-username
 * logins comparable to known-username logins. The plaintext is irrelevant
 * — what matters is that `bcrypt.compare` does the same amount of work
 * either way. Generated once at module load.
 */
const TIMING_EQUALISER_HASH: string = bcrypt.hashSync(
  'yotsuba-timing-equaliser',
  10,
);

/** Token lifetime in seconds. Kept short; no refresh-token flow in Track A. */
const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60 * 8; // 8 hours

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Validate credentials and mint a JWT. The two failure modes (unknown
   * username, wrong password) return the same generic message and run
   * comparable amounts of work so the endpoint does not enumerate users.
   */
  async login(dto: LoginDto): Promise<LoginResult> {
    const secret = this.requireJwtSecret();

    const user = await this.prisma.user.findUnique({
      where: { username: dto.username },
    });

    // Always perform a bcrypt compare so timing does not distinguish
    // "no such user" from "wrong password".
    const hashToCompare =
      user && user.deleted_at === null
        ? user.password_hash
        : TIMING_EQUALISER_HASH;

    const passwordOk = await bcrypt.compare(dto.password, hashToCompare);

    if (!user || user.deleted_at !== null || !passwordOk) {
      this.logger.warn(
        `Failed login attempt for username="${dto.username}".`,
      );
      throw new UnauthorizedException('Invalid credentials.');
    }

    const ttl = this.resolveTokenTtlSeconds();
    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      is_claims_director: user.is_claims_director,
    };

    const signOptions: SignOptions = {
      expiresIn: ttl,
      issuer: 'yotsuba-claims',
    };

    let token: string;
    try {
      token = sign(payload, secret, signOptions);
    } catch (err) {
      this.logger.error(
        `Failed to sign JWT for user ${user.username}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new InternalServerErrorException('Could not issue access token.');
    }

    this.logger.log(
      `Issued access token for user=${user.username} role=${user.role} ` +
        `is_claims_director=${user.is_claims_director}.`,
    );

    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: ttl,
      role: user.role,
      user: this.toView(user),
    };
  }

  /**
   * Resolve the current actor for `GET /auth/me`. The JWT guard has
   * already verified the token; this method confirms the underlying
   * account still exists and has not been soft-deleted.
   */
  async me(userId: string): Promise<AuthenticatedUserView> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.deleted_at !== null) {
      throw new NotFoundException('User no longer exists.');
    }
    return this.toView(user);
  }

  // ─── helpers ─────────────────────────────────────────────────────────

  private requireJwtSecret(): string {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.trim() === '') {
      this.logger.error(
        'JWT_SECRET is not configured; refusing to mint tokens.',
      );
      throw new InternalServerErrorException(
        'Authentication is not configured.',
      );
    }
    return secret;
  }

  /**
   * Token TTL is configurable via `JWT_TTL_SECONDS` for operational
   * flexibility (e.g. tests that need expired tokens). Invalid or
   * missing values fall back to the default.
   */
  private resolveTokenTtlSeconds(): number {
    const raw = process.env.JWT_TTL_SECONDS;
    if (!raw) return DEFAULT_TOKEN_TTL_SECONDS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      this.logger.warn(
        `Ignoring invalid JWT_TTL_SECONDS="${raw}"; using default ` +
          `${DEFAULT_TOKEN_TTL_SECONDS}s.`,
      );
      return DEFAULT_TOKEN_TTL_SECONDS;
    }
    return parsed;
  }

  private toView(user: User): AuthenticatedUserView {
    return {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      email: user.email,
      role: user.role,
      is_claims_director: user.is_claims_director,
      reports_to_id: user.reports_to_id,
    };
  }
}