import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma.service';

/**
 * Authentication module for Yotsuba Claims Platform.
 *
 * Provides JWT-based authentication services, including user login and token generation.
 * Integrates with Prisma for user persistence and NestJS JWT for token signing.
 *
 * Exports:
 *   - AuthService: Core authentication logic (login, getCurrentUser, hashPassword)
 *   - JwtModule: Configured for token signing and verification
 *
 * Usage:
 *   Import AuthModule in AppModule to enable /auth/login and /auth/me endpoints.
 */
@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'your-secret-key-change-in-production',
      signOptions: {
        expiresIn: process.env.JWT_EXPIRES_IN || '24h',
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, PrismaService],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}