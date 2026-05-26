import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma.service';
import { LoginDto } from './dto/login.dto';
import * as bcrypt from 'bcrypt';
import { UserRole } from '@prisma/client';

/**
 * Authentication service for Yotsuba Claims Platform.
 *
 * Handles user login, JWT token generation, and user lookup.
 * Passwords are hashed using bcrypt; tokens are signed with JWT_SECRET from environment.
 *
 * Usage:
 *   const result = await authService.login(loginDto);
 *   // result = { access_token: string, role: UserRole }
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * Authenticate a user by username and password.
   *
   * Looks up the user by username, verifies the password against the stored hash,
   * and returns a signed JWT token along with the user's role.
   *
   * @param dto Login credentials (username, password)
   * @returns Object containing access_token and role
   * @throws UnauthorizedException if user not found or password is incorrect
   */
  async login(dto: LoginDto): Promise<{ access_token: string; role: UserRole }> {
    const user = await this.prisma.user.findUnique({
      where: { username: dto.username },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid username or password');
    }

    const passwordMatch = await bcrypt.compare(dto.password, user.password_hash);
    if (!passwordMatch) {
      throw new UnauthorizedException('Invalid username or password');
    }

    const payload = {
      id: user.id,
      username: user.username,
      role: user.role,
      is_claims_director: user.is_claims_director,
    };

    const access_token = this.jwtService.sign(payload, {
      secret: process.env.JWT_SECRET || 'your-secret-key-change-in-production',
      expiresIn: process.env.JWT_EXPIRES_IN || '24h',
    });

    return {
      access_token,
      role: user.role,
    };
  }

  /**
   * Retrieve the current user by ID.
   *
   * Used by the /auth/me endpoint to return the authenticated user's details.
   *
   * @param userId The ID of the user to retrieve
   * @returns The user object (without password_hash)
   * @throws NotFoundException if user not found
   */
  async getCurrentUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        display_name: true,
        email: true,
        role: true,
        is_claims_director: true,
        created_at: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return user;
  }

  /**
   * Hash a plaintext password using bcrypt.
   *
   * Used during user creation (in seed or admin endpoints).
   * Rounds are set to 10 for a balance between security and performance.
   *
   * @param password The plaintext password to hash
   * @returns The bcrypt hash
   */
  async hashPassword(password: string): Promise<string> {
    const rounds = 10;
    return bcrypt.hash(password, rounds);
  }
}