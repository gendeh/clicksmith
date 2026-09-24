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

  test('keeps appended clicks and keys on a takeover profile', async () => {
    const payload = {
      name: 'Minecraft wheel grab',
      target_app: 'Minecraft',
      created_at: '2026-01-01T00:00:00Z',
      events: [
        {
          t_ms: 0,
          type: 'mouse',
          btn: 'left',
          x: 0,
          y: 0,
          rel_x: 0,
          rel_y: 0,
          duration_ms: 16,
          human_override: false,
        },
        {
          t_ms: 120,
          type: 'mouse',
          btn: 'right',
          x: 0,
          y: 0,
          rel_x: 0,
          rel_y: 0,
          duration_ms: 16,
          human_override: true,
        },
        {
          t_ms: 160,
          type: 'keyboard',
          key: 'e',
          x: 0,
          y: 0,
          rel_x: 0,
          rel_y: 0,
          duration_ms: 16,
          human_override: true,
        },
      ],
      success_metric: { furthest_frame: 0, score: 0 },
      version: 1,
      notes: '',
      metadata: {
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        version: 1,
        total_duration_ms: 184,
        event_count: 3,
        override_count: 2,
        tags: ['takeover'],
        custom: { game_id: 'minecraft', takeover_start_ms: 120 },
      },
    };

    const createRes = await request(app).post('/api/v1/profiles').send(payload);
    expect(createRes.status).toBe(201);
    const got = await request(app).get(`/api/v1/profiles/${createRes.body.id}`);
    expect(got.status).toBe(200);
    expect(got.body.target_app).toBe('Minecraft');
    expect(got.body.metadata.custom.game_id).toBe('minecraft');
    expect(got.body.events.filter((event: { human_override: boolean }) => event.human_override)).toEqual([
      expect.objectContaining({ t_ms: 120, btn: 'right', human_override: true }),
      expect.objectContaining({ t_ms: 160, key: 'e', human_override: true }),
    ]);
  });
});
