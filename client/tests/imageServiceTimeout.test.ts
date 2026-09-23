import { ImageService } from '../src/services/imageService';

function hangUntilAbort(init?: RequestInit): Promise<never> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

describe('ImageService budgets', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  test('a 45ms match budget aborts at 45ms', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn((_url: unknown, init?: RequestInit) => hangUntilAbort(init)) as typeof fetch;
    const service = new ImageService('http://127.0.0.1:5001');
    let settled = false;
    const pending = service
      .matchImage({
        template: 'abc',
        searchArea: 'def',
        threshold: 0.6,
        method: 'template',
        findAll: false,
        maxMatches: 1,
        timeoutMs: 45,
      })
      .then((result) => {
        settled = true;
        return result;
      });

    await jest.advanceTimersByTimeAsync(45);
    expect(settled).toBe(true);
    await expect(pending).resolves.toMatchObject({ success: false });
  });

  test('an 80ms text budget waits for the response, then aborts', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn((_url: unknown, init?: RequestInit) => hangUntilAbort(init)) as typeof fetch;
    const service = new ImageService('http://127.0.0.1:5001');
    let settled = false;
    const pending = service.ocrImage({ image: 'abc', timeoutMs: 80 }).then((result) => {
      settled = true;
      return result;
    });

    await jest.advanceTimersByTimeAsync(80);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(40);
    expect(settled).toBe(true);
    await expect(pending).resolves.toMatchObject({ success: false });
  });

  test('a match with no budget still aborts at the default', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn((_url: unknown, init?: RequestInit) => hangUntilAbort(init)) as typeof fetch;
    const service = new ImageService('http://127.0.0.1:5001');
    let settled = false;
    const pending = service
      .matchImage({
        template: 'abc',
        searchArea: 'def',
        threshold: 0.6,
        method: 'template',
        findAll: false,
        maxMatches: 1,
      })
      .then(() => {
        settled = true;
      });

    await jest.advanceTimersByTimeAsync(120);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(330);
    expect(settled).toBe(true);
    await pending;
  });

  test('a failed match is searched again', async () => {
    let calls = 0;
    global.fetch = jest.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: false, status: 500, json: async () => ({}) } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          success: true,
          matches: [{ x: 10, y: 20, confidence: 0.91, method: 'template', scale: 1 }],
          bestMatch: { x: 10, y: 20, confidence: 0.91, method: 'template', scale: 1 },
          processingTimeMs: 4,
        }),
      } as Response;
    }) as typeof fetch;
    const service = new ImageService('http://127.0.0.1:5001');
    const request = {
      template: 'abc',
      searchArea: 'def',
      threshold: 0.6,
      method: 'template' as const,
      findAll: false,
      maxMatches: 1,
      timeoutMs: 100,
    };

    const first = await service.matchImage(request);
    const second = await service.matchImage(request);

    expect(first.success).toBe(false);
    expect(second.bestMatch).toEqual(expect.objectContaining({ x: 10, y: 20, confidence: 0.91 }));
    expect(calls).toBe(2);
  });
});
