import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { AuthService } from '../src/auth/auth.service';
import { UserRole } from '@prisma/client';

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authService: AuthService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    authService = moduleFixture.get<AuthService>(AuthService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Clean up users before each test
    await prisma.user.deleteMany({});
  });

  describe('POST /auth/login', () => {
    it('should return access_token and role on valid credentials', async () => {
      // Arrange: create a test user
      const passwordHash = await authService.hashPassword('test-password-123');
      await prisma.user.create({
        data: {
          username: 'adjuster-001',
          password_hash: passwordHash,
          role: UserRole.adjuster,
          display_name: 'Test Adjuster',
          email: 'adjuster@example.com',
          is_claims_director: false,
        },
      });

      // Act
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: 'adjuster-001',
          password: 'test-password-123',
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('access_token');
      expect(response.body).toHaveProperty('role');
      expect(response.body.role).toBe(UserRole.adjuster);
      expect(typeof response.body.access_token).toBe('string');
      expect(response.body.access_token.length).toBeGreaterThan(0);
    });

    it('should return 401 when user does not exist', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: 'nonexistent-user',
          password: 'any-password',
        });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('Invalid username or password');
    });

    it('should return 401 when password is incorrect', async () => {
      // Arrange: create a test user
      const passwordHash = await authService.hashPassword('correct-password');
      await prisma.user.create({
        data: {
          username: 'manager-001',
          password_hash: passwordHash,
          role: UserRole.manager,
          display_name: 'Test Manager',
          email: 'manager@example.com',
          is_claims_director: false,
        },
      });

      // Act
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: 'manager-001',
          password: 'wrong-password',
        });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('Invalid username or password');
    });

    it('should reject missing username', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          password: 'some-password',
        });

      // Assert
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('message');
    });

    it('should reject missing password', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: 'some-user',
        });

      // Assert
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('message');
    });

    it('should return correct role for auditor', async () => {
      // Arrange: create an auditor user
      const passwordHash = await authService.hashPassword('auditor-pass');
      await prisma.user.create({
        data: {
          username: 'auditor-001',
          password_hash: passwordHash,
          role: UserRole.auditor,
          display_name: 'Test Auditor',
          email: 'auditor@example.com',
          is_claims_director: false,
        },
      });

      // Act
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: 'auditor-001',
          password: 'auditor-pass',
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.role).toBe(UserRole.auditor);
    });

    it('should return correct role for agent', async () => {
      // Arrange: create an agent user
      const passwordHash = await authService.hashPassword('agent-pass');
      await prisma.user.create({
        data: {
          username: 'agent-001',
          password_hash: passwordHash,
          role: UserRole.agent,
          display_name: 'Test Agent',
          email: 'agent@example.com',
          is_claims_director: false,
        },
      });

      // Act
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: 'agent-001',
          password: 'agent-pass',
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.role).toBe(UserRole.agent);
    });
  });

  describe('GET /auth/me', () => {
    let validToken: string;
    let userId: string;

    beforeEach(async () => {
      // Create a test user and obtain a valid token
      const passwordHash = await authService.hashPassword('test-password');
      const user = await prisma.user.create({
        data: {
          username: 'test-user-me',
          password_hash: passwordHash,
          role: UserRole.adjuster,
          display_name: 'Test User Me',
          email: 'testme@example.com',
          is_claims_director: false,
        },
      });
      userId = user.id;

      const loginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: 'test-user-me',
          password: 'test-password',
        });

      validToken = loginResponse.body.access_token;
    });

    it('should return current user when JWT is valid', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${validToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('username');
      expect(response.body).toHaveProperty('display_name');
      expect(response.body).toHaveProperty('email');
      expect(response.body).toHaveProperty('role');
      expect(response.body).toHaveProperty('is_claims_director');
      expect(response.body).toHaveProperty('created_at');
      expect(response.body.id).toBe(userId);
      expect(response.body.username).toBe('test-user-me');
      expect(response.body.role).toBe(UserRole.adjuster);
      expect(response.body.is_claims_director).toBe(false);
    });

    it('should not return password_hash in response', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${validToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).not.toHaveProperty('password_hash');
    });

    it('should return 401 when JWT is missing', async () => {
      // Act
      const response = await request(app.getHttpServer()).get('/auth/me');

      // Assert
      expect(response.status).toBe(401);
    });

    it('should return 401 when JWT is invalid', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', 'Bearer invalid-token-xyz');

      // Assert
      expect(response.status).toBe(401);
    });

    it('should return 401 when JWT is malformed', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', 'Bearer');

      // Assert
      expect(response.status).toBe(401);
    });

    it('should return correct user data for claims_director', async () => {
      // Arrange: create a claims director user
      const directorPasswordHash = await authService.hashPassword('director-pass');
      const directorUser = await prisma.user.create({
        data: {
          username: 'director-001',
          password_hash: directorPasswordHash,
          role: UserRole.manager,
          display_name: 'Claims Director',
          email: 'director@example.com',
          is_claims_director: true,
        },
      });

      const directorLoginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: 'director-001',
          password: 'director-pass',
        });

      const directorToken = directorLoginResponse.body.access_token;

      // Act
      const response = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${directorToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.id).toBe(directorUser.id);
      expect(response.body.is_claims_director).toBe(true);
      expect(response.body.role).toBe(UserRole.manager);
    });
  });

  describe('Auth integration scenarios', () => {
    it('should allow login, retrieve user, and verify role consistency', async () => {
      // Arrange: create a manager user
      const passwordHash = await authService.hashPassword('manager-password');
      const user = await prisma.user.create({
        data: {
          username: 'manager-integration',
          password_hash: passwordHash,
          role: UserRole.manager,
          display_name: 'Integration Manager',
          email: 'integration@example.com',
          is_claims_director: false,
        },
      });

      // Act: login
      const loginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: 'manager-integration',
          password: 'manager-password',
        });

      expect(loginResponse.status).toBe(200);
      const token = loginResponse.body.access_token;
      const loginRole = loginResponse.body.role;

      // Act: get current user
      const meResponse = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`);

      // Assert: role consistency
      expect(meResponse.status).toBe(200);
      expect(meResponse.body.role).toBe(loginRole);
      expect(meResponse.body.role).toBe(UserRole.manager);
      expect(meResponse.body.id).toBe(user.id);
    });

    it('should handle multiple users with different roles independently', async () => {
      // Arrange: create two users with different roles
      const adjusterHash = await authService.hashPassword('adjuster-pwd');
      const auditorHash = await authService.hashPassword('auditor-pwd');

      const adjuster = await prisma.user.create({
        data: {
          username: 'adjuster-multi',
          password_hash: adjusterHash,
          role: UserRole.adjuster,
          display_name: 'Multi Adjuster',
          email: 'multi-adj@example.com',
          is_claims_director: false,
        },
      });

      const auditor = await prisma.user.create({
        data: {
          username: 'auditor-multi',
          password_hash: auditorHash,
          role: UserRole.auditor,
          display_name: 'Multi Auditor',
          email: 'multi-aud@example.com',
          is_claims_director: false,
        },
      });

      // Act: login as adjuster
      const adjusterLoginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: 'adjuster-multi',
          password: 'adjuster-pwd',
        });

      // Act: login as auditor
      const auditorLoginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: 'auditor-multi',
          password: 'auditor-pwd',
        });

      // Assert: both logins succeed with correct roles
      expect(adjusterLoginResponse.status).toBe(200);
      expect(adjusterLoginResponse.body.role).toBe(UserRole.adjuster);
      expect(auditorLoginResponse.status).toBe(200);
      expect(auditorLoginResponse.body.role).toBe(UserRole.auditor);

      // Act: verify each user's /auth/me returns correct data
      const adjusterMeResponse = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${adjusterLoginResponse.body.access_token}`);

      const auditorMeResponse = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${auditorLoginResponse.body.access_token}`);

      // Assert: each user sees their own data
      expect(adjusterMeResponse.body.id).toBe(adjuster.id);
      expect(adjusterMeResponse.body.role).toBe(UserRole.adjuster);
      expect(auditorMeResponse.body.id).toBe(auditor.id);
      expect(auditorMeResponse.body.role).toBe(UserRole.auditor);
    });
  });
});