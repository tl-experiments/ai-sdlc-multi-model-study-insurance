import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppiModule } from '../src/appi/appi.module';

describe('AppiController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppiModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  let createdRequestId: string;

  it('POST /appi (propose anonymisation)', async () => {
    const payload = {
      claimId: 'claim-123',
      requestedBy: 'user-1',
      reason: 'GDPR request',
      fields: ['name', 'email'],
    };

    const response = await request(app.getHttpServer())
      .post('/appi')
      .send(payload)
      .expect(201);

    expect(response.body).toHaveProperty('id');
    expect(response.body.claimId).toBe(payload.claimId);
    expect(response.body.requestedBy).toBe(payload.requestedBy);
    expect(response.body.reason).toBe(payload.reason);
    expect(response.body.fields).toEqual(payload.fields);
    expect(response.body.status).toBe('PENDING');
    expect(response.body).toHaveProperty('createdAt');

    createdRequestId = response.body.id;
  });

  it('POST /appi validation error', async () => {
    const payload = {
      claimId: '',
      requestedBy: 'user-1',
    };

    await request(app.getHttpServer())
      .post('/appi')
      .send(payload)
      .expect(400);
  });

  it('GET /appi (get all requests)', async () => {
    const response = await request(app.getHttpServer())
      .get('/appi')
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThanOrEqual(1);
    const found = response.body.find((r: any) => r.id === createdRequestId);
    expect(found).toBeDefined();
  });

  it('GET /appi/:id (get request by ID)', async () => {
    const response = await request(app.getHttpServer())
      .get(`/appi/${createdRequestId}`)
      .expect(200);

    expect(response.body.id).toBe(createdRequestId);
  });

  it('GET /appi/:id (not found)', async () => {
    await request(app.getHttpServer())
      .get('/appi/non-existent-id')
      .expect(404);
  });

  it('POST /appi/:id/approve (approve request)', async () => {
    const response = await request(app.getHttpServer())
      .post(`/appi/${createdRequestId}/approve`)
      .send({ approvedBy: 'admin-1' })
      .expect(201);

    expect(response.body.status).toBe('APPROVED');
    expect(response.body.approvedBy).toBe('admin-1');
    expect(response.body).toHaveProperty('approvedAt');
  });

  it('POST /appi/:id/approve (already approved - bad request)', async () => {
    await request(app.getHttpServer())
      .post(`/appi/${createdRequestId}/approve`)
      .send({ approvedBy: 'admin-2' })
      .expect(400);
  });

  it('POST /appi/:id/reject (already approved - bad request)', async () => {
    await request(app.getHttpServer())
      .post(`/appi/${createdRequestId}/reject`)
      .send({ rejectedBy: 'admin-2', reason: 'too late' })
      .expect(400);
  });

  it('reject flow with new request', async () => {
    const payload = {
      claimId: 'claim-456',
      requestedBy: 'user-2',
    };

    const proposeRes = await request(app.getHttpServer())
      .post('/appi')
      .send(payload)
      .expect(201);

    const newId = proposeRes.body.id;

    const rejectRes = await request(app.getHttpServer())
      .post(`/appi/${newId}/reject`)
      .send({ rejectedBy: 'admin-1', reason: 'invalid claim' })
      .expect(201);

    expect(rejectRes.body.status).toBe('REJECTED');
    expect(rejectRes.body.rejectedBy).toBe('admin-1');
    expect(rejectRes.body.rejectionReason).toBe('invalid claim');
    expect(rejectRes.body).toHaveProperty('rejectedAt');
  });
});