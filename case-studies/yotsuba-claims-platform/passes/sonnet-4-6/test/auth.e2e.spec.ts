// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// test/auth.e2e.spec.ts
//
// End-to-end tests for the authentication module.
//
// Coverage:
//   - POST /auth/login  happy path (agent, adjuster, manager, auditor)
//   - POST /auth/login  validation failures (missing fields, wrong types)
//   - POST /auth/login  auth-denied paths (wrong password, unknown user,
//                       soft-deleted user)
//   - GET  /auth/me     happy path — returns fresh profile from DB
//   - GET  /auth/me     auth-denied paths (no token, malformed token,
//                       expired token)
//
// Tests run against a real Postgres test database specified in
// DATABASE_URL_TEST (falls back to DATABASE_URL).  The seed helper creates
// isolated users per-suite to avoid cross-test pollution.
// =============================================================================

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Bootstraps the NestJS application with the same pipes / filters that
 * main.ts applies, so integration behaviour is identical.
 */
async function buildApp(): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();

  // Mirror main.ts configuration -----------------------------------------
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Error filter is registered globally in AppModule; no need to add here.

  await app.init();
  return app;
}

/**
 * Creates a test user directly in the DB and returns the id + credentials.
 * Each call generates a unique username via a timestamp + random suffix.
 */
async function createTestUser(
  prisma: PrismaService,
  overrides: {
    role?: 'agent' | 'adjuster' | 'manager' | 'auditor' | 'siu_referrer';
    is_claims_director?: boolean;
    deleted?: boolean;
  } = {},
): Promise<{ id: string; username: string; password: string }> {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const username = `test_user_${suffix}`;
  const password = 'Test@Passw0rd!';
  const password_hash = await bcrypt.hash(password, 10); // 10 rounds — faster in tests

  const user = await prisma.user.create({
    data: {
      username,
      password_hash,
      role: overrides.role ?? 'adjuster',
      display_name: `Test User ${suffix}`,
      email: `${username}@test.yotsuba.example`,
      is_claims_director: overrides.is_claims_director ?? false,
      deleted_at: overrides.deleted ? new Date() : null,
    },
  });

  return { id: user.id, username, password };
}

/**
 * Obtains a JWT for the given user by calling POST /auth/login.
 * Throws if the login does not return 200.
 */
