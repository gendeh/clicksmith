import * as billingController from '../src/controllers/billingController';

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

describe('Billing controller', () => {
  test('creates checkout session in mock mode', async () => {
    const req: any = {
      authUser: { uid: 'mock-user' },
      body: { priceId: 'price_pro_monthly', customerEmail: 'test@example.com' },
    };
    const res = createMockRes();
    await billingController.createCheckoutSession(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.url).toBeDefined();
  });
});
