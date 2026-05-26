import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Claims FNOL (e2e)', () => {
  let app: INestApplication;

  const mockClaims = [
    {
      id: 'claim-1',
      policyNumber: 'POL-12345',
      incidentDate: '2023-10-01T10:00:00.000Z',
      description: 'Car accident on Highway 1',
      claimantName: 'John Doe',
      claimantEmail: 'john.doe@example.com',
      lossType: 'AUTO',
      status: 'SUBMITTED',
      createdAt: '2023-10-01T12:00:00.000Z',
      updatedAt: '2023-10-01T12:00:00.000Z',
    },
  ];

  const mockPrismaService = {
    claim: {
      create: jest.fn().mockImplementation((args) => {
        const data = args.data;
        return Promise.resolve({
          id: 'claim-new',
          ...data,
          status: data.status || 'SUBMITTED',
          createdAt: new Date('2023-10-02T00:00:00.000Z').toISOString(),
          updatedAt: new Date('2023-10-02T00:00:00.000Z').toISOString(),
        });
      }),
      findMany: jest.fn().mockImplementation(() => {
        return Promise.resolve(mockClaims);
      }),
      findUnique: jest.fn().mockImplementation((args) => {
        const id = args.where.id;
        const claim = mockClaims.find((c) => c.id === id);
        return Promise.resolve(claim || null);
      }),
      update: jest.fn().mockImplementation((args) => {
        const id = args.where.id;
        const data = args.data;
        const claim = mockClaims.find((c) => c.id === id);
        if (!claim) {
          return Promise.resolve(null);
        }
        return Promise.resolve({
          ...claim,
          ...data,
          updatedAt: new Date('2023-10-02T01:00:00.000Z').toISOString(),
        });
      }),
    },
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(mockPrismaService)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('FNOL Submission - POST /claims', () => {
    it('should successfully submit a new claim (FNOL)', () => {
      const newClaimPayload = {
        policyNumber: 'POL-99999',
        incidentDate: '2023-10-02T00:00:00.000Z',
        description: 'Water damage in kitchen',
        claimantName: 'Jane Smith',
        claimantEmail: 'jane.smith@example.com',
        lossType: 'HOME',
      };

      return request(app.getHttpServer())
        .post('/claims')
        .send(newClaimPayload)
        .expect(201)
        .expect((res) => {
          expect(res.body).toHaveProperty('id', 'claim-new');
          expect(res.body.policyNumber).toBe(newClaimPayload.policyNumber);
          expect(res.body.claimantName).toBe(newClaimPayload.claimantName);
          expect(res.body.status).toBe('SUBMITTED');
        });
    });

    it('should fail to submit claim with missing required fields', () => {
      const invalidPayload = {
        policyNumber: 'POL-99999',
      };

      return request(app.getHttpServer())
        .post('/claims')
        .send(invalidPayload)
        .expect(400);
    });

    it('should fail to submit claim with invalid email format', () => {
      const invalidPayload = {
        policyNumber: 'POL-99999',
        incidentDate: '2023-10-02T00:00:00.000Z',
        description: 'Water damage in kitchen',
        claimantName: 'Jane Smith',
        claimantEmail: 'invalid-email',
        lossType: 'HOME',
      };

      return request(app.getHttpServer())
        .post('/claims')
        .send(invalidPayload)
        .expect(400);
    });
  });

  describe('Retrieve Claims - GET /claims', () => {
    it('should return a list of claims', () => {
      return request(app.getHttpServer())
        .get('/claims')
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body)).toBe(true);
          expect(res.body.length).toBeGreaterThan(0);
          expect(res.body[0]).toHaveProperty('id', 'claim-1');
        });
    });

    it('should return a specific claim by ID', () => {
      return request(app.getHttpServer())
        .get('/claims/claim-1')
        .expect(200)
        .expect((res) => {
          expect(res.body).toHaveProperty('id', 'claim-1');
          expect(res.body.policyNumber).toBe('POL-12345');
        });
    });

    it('should return 404 for a non-existent claim ID', () => {
      return request(app.getHttpServer())
        .get('/claims/non-existent-id')
        .expect(404);
    });
  });

  describe('Update Claim - PATCH /claims/:id', () => {
    it('should successfully update claim status or details', () => {
      const updatePayload = {
        status: 'UNDER_REVIEW',
        description: 'Updated description of car accident',
      };

      return request(app.getHttpServer())
        .patch('/claims/claim-1')
        .send(updatePayload)
        .expect(200)
        .expect((res) => {
          expect(res.body).toHaveProperty('id', 'claim-1');
          expect(res.body.status).toBe('UNDER_REVIEW');
          expect(res.body.description).toBe('Updated description of car accident');
        });
    });

    it('should return 404 when updating a non-existent claim', () => {
      const updatePayload = {
        status: 'UNDER_REVIEW',
      };

      return request(app.getHttpServer())
        .patch('/claims/non-existent-id')
        .send(updatePayload)
        .expect(404);
    });
  });
});