async function loginAs(
  app: INestApplication,
  username: string,
  password: string,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ username, password })
    .expect(200);

  return res.body.access_token as string;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Auth Module (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  // =========================================================================
  // POST /auth/login
  // =========================================================================

  describe('POST /auth/login', () => {
    // -----------------------------------------------------------------------
    // Happy paths
    // -----------------------------------------------------------------------

    describe('happy path', () => {
      it('returns 200 with access_token and correct role for an adjuster', async () => {
        const { username, password } = await createTestUser(prisma, { role: 'adjuster' });

        const res = await request(app.getHttpServer())
          .post('/auth/login')
          .send({ username, password })
          .expect(200);

        expect(res.body).toMatchObject({
          role: 'adjuster',
          is_claims_director: false,
          username,
        });
        expect(typeof res.body.access_token).toBe('string');
        expect(res.body.access_token.length).toBeGreaterThan(20);
        expect(res.body.expires_in).toBe(8 * 60 * 60);
        expect(res.body.display_name).toBeDefined();
        expect(res.body.user_id).toBeDefined();
      });

      it('returns 200 with correct role for an agent', async () => {
        const { username, password } = await createTestUser(prisma, { role: 'agent' });

        const res = await request(app.getHttpServer())
          .post('/auth/login')
          .send({ username, password })
          .expect(200);

        expect(res.body.role).toBe('agent');
      });

      it('returns 200 with correct role for a manager', async () => {
        const { username, password } = await createTestUser(prisma, { role: 'manager' });

        const res = await request(app.getHttpServer())
          .post('/auth/login')
          .send({ username, password })
          .expect(200);

        expect(res.body.role).toBe('manager');
      });

      it('returns 200 with correct role for an auditor', async () => {
        const { username, password } = await createTestUser(prisma, { role: 'auditor' });

        const res = await request(app.getHttpServer())
          .post('/auth/login')
          .send({ username, password })
          .expect(200);

        expect(res.body.role).toBe('auditor');
      });

      it('returns 200 with correct role for an siu_referrer', async () => {
        const { username, password } = await createTestUser(prisma, { role: 'siu_referrer' });

        const res = await request(app.getHttpServer())
          .post('/auth/login')
          .send({ username, password })
          .expect(200);

        expect(res.body.role).toBe('siu_referrer');
      });

      it('returns is_claims_director=true when the user flag is set', async () => {
        const { username, password } = await createTestUser(prisma, {
          role: 'manager',
          is_claims_director: true,
        });

        const res = await request(app.getHttpServer())
          .post('/auth/login')
          .send({ username, password })
          .expect(200);

        expect(res.body.is_claims_director).toBe(true);
      });

      it('does NOT include password_hash in the response', async () => {
        const { username, password } = await createTestUser(prisma);

        const res = await request(app.getHttpServer())
          .post('/auth/login')
          .send({ username, password })
          .expect(200);

        expect(res.body.password_hash).toBeUndefined();
      });

      it('returns a JWT that decodes to the correct sub', async () => {
        const { id, username, password } = await createTestUser(prisma);

        const res = await request(app.getHttpServer())
          .post('/auth/login')
          .send({ username, password })
          .expect(200);

        // Decode (without verifying signature) to check the payload.
        const parts = (res.body.access_token as string).split('.');
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
        expect(payload.sub).toBe(id);
        expect(payload.username).toBe(username);
        expect(payload.role).toBeDefined();
      });
    });

    // -----------------------------------------------------------------------
    // Validation failures
    // -----------------------------------------------------------------------

    describe('validation failure — 400', () => {
      it('returns 400 when username is missing', async () => {
        const res = await request(app.getHttpServer())
          .post('/auth/login')
          .send({ password: 'SomePassword1!' })
          .expect(400);

        expect(res.body.statusCode).toBe(400);
      });

      it('returns 400 when password is missing', async () => {
        const res = await request(app.getHttpServer())
          .post('/auth/login')
          .send({ username: 'somebody' })
          .expect(400);

        expect(res.body.statusCode).toBe(400);
      });

      it('returns 400 when both fields are missing', async () => {
        const res = await request(app.getHttpServer())
          .post('/auth/login')
          .send({})
          .expect(400);

        expect(res.body.statusCode).toBe(400);
      });

      it('returns 400 when username is not a string', async () => {
        const res = await request(app.getHttpServer())
          .post('/auth/login')
          .send({ username: 12345, password: 'ValidPass1!' })
          .expect(400);

        expect(res.body.statusCode).toBe(400);
      });

      it('returns 400 when body is not JSON', async () => {
        const res = await request(app.getHttpServer())
          .post('/auth/login')
          .set('Content-Type', 'application/json')
          .send('not-json')
          .expect(400);

        expect(res.body.statusCode).toBe(400);
      });

      it('returns 400 (not 500) and does not leak a stack trace', async () => {
        const res = await request(app.getHttpServer())
          .post('/auth/login')
          .send({ username: '', password: '' })
          .expect(400);

        expect(res.body.stack).toBeUndefined();
        expect(res.body.statusCode).toBe(400);
      });
    });

    // -----------------------------------------------------------------------
    // Auth-denied paths — 401
    // -----------------------------------------------------------------------

    describe('auth-denied — 401', () => {
      it('returns 401 for a correct username but wrong password', async () => {
        const { username } = await createTestUser(prisma);

        const res = await request(app.getHttpServer())
          .post('/auth/login')
          .send({ username, password: 'WrongPassword99!' })
          .expect(401);

        expect(res.body.statusCode).toBe(401);
        // Must not leak whether the user exists.
        expect(res.body.message).toMatch(/invalid username or password/i);
      });

      it('returns 401 for an unknown username', async () => {
        const res = await request(app.getHttpServer())
          .post('/auth/login')
          .send({ username: 'nonexistent_user_xyz', password: 'AnyPassword1!' })
          .expect(401);

        expect(res.body.statusCode).toBe(401);
        expect(res.body.message).toMatch(/invalid username or password/i);
      });

      it('returns 401 for a soft-deleted user', async () => {
        const { username, password } = await createTestUser(prisma, { deleted: true });

        const res = await request(app.getHttpServer())
          .post('/auth/login')
          .send({ username, password })
          .expect(401);

        expect(res.body.statusCode).toBe(401);
        // Uniform message — do not reveal that the account exists but is deleted.
        expect(res.body.message).toMatch(/invalid username or password/i);
      });

      it('does not leak a stack trace in 401 responses', async () => {
        const res = await request(app.getHttpServer())
          .post('/auth/login')
          .send({ username: 'ghost_user', password: 'IrrelevantPass1!' })
          .expect(401);

        expect(res.body.stack).toBeUndefined();
      });
    });
  });

  // =========================================================================
  // GET /auth/me
  // =========================================================================

  describe('GET /auth/me', () => {
    // -----------------------------------------------------------------------
    // Happy paths
    // -----------------------------------------------------------------------

    describe('happy path', () => {
      it('returns 200 with the current user profile for a valid JWT', async () => {
        const { id, username, password } = await createTestUser(prisma, { role: 'adjuster' });
        const token = await loginAs(app, username, password);

        const res = await request(app.getHttpServer())
          .get('/auth/me')
          .set('Authorization', `Bearer ${token}`)
          .expect(200);

        expect(res.body).toMatchObject({
          user_id: id,
          username,
          role: 'adjuster',
          is_claims_director: false,
        });
        expect(res.body.email).toBeDefined();
        expect(res.body.display_name).toBeDefined();
        expect(res.body.created_at).toBeDefined();
      });

      it('includes reports_to_id (null when not set)', async () => {
        const { username, password } = await createTestUser(prisma);
        const token = await loginAs(app, username, password);

        const res = await request(app.getHttpServer())
          .get('/auth/me')
          .set('Authorization', `Bearer ${token}`)
          .expect(200);

        expect(res.body.reports_to_id).toBeNull();
      });

      it('returns is_claims_director=true for a director-flagged manager', async () => {
        const { username, password } = await createTestUser(prisma, {
          role: 'manager',
          is_claims_director: true,
        });
        const token = await loginAs(app, username, password);

        const res = await request(app.getHttpServer())
          .get('/auth/me')
          .set('Authorization', `Bearer ${token}`)
          .expect(200);

        expect(res.body.is_claims_director).toBe(true);
      });

      it('does NOT include password_hash in the response', async () => {
        const { username, password } = await createTestUser(prisma);
        const token = await loginAs(app, username, password);

        const res = await request(app.getHttpServer())
          .get('/auth/me')
          .set('Authorization', `Bearer ${token}`)
          .expect(200);

        expect(res.body.password_hash).toBeUndefined();
      });

      it('reflects the stored role for all role types', async () => {
        const roles = ['agent', 'adjuster', 'manager', 'auditor', 'siu_referrer'] as const;

        for (const role of roles) {
          const { username, password } = await createTestUser(prisma, { role });
          const token = await loginAs(app, username, password);

          const res = await request(app.getHttpServer())
            .get('/auth/me')
            .set('Authorization', `Bearer ${token}`)
            .expect(200);

          expect(res.body.role).toBe(role);
        }
      });
    });

    // -----------------------------------------------------------------------
    // Auth-denied paths
    // -----------------------------------------------------------------------

    describe('auth-denied — 401', () => {
      it('returns 401 when Authorization header is absent', async () => {
        const res = await request(app.getHttpServer())
          .get('/auth/me')
          .expect(401);

        expect(res.body.statusCode).toBe(401);
      });

      it('returns 401 for a malformed token (not a JWT)', async () => {
        const res = await request(app.getHttpServer())
          .get('/auth/me')
          .set('Authorization', 'Bearer this.is.not.a.jwt')
          .expect(401);

        expect(res.body.statusCode).toBe(401);
      });

      it('returns 401 for a token signed with the wrong secret', async () => {
        const jwt = require('jsonwebtoken') as typeof import('jsonwebtoken');
        const badToken = jwt.sign(
          { sub: 'fake_id', username: 'nobody', role: 'adjuster', is_claims_director: false },
          'completely_wrong_secret',
          { expiresIn: 3600 },
        );

        const res = await request(app.getHttpServer())
          .get('/auth/me')
          .set('Authorization', `Bearer ${badToken}`)
          .expect(401);

        expect(res.body.statusCode).toBe(401);
      });

      it('returns 401 for an expired token', async () => {
        const jwt = require('jsonwebtoken') as typeof import('jsonwebtoken');
        const secret = process.env['JWT_SECRET'] ?? 'test_secret_for_tests_only';

        // Issue a token that expired 1 second ago.
        const expiredToken = jwt.sign(
          { sub: 'any_id', username: 'anyone', role: 'adjuster', is_claims_director: false },
          secret,
          { expiresIn: -1 },
        );

        const res = await request(app.getHttpServer())
          .get('/auth/me')
          .set('Authorization', `Bearer ${expiredToken}`)
          .expect(401);

        expect(res.body.statusCode).toBe(401);
      });

      it('returns 401 when Bearer scheme is omitted', async () => {
        const { username, password } = await createTestUser(prisma);
        const token = await loginAs(app, username, password);

        // Send the raw token without the "Bearer " prefix.
        const res = await request(app.getHttpServer())
          .get('/auth/me')
          .set('Authorization', token)
          .expect(401);

        expect(res.body.statusCode).toBe(401);
      });

      it('does not leak a stack trace in 401 responses', async () => {
        const res = await request(app.getHttpServer())
          .get('/auth/me')
          .expect(401);

        expect(res.body.stack).toBeUndefined();
      });
    });

    // -----------------------------------------------------------------------
    // 404 — account deleted between token issuance and request
    // -----------------------------------------------------------------------

    describe('account deactivated between login and /me call', () => {
      it('returns 404 when the user has been soft-deleted after token issuance', async () => {
        const { id, username, password } = await createTestUser(prisma);
        const token = await loginAs(app, username, password);

        // Soft-delete the user in the DB to simulate deactivation.
        await prisma.user.update({
          where: { id },
          data: { deleted_at: new Date() },
        });

        const res = await request(app.getHttpServer())
          .get('/auth/me')
          .set('Authorization', `Bearer ${token}`)
          .expect(404);

        expect(res.body.statusCode).toBe(404);
        expect(res.body.stack).toBeUndefined();
      });
    });
  });

  // =========================================================================
  // Response envelope consistency
  // =========================================================================

  describe('Error envelope consistency', () => {
    it('all error responses include statusCode and message fields', async () => {
      const responses = await Promise.all([
        request(app.getHttpServer()).post('/auth/login').send({}),
        request(app.getHttpServer()).post('/auth/login').send({ username: 'x', password: 'y' }),
        request(app.getHttpServer()).get('/auth/me'),
      ]);

      for (const res of responses) {
        expect(res.body.statusCode).toBeDefined();
        expect(res.body.message).toBeDefined();
        expect(res.body.stack).toBeUndefined();
      }
    });
  });
});