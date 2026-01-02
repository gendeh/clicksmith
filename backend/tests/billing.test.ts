import request from 'supertest';
import app from '../src/app';

describe('Billing API', () => {
  test('creates checkout session (mock)', async () => {
    const res = await request(app)
      .post('/api/v1/billing/checkout')
      .send({ priceId: 'price_pro_monthly', customerEmail: 'test@example.com', uid: 'mock-user' });

    expect(res.status).toBe(200);
    expect(res.body.url).toBeDefined();
  });
});
