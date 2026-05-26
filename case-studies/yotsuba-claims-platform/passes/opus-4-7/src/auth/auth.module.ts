// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// Authentication module.
//
// Wires together the controller + service that implement the two public
// auth endpoints (`POST /auth/login`, `GET /auth/me`). The module is
// deliberately thin: it owns no providers beyond `AuthService`, and
// exposes `AuthService` so that other modules (e.g. tests, or a future
// admin module) can resolve it without re-declaring it.
//
// Notes:
//   * `PrismaService` is provided here rather than imported from a
//     shared module. The codebase follows the convention of declaring
//     `PrismaService` as a provider in each module that needs it; Nest
//     deduplicates the singleton at the root injector. This keeps each
//     module's dependency list explicit and self-contained.
//   * JWT signing/verification is performed directly via `jsonwebtoken`
//     inside `AuthService` and `JwtAuthGuard` respectively, so there is
//     no `JwtModule` to import here. The `JWT_SECRET` env var is the
//     single source of truth, validated at call time.
//   * The global `ThrottlerGuard` (registered in `app.module.ts`) reads
//     the `@Throttle({...})` metadata on `AuthController.login`, so no
//     throttler wiring is needed at this level.
// ─────────────────────────────────────────────────────────────────────────

import { Module } from '@nestjs/common';

import { PrismaService } from '../prisma.service';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, PrismaService],
  exports: [AuthService],
})
export class AuthModule {}