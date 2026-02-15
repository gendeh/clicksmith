import { authenticateRequest } from '../src/middleware/auth';
import {
  validateCheckoutBody,
  validateLoginBody,
  validateProfileCreateBody,
  validateSignupBody,
} from '../src/validation/schemas';

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
  return res;
}

describe('Security smoke checks', () => {
  beforeAll(() => {
    process.env.ALLOW_INSECURE_DEV_AUTH = 'true';
  });

  test('auth middleware rejects missing bearer token', async () => {
    const req: any = { headers: {} };
    const res = createMockRes();
    const next = jest.fn();

    await authenticateRequest(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('auth middleware rejects invalid bearer format in mock mode', async () => {
    const req: any = { headers: { authorization: 'Bearer invalid-token' } };
    const res = createMockRes();
    const next = jest.fn();

    await authenticateRequest(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('schema validators reject malformed payloads', () => {
    expect(validateSignupBody({ email: 42, password: null }).ok).toBe(false);
    expect(validateLoginBody({ email: null }).ok).toBe(false);
    expect(validateCheckoutBody({ priceId: 55 }).ok).toBe(false);
    expect(
      validateProfileCreateBody({
        name: 'x',
        target_app: 'x',
        created_at: '2020-01-01T00:00:00Z',
        events: [{ t_ms: 'oops' }],
        success_metric: { furthest_frame: 0, score: 0 },
        version: 1,
        notes: '',
      }).ok
    ).toBe(false);
  });
});
