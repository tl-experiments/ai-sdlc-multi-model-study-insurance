// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/auth/auth.controller.ts
//
// Authentication controller. Exposes:
//   POST /auth/login  — issue a JWT for valid credentials.
//   GET  /auth/me     — return the current authenticated user's profile.
//
// Rate-limiting on /auth/login is applied at the module level via
// @nestjs/throttler (5 req/min/IP) — see auth.module.ts.
// =============================================================================

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Request as ExpressRequest } from 'express';
import { JwtAuthGuard, JwtPayload } from '../common/jwt-auth.guard';
import { AuthService, LoginResponse, MeResponse } from './auth.service';
import { LoginDto } from './dto/login.dto';

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // -------------------------------------------------------------------------
  // POST /auth/login
  // -------------------------------------------------------------------------

  /**
   * Validates username / password and returns a signed JWT.
   *
   * Returns HTTP 200 (not 201) because no resource is created — a token is
   * issued. @HttpCode explicitly overrides NestJS's default 201 for POST.
   *
   * Rate-limited to 5 requests / minute / IP via ThrottlerGuard applied in
   * app.module.ts; auth.module.ts binds the short-duration throttler.
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Issue a JWT for valid credentials.',
    description:
      'Validates the supplied username and password. On success, returns a ' +
      'signed JWT (8-hour lifetime) along with the caller\'s role and display ' +
      'name. Rate-limited to 5 requests per minute per IP address.',
  })
  @ApiBody({ type: LoginDto })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Authentication succeeded — JWT returned.',
    schema: {
      type: 'object',
      properties: {
        access_token:       { type: 'string', example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' },
        expires_in:         { type: 'number', example: 28800, description: 'Seconds until expiry.' },
        role:               { type: 'string', example: 'adjuster' },
        is_claims_director: { type: 'boolean', example: false },
        user_id:            { type: 'string', example: 'clxxxxxxxxxxxxxxxxxxxxx' },
        username:           { type: 'string', example: 'adjuster_tanaka' },
        display_name:       { type: 'string', example: '田中 一郎' },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Invalid username or password.',
  })
  @ApiResponse({
    status: HttpStatus.TOO_MANY_REQUESTS,
    description: 'Rate limit exceeded — 5 requests per minute per IP.',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Request body failed validation.',
  })
  async login(@Body() dto: LoginDto): Promise<LoginResponse> {
    return this.authService.login(dto);
  }

  // -------------------------------------------------------------------------
  // GET /auth/me
  // -------------------------------------------------------------------------

  /**
   * Returns the currently authenticated user's profile.
   *
   * The JwtAuthGuard verifies the Bearer token and populates `request.user`
   * with the decoded JwtPayload. This handler then fetches a fresh record
   * from the DB so that any role changes applied after token issuance are
   * surfaced immediately (avoiding stale-claim issues for a 8-hour token).
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Return the current authenticated user.',
    description:
      'Fetches a fresh copy of the caller\'s user record from the database. ' +
      'This ensures that any role or is_claims_director changes applied after ' +
      'the JWT was issued are immediately reflected without requiring ' +
      're-authentication.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Authenticated user profile returned.',
    schema: {
      type: 'object',
      properties: {
        user_id:            { type: 'string', example: 'clxxxxxxxxxxxxxxxxxxxxx' },
        username:           { type: 'string', example: 'adjuster_tanaka' },
        display_name:       { type: 'string', example: '田中 一郎' },
        email:              { type: 'string', example: 'tanaka@yotsuba-ins.co.jp' },
        role:               { type: 'string', example: 'adjuster' },
        is_claims_director: { type: 'boolean', example: false },
        reports_to_id:      { type: 'string', nullable: true, example: 'clyyyyyyyyyyyyyyyyyyy' },
        created_at:         { type: 'string', format: 'date-time', example: '2024-01-15T09:00:00.000Z' },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Missing or invalid Bearer token.',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'User account not found or has been deactivated.',
  })
  async me(@Request() req: ExpressRequest): Promise<MeResponse> {
    // JwtAuthGuard has already validated the token and attached the payload.
    const payload = req.user as JwtPayload;
    return this.authService.me(payload.sub);
  }
}