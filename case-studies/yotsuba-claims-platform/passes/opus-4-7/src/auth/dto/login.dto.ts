// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// Login DTO.
//
// Shape of the request body accepted by `POST /auth/login`. Kept narrow
// on purpose — the login route is the single public entry point into the
// platform, and a tight DTO is the first line of defence against abuse:
//   * `class-validator` rejects malformed bodies before they reach the
//     service layer, where they would otherwise consume a bcrypt compare.
//   * Length caps make it harder to weaponise the endpoint as a CPU sink.
//   * Trimming whitespace removes a common source of "copy/paste from
//     spreadsheet" support tickets without weakening the credential.
//
// Note: we do NOT enforce password-strength rules here. Strength is a
// concern at user-creation time (out of scope for Track A; seeded by
// `prisma/seed.ts`). At login we only validate well-formedness.
// ─────────────────────────────────────────────────────────────────────────

import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body for `POST /auth/login`.
 *
 * Example:
 *   { "username": "adjuster.tanaka", "password": "correct-horse-battery" }
 */
export class LoginDto {
  /**
   * Account identifier. Matches `User.username` (unique). We trim
   * surrounding whitespace because terminal copy/paste frequently appends
   * a stray space, and there is no legitimate username with leading or
   * trailing whitespace in this system.
   */
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString({ message: 'username must be a string.' })
  @MinLength(1, { message: 'username is required.' })
  @MaxLength(128, { message: 'username is too long.' })
  username!: string;

  /**
   * Cleartext password. Compared against `User.password_hash` by
   * `AuthService.login`. We do NOT trim — leading/trailing whitespace is
   * a legitimate part of a password and silently stripping it would
   * weaken credentials.
   *
   * The upper bound exists purely to bound bcrypt's input; bcrypt itself
   * truncates beyond 72 bytes, but we reject well before that so the
   * server is not asked to hash multi-megabyte payloads.
   */
  @IsString({ message: 'password must be a string.' })
  @MinLength(1, { message: 'password is required.' })
  @MaxLength(256, { message: 'password is too long.' })
  password!: string;
}