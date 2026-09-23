import crypto from 'crypto';
import sharp from 'sharp';
import { ImageService } from '../src/services/imageService';

async function png(width: number, height: number, noisy: boolean): Promise<string> {
  const raw = noisy ? crypto.randomBytes(width * height * 3) : Buffer.alloc(width * height * 3, 40);
  const encoded = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
  return encoded.toString('base64');
}

function postedImage(body: string | undefined, field: 'searchArea' | 'image'): string {
  const payload = JSON.parse(String(body)) as { searchArea?: string; image?: string };
  const value = payload[field];
  if (!value) throw new Error(`missing ${field}`);
  return value;
}

describe('large window captures still match in the original image', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('a photo-sized window is sent under the service cap and the click stays on the original center', async () => {
    const search = await png(1200, 800, true);
    const template = await png(32, 32, false);
    let postedWidth = 0;
    let postedHeight = 0;
    global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
      const image = postedImage(typeof init?.body === 'string' ? init.body : undefined, 'searchArea');
      const meta = await sharp(Buffer.from(image, 'base64')).metadata();
      postedWidth = meta.width ?? 0;
      postedHeight = meta.height ?? 0;
      const match = {
        x: postedWidth / 2,
        y: postedHeight / 2,
        confidence: 0.91,
        bounds: { x: 1, y: 2, width: 8, height: 9 },
      };
      return {
        ok: true,
        json: async () => ({
          success: true,
          matches: [match],
          bestMatch: match,
          processingTimeMs: 4,
        }),
      } as Response;
    }) as typeof fetch;

    const result = await new ImageService('http://127.0.0.1:5001').matchImage({
      template,
      searchArea: search,
      threshold: 0.6,
      method: 'template',
      findAll: false,
      maxMatches: 1,
      timeoutMs: 260,
    });

    expect(postedWidth).toBeGreaterThan(0);
    expect(postedWidth).toBeLessThan(1200);
    expect(postedWidth * postedHeight).toBeLessThanOrEqual(4_000_000);
    expect(result.bestMatch?.x).toBeCloseTo(600, 0);
    expect(result.bestMatch?.y).toBeCloseTo(400, 0);
    expect(result.bestMatch?.bounds.x).toBeGreaterThan(1);
  });

  test('a large text window keeps the word box in the original capture', async () => {
    const image = await png(2200, 1000, false);
    let postedWidth = 0;
    global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
      const posted = postedImage(typeof init?.body === 'string' ? init.body : undefined, 'image');
      const meta = await sharp(Buffer.from(posted, 'base64')).metadata();
      postedWidth = meta.width ?? 0;
      return {
        ok: true,
        json: async () => ({
          success: true,
          text: 'Submit',
          items: [{ text: 'Submit', confidence: 90, bounds: { x: 10, y: 20, width: 30, height: 40 } }],
          processingTimeMs: 12,
        }),
      } as Response;
    }) as typeof fetch;

    const result = await new ImageService('http://127.0.0.1:5001').ocrImage({ image, timeoutMs: 900 });
    const scale = 2200 / postedWidth;

    expect(postedWidth).toBeLessThan(2200);
    expect(postedWidth * (postedWidth * (1000 / 2200))).toBeLessThanOrEqual(1_900_000);
    expect(result.items[0].bounds.x).toBeCloseTo(10 * scale, 0);
    expect(result.items[0].bounds.y).toBeCloseTo(20 * scale, 0);
    expect(result.items[0].bounds.width).toBeCloseTo(30 * scale, 0);
    expect(result.items[0].bounds.height).toBeCloseTo(40 * scale, 0);
  });

  test('a small patch is sent at its recorded size', async () => {
    const search = await png(96, 64, false);
    let postedWidth = 0;
    global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
      const image = postedImage(typeof init?.body === 'string' ? init.body : undefined, 'searchArea');
      postedWidth = (await sharp(Buffer.from(image, 'base64')).metadata()).width ?? 0;
      const match = {
        x: 10,
        y: 12,
        confidence: 0.99,
        bounds: { x: 0, y: 0, width: 4, height: 4 },
      };
      return {
        ok: true,
        json: async () => ({ success: true, matches: [match], bestMatch: match, processingTimeMs: 1 }),
      } as Response;
    }) as typeof fetch;

    const result = await new ImageService('http://127.0.0.1:5001').matchImage({
      template: await png(16, 16, false),
      searchArea: search,
      threshold: 0.6,
      method: 'template',
      findAll: false,
      maxMatches: 1,
    });

    expect(postedWidth).toBe(96);
    expect(result.bestMatch?.x).toBe(10);
    expect(result.bestMatch?.y).toBe(12);
  });
});
