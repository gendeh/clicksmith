import request from 'supertest';
import app from '../src/app';

describe('Profile API', () => {
  test('creates and lists profiles', async () => {
    const payload = {
      name: 'Test Profile',
      target_app: 'synthetic',
      created_at: new Date().toISOString(),
      events: [],
      success_metric: { furthest_frame: 0, score: 0 },
      version: 1,
      notes: '',
    };

    const createRes = await request(app).post('/api/v1/profiles').send(payload);
    expect(createRes.status).toBe(201);
    expect(createRes.body.id).toBeDefined();

    const listRes = await request(app).get('/api/v1/profiles');
    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body)).toBe(true);
  });
});
