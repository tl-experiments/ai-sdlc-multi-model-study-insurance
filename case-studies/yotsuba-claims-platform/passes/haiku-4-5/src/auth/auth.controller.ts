import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Request,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { UserRole } from '@prisma/client';

/**
 * Authentication controller for Yotsuba Claims Platform.
 *
 * Handles user login and current user retrieval.
 * The /auth/login endpoint is public; /auth/me requires a valid JWT.
 *
 * Usage:
 *   POST /auth/login { username, password } → { access_token, role }
 *   GET /auth/me (with JWT) → { id, username, display_name, email, role, is_claims_director, created_at }
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * User login endpoint.
   *
   * Accepts username and password, validates them against the database,
   * and returns a signed JWT token along with the user's role.
   *
   * @param dto Login credentials (username, password)
   * @returns Object containing access_token and role
   * @throws UnauthorizedException if credentials are invalid
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto): Promise<{ access_token: string; role: UserRole }> {
    return this.authService.login(dto);
  }

  /**
   * Get current authenticated user.
   *
   * Returns the authenticated user's profile information.
   * Requires a valid JWT token in the Authorization header.
   *
   * @param user The authenticated user (injected by JwtAuthGuard)
   * @returns The user object (without password_hash)
   * @throws UnauthorizedException if JWT is invalid or missing
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getCurrentUser(
    @CurrentUser() user: { id: string; role: UserRole; is_claims_director?: boolean },
  ) {
    return this.authService.getCurrentUser(user.id);
  }
}