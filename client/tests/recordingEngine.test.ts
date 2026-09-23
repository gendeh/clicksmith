import { RecordingEngine } from '../src/main/recordingEngine';
import { RecordingConfig } from '../src/types';
import { MockInputHook } from '../src/main/inputHooks';
import { capturePatch } from '../src/main/screenCapture';
import { computeDHash, computeSha256 } from '../src/main/imageHash';

jest.mock('../src/main/screenCapture', () => ({
  capturePatch: jest.fn(),
}));

jest.mock('../src/main/imageHash', () => ({
  computeSha256: jest.fn(() => 'mock-sha256'),
  computeDHash: jest.fn(() => Promise.resolve('mock-dhash')),
}));

const mockedCapturePatch = capturePatch as jest.MockedFunction<typeof capturePatch>;
const mockedComputeSha256 = computeSha256 as jest.MockedFunction<typeof computeSha256>;
const mockedComputeDHash = computeDHash as jest.MockedFunction<typeof computeDHash>;

const flushMicrotasks = () => Promise.resolve();

describe('RecordingEngine', () => {
  let engine: RecordingEngine;
  let inputHook: MockInputHook;
  const mockConfig: RecordingConfig = {
    target: 'notepad.exe',
    captureImages: false,
    imagePatchSize: 128,
    minEventInterval: 10,
    recordKeyboard: true,
    recordMouse: true,
    stopHotkey: 'F9',
    takeoverHotkey: 'F11'
  };

  beforeEach(() => {
    mockedCapturePatch.mockResolvedValue(Buffer.from('patch'));
    mockedComputeSha256.mockReturnValue('mock-sha256');
    mockedComputeDHash.mockResolvedValue('mock-dhash');
    inputHook = new MockInputHook();
    engine = new RecordingEngine({
      inputHook,
      windowManager: { getTargetBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) } as any,
    });
  });

  afterEach(async () => {
    await engine.stop();
  });

  test('should start recording', async () => {
    const result = await engine.start(mockConfig);
    expect(result.success).toBe(true);
  });

  test('should not start if already recording', async () => {
    await engine.start(mockConfig);
    const result = await engine.start(mockConfig);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Already recording');
  });

  test('should stop recording and return profile', async () => {
    await engine.start(mockConfig);
    
    // Simulate some time passing
    await new Promise(resolve => setTimeout(resolve, 10));
    
    const result = await engine.stop();
    expect(result.success).toBe(true);
    expect(result.profile).toBeDefined();
    expect(result.profile.events).toEqual([]); // Empty because we haven't simulated events
    expect(result.profile.duration).toBeGreaterThan(0);
  });

  test('stop waits for pending image context tasks before returning the profile', async () => {
    let resolveFirstPatch!: (value: Buffer) => void;
    const firstPatch = new Promise<Buffer>(resolve => {
      resolveFirstPatch = resolve;
    });
    mockedCapturePatch
      .mockReturnValueOnce(firstPatch)
      .mockResolvedValueOnce(Buffer.from('context'));

    await engine.start({
      ...mockConfig,
      captureImages: true,
      imagePatchSize: 32,
    });

    inputHook.emit('mousedown', { x: 40, y: 70, button: 1 });
    expect(mockedCapturePatch).toHaveBeenCalledTimes(1);

    let stopSettled = false;
    const stopPromise = engine.stop().then(result => {
      stopSettled = true;
      return result;
    });

    await flushMicrotasks();
    expect(stopSettled).toBe(false);

    resolveFirstPatch(Buffer.from('patch'));
    const result = await stopPromise;

    expect(result.success).toBe(true);
    expect(stopSettled).toBe(true);
    expect(mockedCapturePatch).toHaveBeenNthCalledWith(1, 40, 70, 32);
    expect(mockedCapturePatch).toHaveBeenNthCalledWith(2, 40, 70, 96);
    expect(result.profile.events[0]).toEqual(expect.objectContaining({
      img_patch_b64: Buffer.from('patch').toString('base64'),
      img_context_b64: Buffer.from('context').toString('base64'),
      img_hash: 'mock-sha256',
      metadata: expect.objectContaining({
        img_dhash: 'mock-dhash',
        capture_scale: 1,
        capture_display_id: 1,
      }),
    }));
  });

  test('stop times out a hung image context task and keeps the profile savable', async () => {
    jest.useFakeTimers();
    try {
      mockedCapturePatch.mockReturnValueOnce(new Promise<Buffer>(() => undefined));

      await engine.start({
        ...mockConfig,
        captureImages: true,
        imagePatchSize: 32,
      });

      inputHook.emit('mousedown', { x: 40, y: 70, button: 1 });

      const stopPromise = engine.stop();
      await jest.advanceTimersByTimeAsync(2_501);
      const result = await stopPromise;

      expect(result.success).toBe(true);
      expect(result.profile.events[0].metadata).toEqual(expect.objectContaining({
        image_error: 'capture_failed',
        image_error_message: 'image_context_timeout',
      }));
    } finally {
      jest.useRealTimers();
    }
  });

  test('records the OCR label under the click when the image service is available', async () => {
    mockedCapturePatch
      .mockResolvedValueOnce(Buffer.from('patch'))
      .mockResolvedValueOnce(Buffer.from('context'));
    const ocrImage = jest.fn().mockResolvedValue({
      success: true,
      text: 'Save',
      items: [{ text: 'Save', confidence: 92, bounds: { x: 20, y: 20, width: 80, height: 40 } }],
      processingTimeMs: 12,
    });
    const ocrEngine = new RecordingEngine({
      inputHook,
      windowManager: { getTargetBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) } as any,
      imageService: { ocrImage } as any,
    });

    await ocrEngine.start({
      ...mockConfig,
      captureImages: true,
      imagePatchSize: 32,
    });
    inputHook.emit('mousedown', { x: 40, y: 70, button: 1 });
    const result = await ocrEngine.stop();

    expect(ocrImage).toHaveBeenCalledWith(expect.objectContaining({
      image: Buffer.from('context').toString('base64'),
    }));
    expect(result.profile.events[0].metadata).toEqual(expect.objectContaining({
      ocr_primary_text: 'Save',
      ocr_primary_text_normalized: 'save',
    }));
  });

  test('records the click against the live window when sync bounds are the desktop', async () => {
    const hook = new MockInputHook();
    const recorder = new RecordingEngine({
      inputHook: hook,
      windowManager: {
        getTargetBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
        getTargetBoundsAsync: async () => ({ x: 500, y: 200, width: 800, height: 600 }),
      } as any,
    });

    await recorder.start(mockConfig);
    hook.emit('mousedown', { x: 540, y: 230, button: 1 });
    const result = await recorder.stop();

    expect(result.profile.events[0].rel_x).toBeCloseTo(0.05);
    expect(result.profile.events[0].rel_y).toBeCloseTo(0.05);
  });

  test('a missing window does not record the click as the window origin', async () => {
    const hook = new MockInputHook();
    const recorder = new RecordingEngine({
      inputHook: hook,
      windowManager: {
        getTargetBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
        getTargetBoundsAsync: async () => null,
      } as any,
    });

    await recorder.start(mockConfig);
    hook.emit('mousedown', { x: 540, y: 230, button: 1 });
    const result = await recorder.stop();
    const event = result.profile.events[0];

    expect(Number.isFinite(event.rel_x)).toBe(false);
    expect(Number.isFinite(event.rel_y)).toBe(false);
    expect(event.x).toBe(540);
    expect(event.y).toBe(230);
  });

  test('a click after the window moves is stored against the new window', async () => {
    const hook = new MockInputHook();
    let bounds = { x: 500, y: 200, width: 800, height: 600 };
    const recorder = new RecordingEngine({
      inputHook: hook,
      windowManager: {
        getTargetBounds: () => bounds,
        getTargetBoundsAsync: async () => bounds,
      } as any,
    });

    await recorder.start({ ...mockConfig, minEventInterval: 0 });
    hook.emit('mousedown', { x: 540, y: 230, button: 1 });
    bounds = { x: 800, y: 100, width: 800, height: 600 };
    hook.emit('mousemove', { x: 840, y: 130 });
    for (let turn = 0; turn < 4; turn += 1) {
      await flushMicrotasks();
    }
    hook.emit('mousedown', { x: 840, y: 130, button: 1 });
    const result = await recorder.stop();
    const events = result.profile.events;

    expect(events[0].rel_x).toBeCloseTo(0.05);
    expect(events[0].rel_y).toBeCloseTo(0.05);
    expect(events[1].rel_x).toBeCloseTo(0.05);
    expect(events[1].rel_y).toBeCloseTo(0.05);
  });
});
