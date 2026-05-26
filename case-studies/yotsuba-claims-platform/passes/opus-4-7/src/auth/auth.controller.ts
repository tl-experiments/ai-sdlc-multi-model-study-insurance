// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// Authentication controller.
//
// Exposes the two endpoints declared in design.md §2:
//   * `POST /auth/login` — public; exchanges username/password for a JWT.
//   * `GET  /auth/me`    — authenticated; returns the current actor's
//                          sanitised profile.
//
// Design notes:
//   * `POST /auth/login` is marked `@Public()` so `JwtAuthGuard` lets it
//     through unauthenticated. `RolesGuard` also short-circuits on the
//     same metadata key. This is the only public route in the system.
//   * Rate-limiting on `/auth/login` (5 req/min/IP, per the brief) is
//     applied via `@Throttle` here so the limit travels with the route
//     definition rather than being a property of some far-away module
//     configuration. The global `ThrottlerGuard` is registered in
//     `app.module.ts`.
//   * The login route is annotated with HTTP 200 explicitly. Nest's
//     default for POST is 201, but `login` is not creating a resource —
//     it is exchanging credentials — and clients (incl. the workbench
//     UI) expect 200 on success.
//   * `@CurrentUser()` injects the actor envelope that `JwtAuthGuard`
//     placed on the request; we then ask `AuthService.me` to confirm the
//     underlying record still exists and is not soft-deleted, so a token
//     whose user was disabled mid-session yields 404 rather than a
//     stale view.
// ─────────────────────────────────────────────────────────────────────────

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../common/current-user.decorator';
import type { AuthenticatedUser } from '../common/jwt-auth.guard';
import { Public } from '../common/jwt-auth.guard';

import {
  AuthService,
  type AuthenticatedUserView,
  type LoginResult,
} from './auth.service';
import { LoginDto } from './dto/login.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Exchange username/password for a short-lived access token.
   *
   * Public by design — this is the bootstrap into the rest of the API.
   * Throttled to 5 requests per minute per IP (per brief.md §NFR) so the
   * endpoint is not a usable credential-stuffing surface.
   */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Exchange credentials for an access token.',
    description:
      'Validates the supplied username/password against the User table '
      + 'and returns a signed JWT plus a sanitised actor profile. Rate-'
      + 'limited to 5 requests per minute per IP.',
  })
  @ApiBody({ type: LoginDto })
  @ApiOkResponse({
    description: 'Credentials accepted; access token issued.',
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid credentials. Message is intentionally generic '
      + 'so the endpoint does not enumerate accounts.',
  })
  @ApiTooManyRequestsResponse({
    description: 'Too many login attempts from this IP.',
  })
  async login(@Body() dto: LoginDto): Promise<LoginResult> {
    return this.authService.login(dto);
  }

  /**
   * Return the current actor's sanitised profile. Useful for the
   * workbench UI's initial render (role badge, display name) and as a
   * cheap token-liveness check.
   */
  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Return the authenticated actor\'s profile.',
    description:
      'Re-reads the User row referenced by the JWT subject so a token '
      + 'whose underlying account was disabled mid-session yields 404 '
      + 'rather than a stale view.',
  })
  @ApiOkResponse({ description: 'Current actor profile.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  async me(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AuthenticatedUserView> {
    return this.authService.me(user.sub);
  }
}