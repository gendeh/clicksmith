import * as profileController from '../src/controllers/profileController';
import { mockDb } from '../src/store/mockDb';

function createMockRes() {
  const res: any = {};
  res.statusCode = 200;
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload: unknown) => {
    res.body = payload;
    return res;
  };
  res.send = (payload?: unknown) => {
    res.body = payload;
    return res;
  };
  return res;
}

describe('Profile controller', () => {
  beforeEach(() => {
    mockDb.clear();
  });

  test('creates and lists profiles for owner', async () => {
    const createReq: any = {
      authUser: { uid: 'user-a' },
      body: {
        id: 'p1',
        name: 'Test Profile',
        target_app: 'synthetic',
        created_at: new Date().toISOString(),
        events: [],
        success_metric: { furthest_frame: 0, score: 0 },
        version: 1,
        notes: '',
      },
    };
    const createRes = createMockRes();
    await profileController.createProfile(createReq, createRes);
    expect(createRes.statusCode).toBe(201);

    const listReq: any = { authUser: { uid: 'user-a' } };
    const listRes = createMockRes();
    await profileController.listProfiles(listReq, listRes);
    expect(listRes.statusCode).toBe(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    expect(listRes.body).toHaveLength(1);
  });

  test('rejects ownership mutation on get/update/delete', async () => {
    const createReq: any = {
      authUser: { uid: 'owner' },
      body: {
        id: 'owned-profile',
        name: 'Owned',
        target_app: 'synthetic',
        created_at: new Date().toISOString(),
        events: [],
        success_metric: { furthest_frame: 0, score: 0 },
        version: 1,
        notes: '',
      },
    };
    await profileController.createProfile(createReq, createMockRes());

    const forbiddenGetReq: any = { authUser: { uid: 'other' }, params: { id: 'owned-profile' } };
    const forbiddenGetRes = createMockRes();
    await profileController.getProfile(forbiddenGetReq, forbiddenGetRes);
    expect(forbiddenGetRes.statusCode).toBe(403);

    const forbiddenUpdateReq: any = {
      authUser: { uid: 'other' },
      params: { id: 'owned-profile' },
      body: { notes: 'mutate attempt' },
    };
    const forbiddenUpdateRes = createMockRes();
    await profileController.updateProfile(forbiddenUpdateReq, forbiddenUpdateRes);
    expect(forbiddenUpdateRes.statusCode).toBe(403);

    const forbiddenDeleteReq: any = { authUser: { uid: 'other' }, params: { id: 'owned-profile' } };
    const forbiddenDeleteRes = createMockRes();
    await profileController.deleteProfile(forbiddenDeleteReq, forbiddenDeleteRes);
    expect(forbiddenDeleteRes.statusCode).toBe(403);
  });
});
