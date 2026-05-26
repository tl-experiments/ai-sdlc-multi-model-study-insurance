// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// End-to-end tests for the authentication module.
//
// Covered scenarios (per brief.md acceptance criteria — at least one happy
// path + one auth-denied + one validation-failure per module):
//
//   Happy path:
//     * POST /auth/login with a seeded user returns 200 with an access_token
//       and a sanitised actor view.
//     * GET  /auth/me with that token returns the same actor profile.
//
//   Auth-denied:
//     * POST /auth/login with a wrong password returns 401 with the generic
//       "Invalid credentials." message.
//     * POST /auth/login with an unknown username returns 401 with the same
//       generic message (no user enumeration).
//     * GET  /auth/me without a bearer token returns 401.
//     * GET  /auth/me with a forged/invalid token returns 401.
//     * A soft-deleted user cannot log in.
//
//   Validation-failure:
//     * POST /auth/login with a missing username field returns 400.
//     * POST /auth/login with non-string fields returns 400.
//
// Notes:
//   * These tests boot the real Nest application against the test Postgres
//     instance (DATABASE_URL must point at it). A small fixture user is
//     created in beforeAll and torn down in afterAll so the suite is
//     hermetic and does not depend on `prisma/seed.ts` having been run.
//   * `JWT_SECRET` is set before the module is compiled so AuthService can
//     mint tokens. We deliberately use a fixed test secret rather than the
//     production env so the suite is reproducible.
// ─────────────────────────────────────────────────────────────────────────

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';

// Ensure JWT signing is configured before the Nest module is compiled.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'yotsuba-test-secret';

interface SeededUser {
  id: string;
  username: string;
  password: string;
  email: string;
}

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const activeUser: SeededUser = {
    id: '',
    username: 'auth_test_adjuster',
    password: 'CorrectHorseBatteryStaple1!',
    email: 'auth_test_adjuster@yotsuba.test',
  };

  const softDeletedUser: SeededUser = {
    id: '',
    username: 'auth_test_disabled',
    password: 'AlsoAStrongPassword2@',
    email: 'auth_test_disabled@yotsuba.test',
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    prisma = app.get(PrismaService);

    // Clean any prior fixtures from a previous failed run.
    await prisma.user.deleteMany({
      where: {
        username: { in: [activeUser.username, softDeletedUser.username] },
      },
    });

    const activeHash = await bcrypt.hash(activeUser.password, 10);
    const disabledHash = await bcrypt.hash(softDeletedUser.password, 10);

    const active = await prisma.user.create({
      data: {
        username: activeUser.username,
        password_hash: activeHash,
        role: 'adjuster',
        display_name: 'Auth Test Adjuster',
        email: activeUser.email,
        is_claims_director: false,
      },
    });
    activeUser.id = active.id;

    const disabled = await prisma.user.create({
      data: {
        username: softDeletedUser.username,
        password_hash: disabledHash,
        role: 'adjuster',
        display_name: 'Auth Test Disabled',
        email: softDeletedUser.email,
        is_claims_director: false,
        deleted_at: new Date(),
      },
    });
    softDeletedUser.id = disabled.id;
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.user.deleteMany({
        where: {
          username: { in: [activeUser.username, softDeletedUser.username] },
        },
      });
    }
    if (app) {
      await app.close();
    }
  });

  // ─── happy path ────────────────────────────────────────────────────

  describe('POST /auth/login (happy path)', () => {
    it('returns 200 with an access_token and sanitised actor view', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: activeUser.username,
          password: activeUser.password,
        })
        .expect(200);

      expect(res.body).toEqual(
        expect.objectContaining({
          access_token: expect.any(String),
          token_type: 'Bearer',
          expires_in: expect.any(Number),
          role: 'adjuster',
          user: expect.objectContaining({
            id: activeUser.id,
            username: activeUser.username,
            email: activeUser.email,
            role: 'adjuster',
            is_claims_director: false,
            reports_to_id: null,
          }),
        }),
      );

      // The response must never include the password hash, even nested.
      const serialised = JSON.stringify(res.body);
      expect(serialised).not.toMatch(/password_hash/);
      expect(serialised).not.toMatch(/\$2[aby]\$/); // bcrypt prefix
    });
  });

  describe('GET /auth/me (happy path)', () => {
    it('returns the current actor profile when given a valid bearer token', async () => {
      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: activeUser.username,
          password: activeUser.password,
        })
        .expect(200);

      const token = login.body.access_token as string;
      expect(token).toBeTruthy();

      const me = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(me.body).toEqual(
        expect.objectContaining({
          id: activeUser.id,
          username: activeUser.username,
          email: activeUser.email,
          role: 'adjuster',
          is_claims_director: false,
          reports_to_id: null,
        }),
      );
    });
  });

  // ─── auth-denied ───────────────────────────────────────────────────

  describe('POST /auth/login (auth-denied)', () => {
    it('returns 401 with a generic message when the password is wrong', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: activeUser.username,
          password: 'definitely-not-the-right-password',
        })
        .expect(401);

      expect(res.body).toEqual(
        expect.objectContaining({
          message: 'Invalid credentials.',
        }),
      );
      // No stack traces in API responses (per brief.md NFR).
      expect(res.body).not.toHaveProperty('stack');
    });

    it('returns 401 with the same message for an unknown username (no enumeration)', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: 'no_such_user_exists_anywhere',
          password: 'irrelevant-password',
        })
        .expect(401);

      expect(res.body).toEqual(
        expect.objectContaining({
          message: 'Invalid credentials.',
        }),
      );
    });

    it('refuses to authenticate a soft-deleted user', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: softDeletedUser.username,
          password: softDeletedUser.password,
        })
        .expect(401);

      expect(res.body).toEqual(
        expect.objectContaining({
          message: 'Invalid credentials.',
        }),
      );
    });
  });

  describe('GET /auth/me (auth-denied)', () => {
    it('returns 401 when no bearer token is supplied', async () => {
      await request(app.getHttpServer()).get('/auth/me').expect(401);
    });

    it('returns 401 when the bearer token is malformed', async () => {
      await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', 'Bearer not-a-real-jwt')
        .expect(401);
    });

    it('returns 401 when the bearer token is signed with the wrong secret', async () => {
      // Forge a token with a different secret; the guard must reject it.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { sign } = require('jsonwebtoken') as typeof import('jsonwebtoken');
      const forged = sign(
        {
          sub: activeUser.id,
          username: activeUser.username,
          role: 'adjuster',
          is_claims_director: false,
        },
        'a-completely-different-secret',
        { expiresIn: 60, issuer: 'yotsuba-claims' },
      );

      await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${forged}`)
        .expect(401);
    });
  });

  // ─── validation-failure ────────────────────────────────────────────

  describe('POST /auth/login (validation-failure)', () => {
    it('returns 400 when the username field is missing', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ password: 'whatever' })
        .expect(400);

      // Standardised error envelope; no stack traces leaked.
      expect(res.body).not.toHaveProperty('stack');
    });

    it('returns 400 when the password field is missing', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: activeUser.username })
        .expect(400);
    });

    it('returns 400 when fields are of the wrong type', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: 12345, password: { nested: 'object' } })
        .expect(400);
    });

    it('returns 400 when extra unknown fields are supplied (whitelist)', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: activeUser.username,
          password: activeUser.password,
          admin: true,
        })
        .expect(400);
    });
  });
});