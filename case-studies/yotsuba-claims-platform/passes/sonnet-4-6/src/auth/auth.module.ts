// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/auth/auth.module.ts
//
// Authentication module. Wires together:
//   - AuthController  (POST /auth/login, GET /auth/me)
//   - AuthService     (credential validation, JWT issuance, user profile)
//   - PrismaService   (database access, imported transitively via AppModule
//                      but declared explicitly for clarity and testability)
//   - ConfigModule    (JWT_SECRET retrieval)
//   - ThrottlerModule (5 req/min/IP on the login endpoint — applied at the
//                      route level via @UseGuards(ThrottlerGuard) in the
//                      controller, configured in AppModule's global throttler)
//
// JWT strategy is stateless (HS256). No Passport strategy is introduced to
// keep the dependency surface minimal; JwtAuthGuard in common/ validates
// tokens directly via the `jsonwebtoken` library.
// =============================================================================

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../prisma.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  imports: [
    // ConfigModule is imported here so that AuthService can inject
    // ConfigService to retrieve JWT_SECRET at runtime. The global
    // ConfigModule registration in AppModule makes this technically
    // redundant, but the explicit import makes this module self-contained
    // for unit-testing purposes (tests can import AuthModule standalone
    // with a test ConfigModule without pulling in all of AppModule).
    ConfigModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    // PrismaService is declared as a provider here (rather than relying
    // solely on a global provider) so that this module remains importable
    // in isolation during e2e tests that substitute a test database.
    PrismaService,
  ],
  exports: [
    // Export AuthService so that other modules (e.g. a future AdminModule
    // that needs to create users) can reuse credential helpers such as
    // AuthService.hashPassword without re-declaring the provider.
    AuthService,
  ],
})
export class AuthModule {}