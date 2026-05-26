import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { ReservesModule } from '../src/reserves/reserves.module';

describe('ReservesController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ReservesModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Standard Reserves Flow', () => {
    let reserveId: string;

    it('POST /reserves - should propose a new reserve', async () => {
      const payload = {
        claimId: 'claim-123',
        amount: 5000,
        currency: 'USD',
        justification: 'Initial estimate for bodily injury',
        proposedBy: 'user-1',
      };

      const response = await request(app.getHttpServer())
        .post('/reserves')
        .send(payload)
        .expect(201);

      expect(response.body).toHaveProperty('id');
      expect(response.body.claimId).toBe(payload.claimId);
      expect(response.body.amount).toBe(payload.amount);
      expect(response.body.currency).toBe(payload.currency);
      expect(response.body.status).toBe('PROPOSED');
      
      reserveId = response.body.id;
    });

    it('POST /reserves - should fail if amount is <= 0', async () => {
      const payload = {
        claimId: 'claim-123',
        amount: -100,
        currency: 'USD',
        justification: 'Invalid amount',
        proposedBy: 'user-1',
      };

      await request(app.getHttpServer())
        .post('/reserves')
        .send(payload)
        .expect(400);
    });

    it('GET /reserves - should retrieve all reserves', async () => {
      const response = await request(app.getHttpServer())
        .get('/reserves')
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThanOrEqual(1);
      const found = response.body.find((r: any) => r.id === reserveId);
      expect(found).toBeDefined();
    });

    it('GET /reserves/:id - should retrieve reserve by ID', async () => {
      const response = await request(app.getHttpServer())
        .get(`/reserves/${reserveId}`)
        .expect(200);

      expect(response.body.id).toBe(reserveId);
    });

    it('GET /reserves/:id - should return 404 for non-existent ID', async () => {
      await request(app.getHttpServer())
        .get('/reserves/non-existent-id')
        .expect(404);
    });

    it('POST /reserves/:id/approve - should approve a proposed reserve', async () => {
      const response = await request(app.getHttpServer())
        .post(`/reserves/${reserveId}/approve`)
        .send({ approvedBy: 'manager-1' })
        .expect(201);

      expect(response.body.status).toBe('APPROVED');
      expect(response.body.approvedBy).toBe('manager-1');
      expect(response.body).toHaveProperty('approvedAt');
    });

    it('POST /reserves/:id/approve - should fail to approve an already approved reserve', async () => {
      await request(app.getHttpServer())
        .post(`/reserves/${reserveId}/approve`)
        .send({ approvedBy: 'manager-2' })
        .expect(400);
    });

    it('POST /reserves/:id/reject - should fail to reject an already approved reserve', async () => {
      await request(app.getHttpServer())
        .post(`/reserves/${reserveId}/reject`)
        .send({ rejectedBy: 'manager-2', reason: 'Too high' })
        .expect(400);
    });
  });

  describe('Standard Reserves Rejection Flow', () => {
    let reserveId: string;

    it('POST /reserves - should propose another reserve', async () => {
      const payload = {
        claimId: 'claim-456',
        amount: 10000,
        currency: 'EUR',
        justification: 'Property damage',
        proposedBy: 'user-2',
      };

      const response = await request(app.getHttpServer())
        .post('/reserves')
        .send(payload)
        .expect(201);

      reserveId = response.body.id;
    });

    it('POST /reserves/:id/reject - should reject a proposed reserve', async () => {
      const response = await request(app.getHttpServer())
        .post(`/reserves/${reserveId}/reject`)
        .send({ rejectedBy: 'manager-1', reason: 'Insufficient documentation' })
        .expect(201);

      expect(response.body.status).toBe('REJECTED');
      expect(response.body.rejectedBy).toBe('manager-1');
      expect(response.body.rejectionReason).toBe('Insufficient documentation');
      expect(response.body).toHaveProperty('rejectedAt');
    });
  });

  describe('JFSA Reserves Flow', () => {
    let jfsaReserveId: string;

    it('POST /reserves/jfsa - should propose a JFSA reserve', async () => {
      const payload = {
        claimId: 'claim-jfsa-1',
        amount: 15000,
        currency: 'JPY',
        justification: 'JFSA compliance reserve',
        proposedBy: 'compliance-officer',
      };

      const response = await request(app.getHttpServer())
        .post('/reserves/jfsa')
        .send(payload)
        .expect(201);

      expect(response.body).toHaveProperty('id');
      expect(response.body.claimId).toBe(payload.claimId);
      expect(response.body.status).toBe('PROPOSED');
      jfsaReserveId = response.body.id;
    });

    it('GET /reserves/jfsa - should retrieve all JFSA reserves', async () => {
      const response = await request(app.getHttpServer())
        .get('/reserves/jfsa')
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThanOrEqual(1);
    });

    it('GET /reserves/jfsa/:id - should retrieve JFSA reserve by ID', async () => {
      const response = await request(app.getHttpServer())
        .get(`/reserves/jfsa/${jfsaReserveId}`)
        .expect(200);

      expect(response.body.id).toBe(jfsaReserveId);
    });

    it('POST /reserves/jfsa/:id/approve - should approve JFSA reserve', async () => {
      const response = await request(app.getHttpServer())
        .post(`/reserves/jfsa/${jfsaReserveId}/approve`)
        .send({ approvedBy: 'jfsa-auditor' })
        .expect(201);

      expect(response.body.status).toBe('APPROVED');
      expect(response.body.approvedBy).toBe('jfsa-auditor');
    });
  });

  describe('Export Endpoints', () => {
    it('GET /reserves/export/csv - should return CSV content', async () => {
      const response = await request(app.getHttpServer())
        .get('/reserves/export/csv')
        .expect(200);

      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.headers['content-disposition']).toContain('attachment; filename=reserves.csv');
      expect(typeof response.text).toBe('string');
    });

    it('GET /reserves/export/json - should return JSON content', async () => {
      const response = await request(app.getHttpServer())
        .get('/reserves/export/json')
        .expect(200);

      expect(response.headers['content-type']).toContain('application/json');
      expect(response.headers['content-disposition']).toContain('attachment; filename=reserves.json');
    });
  });
});