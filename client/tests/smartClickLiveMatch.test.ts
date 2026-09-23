import { PlaybackEngine } from '../src/main/playbackEngine';
import { RecordingEngine } from '../src/main/recordingEngine';
import { ImageService } from '../src/services/imageService';
import { formatSmartClickStatsLine } from '../src/services/smartClickStats';
import * as screenCapture from '../src/main/screenCapture';
import { computeDHash } from '../src/main/imageHash';
import { MockInputHook } from '../src/main/inputHooks';

function patternPng(size: number): Promise<Buffer> {
  const sharp = require('sharp');
  const raw = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 3;
      const border = x < 4 || y < 4 || x >= size - 4 || y >= size - 4;
      const diag = Math.abs(x - (size - 1 - y)) < 3;
      const blob = (x - size / 3) ** 2 + (y - size / 3) ** 2 < (size / 7) ** 2;
      const checker = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
      raw[i] = border ? 240 : diag ? 255 : blob ? 210 : checker ? 24 : 70;
      raw[i + 1] = border ? 240 : (x * 3) % 255;
      raw[i + 2] = border ? 240 : (y * 5) % 255;
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

const liveMatch = process.env.CLICKSMITH_LIVE_MATCH === '1' ? test : test.skip;

liveMatch('a live match in a moved window clicks the patch center at 70%, 100%, and 140%', async () => {
  const imageService = new ImageService('http://127.0.0.1:5001');
  const healthy = await imageService.healthCheck(800);
  expect(healthy).toBe(true);

  const sharp = require('sharp');
  const patchSize = 128;
  const patch = await patternPng(patchSize);
  const recordedHash = await computeDHash(patch);
  const windowOrigin = { x: 500, y: 200 };
  const expected = { x: 40, y: 30 };

  for (const scale of [0.7, 1, 1.4]) {
    const scaledW = Math.round(patchSize * scale);
    const scaledH = Math.round(patchSize * scale);
    const patchOrigin = { x: 40, y: 36 };
    const scaled = scale === 1
      ? patch
      : await sharp(patch).resize(scaledW, scaledH).png().toBuffer();
    const windowPng = await sharp({
      create: {
        width: 520,
        height: 360,
        channels: 3,
        background: { r: 8, g: 8, b: 8 },
      },
    })
      .composite([{ input: scaled, left: patchOrigin.x, top: patchOrigin.y }])
      .png()
      .toBuffer();
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(windowPng);
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(windowPng);
    const localCenter = {
      x: patchOrigin.x + scaledW / 2,
      y: patchOrigin.y + scaledH / 2,
    };
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService,
      windowManager: {
        getTargetBounds: () => ({ x: windowOrigin.x, y: windowOrigin.y, width: 520, height: 360 }),
        getTargetBoundsAsync: async () => ({ x: windowOrigin.x, y: windowOrigin.y, width: 520, height: 360 }),
      } as any,
    }) as any;
    engine.config = {
      profileId: 'live',
      target: 'Terminal',
      useImageMatching: true,
      imageMatchThreshold: 0.6,
      timingTolerance: 20,
      retryCount: 1,
      retryDelay: 10,
      takeoverHotkey: 'F11',
      speedMultiplier: 1,
      useRelativeCoords: false,
      imageSearchRadius: 320,
    };
    engine.status = engine.createStatus('playing');

    const result = await engine.resolveSmartClick(
      {
        t_ms: 0,
        type: 'mouse',
        btn: 'left',
        x: expected.x,
        y: expected.y,
        rel_x: 0,
        rel_y: 0,
        duration_ms: 0,
        human_override: false,
        img_patch_b64: patch.toString('base64'),
        metadata: { img_dhash: recordedHash, recorded_match_scale: 1 },
      },
      expected
    );

    expect(result.x).toBeGreaterThanOrEqual(windowOrigin.x + localCenter.x - 8);
    expect(result.x).toBeLessThanOrEqual(windowOrigin.x + localCenter.x + 8);
    expect(result.y).toBeGreaterThanOrEqual(windowOrigin.y + localCenter.y - 8);
    expect(result.y).toBeLessThanOrEqual(windowOrigin.y + localCenter.y + 8);
    const status = engine.getStatus();
    expect(status.smartClickLastConfidence).toBeGreaterThan(0.6);
    expect(status.smartClickLastSource).toBe('window');
    expect(status.smartClickLastScale).toBeGreaterThanOrEqual(scale - 0.08);
    expect(status.smartClickLastScale).toBeLessThanOrEqual(scale + 0.08);
    expect(formatSmartClickStatsLine(status)).toContain(
      `scale ${Number(status.smartClickLastScale).toFixed(2)}`
    );
    if (scale === 1) {
      expect(status.smartClickLastDHashDistance).toBeLessThanOrEqual(8);
    }
    captureSpy.mockRestore();
    screenSpy.mockRestore();
  }
});

liveMatch('a live template miss still clicks the recorded word', async () => {
  const imageService = new ImageService('http://127.0.0.1:5001');
  const healthy = await imageService.healthCheck(800);
  expect(healthy).toBe(true);

  const sharp = require('sharp');
  const patch = await patternPng(96);
  const windowPng = await sharp(
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="520" height="360">
      <rect width="520" height="360" fill="black"/>
      <text x="48" y="140" font-size="72" font-family="Helvetica" fill="white">Submit</text>
    </svg>`)
  ).png().toBuffer();
  const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(windowPng);
  const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(windowPng);
  const windowOrigin = { x: 500, y: 200 };
  const engine = new PlaybackEngine({
    inputPlayer: {} as any,
    imageService,
    windowManager: {
      getTargetBounds: () => ({ x: windowOrigin.x, y: windowOrigin.y, width: 520, height: 360 }),
      getTargetBoundsAsync: async () => ({ x: windowOrigin.x, y: windowOrigin.y, width: 520, height: 360 }),
    } as any,
  }) as any;
  engine.config = {
    profileId: 'live-ocr',
    target: 'Terminal',
    useImageMatching: true,
    imageMatchThreshold: 0.6,
    timingTolerance: 20,
    retryCount: 0,
    retryDelay: 10,
    takeoverHotkey: 'F11',
    speedMultiplier: 1,
    useRelativeCoords: false,
    imageSearchRadius: 160,
  };
  engine.status = engine.createStatus('playing');
  const started = Date.now();
  const result = await engine.resolveSmartClick(
    {
      t_ms: 0,
      type: 'mouse',
      btn: 'left',
      x: 40,
      y: 30,
      rel_x: 0,
      rel_y: 0,
      duration_ms: 0,
      human_override: false,
      img_patch_b64: patch.toString('base64'),
      metadata: {
        ocr_primary_text_normalized: 'submit',
        ocr_anchor_norm_x: 0,
        ocr_anchor_norm_y: 0,
      },
    },
    { x: 40, y: 30 }
  );
  const elapsed = Date.now() - started;
  const status = engine.getStatus();
  expect(status.smartClickLastMethod).toBe('ocr');
  expect(status.smartClickLastSource).toBe('window');
  expect(status.smartClickLastConfidence).toBeGreaterThan(0.6);
  expect(status.smartClickLastScale).toBeUndefined();
  expect(formatSmartClickStatsLine(status)).toContain('scale n/a');
  expect(result).not.toEqual({ x: 40, y: 30 });
  expect(result.x).toBeGreaterThanOrEqual(windowOrigin.x + 40);
  expect(result.x).toBeLessThanOrEqual(windowOrigin.x + 320);
  expect(result.y).toBeGreaterThanOrEqual(windowOrigin.y + 60);
  expect(result.y).toBeLessThanOrEqual(windowOrigin.y + 180);
  expect(elapsed).toBeLessThan(1500);
  captureSpy.mockRestore();
  screenSpy.mockRestore();
});

liveMatch('a recorded word is what playback clicks after the window moves', async () => {
  const imageService = new ImageService('http://127.0.0.1:5001');
  const healthy = await imageService.healthCheck(800);
  expect(healthy).toBe(true);

  const sharp = require('sharp');
  const patch = await patternPng(128);
  const submitPng = await sharp(
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="384" height="384">
      <rect width="384" height="384" fill="black"/>
      <text x="80" y="220" font-size="72" font-family="Helvetica" fill="white">Submit</text>
    </svg>`)
  ).png().toBuffer();
  const capturePatchSpy = jest.spyOn(screenCapture, 'capturePatch').mockImplementation(async (_x, _y, size) => {
    return size <= 128 ? patch : submitPng;
  });

  const inputHook = new MockInputHook();
  const recorder = new RecordingEngine({
    inputHook,
    windowManager: {
      getTargetBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    } as any,
    imageService,
  });
  await recorder.start({
    target: 'Terminal',
    captureImages: true,
    imagePatchSize: 128,
    minEventInterval: 0,
    recordKeyboard: true,
    recordMouse: true,
    stopHotkey: 'F9',
    takeoverHotkey: 'F11',
  });
  inputHook.emit('mousedown', { x: 40, y: 70, button: 1 });
  const recorded = await recorder.stop();
  capturePatchSpy.mockRestore();
  const event = recorded.profile.events[0];
  expect(event.metadata).toEqual(expect.objectContaining({
    ocr_primary_text_normalized: 'submit',
  }));

  const windowOrigin = { x: 800, y: 100 };
  const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(submitPng);
  const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(submitPng);
  const engine = new PlaybackEngine({
    inputPlayer: {} as any,
    imageService,
    windowManager: {
      getTargetBounds: () => ({ x: windowOrigin.x, y: windowOrigin.y, width: 384, height: 384 }),
      getTargetBoundsAsync: async () => ({ x: windowOrigin.x, y: windowOrigin.y, width: 384, height: 384 }),
    } as any,
  }) as any;
  engine.config = {
    profileId: 'live-recorded-word',
    target: 'Terminal',
    useImageMatching: true,
    imageMatchThreshold: 0.6,
    timingTolerance: 20,
    retryCount: 0,
    retryDelay: 10,
    takeoverHotkey: 'F11',
    speedMultiplier: 1,
    useRelativeCoords: false,
    imageSearchRadius: 160,
  };
  engine.status = engine.createStatus('playing');
  const result = await engine.resolveSmartClick(event, { x: event.x, y: event.y });
  const status = engine.getStatus();
  expect(status.smartClickLastConfidence).toBeGreaterThan(0.6);
  expect(status.smartClickLastSource).toBe('window');
  expect(result).not.toEqual({ x: 40, y: 70 });
  expect(result.x).toBeGreaterThanOrEqual(windowOrigin.x + 40);
  expect(result.x).toBeLessThanOrEqual(windowOrigin.x + 340);
  expect(result.y).toBeGreaterThanOrEqual(windowOrigin.y + 80);
  expect(result.y).toBeLessThanOrEqual(windowOrigin.y + 280);
  captureSpy.mockRestore();
  screenSpy.mockRestore();
});

liveMatch('a screen target clicks the recorded word inside the search radius', async () => {
  const imageService = new ImageService('http://127.0.0.1:5001');
  expect(await imageService.healthCheck(800)).toBe(true);

  const sharp = require('sharp');
  const patch = await patternPng(96);
  const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockImplementation(async (region) => {
    if (region.width > 640 || region.height > 640) {
      throw new Error(`desktop capture ${region.width}x${region.height}`);
    }
    const width = Math.max(1, Math.round(region.width));
    const height = Math.max(1, Math.round(region.height));
    return sharp(
      Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
        <rect width="${width}" height="${height}" fill="black"/>
        <text x="48" y="140" font-size="72" font-family="Helvetica" fill="white">Submit</text>
      </svg>`)
    ).png().toBuffer();
  });
  const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockImplementation(async () => {
    throw new Error('full screen capture');
  });
  const engine = new PlaybackEngine({
    inputPlayer: {} as any,
    imageService,
    windowManager: { getTargetBounds: () => null, getTargetBoundsAsync: async () => null } as any,
  }) as any;
  engine.config = {
    profileId: 'live-screen-word',
    target: 'screen',
    useImageMatching: true,
    imageMatchThreshold: 0.6,
    timingTolerance: 20,
    retryCount: 0,
    retryDelay: 10,
    takeoverHotkey: 'F11',
    speedMultiplier: 1,
    useRelativeCoords: false,
    imageSearchRadius: 320,
  };
  engine.status = engine.createStatus('playing');
  const started = Date.now();
  const result = await engine.resolveSmartClick(
    {
      t_ms: 0,
      type: 'mouse',
      btn: 'left',
      x: 40,
      y: 30,
      rel_x: 0,
      rel_y: 0,
      duration_ms: 0,
      human_override: false,
      img_patch_b64: patch.toString('base64'),
      metadata: { ocr_primary_text_normalized: 'submit' },
    },
    { x: 40, y: 30 }
  );
  const elapsed = Date.now() - started;
  const status = engine.getStatus();
  const neighborhood = captureSpy.mock.calls[0][0];
  expect(captureSpy).toHaveBeenCalledTimes(1);
  expect(neighborhood.width).toBeLessThanOrEqual(640);
  expect(neighborhood.height).toBeLessThanOrEqual(640);
  expect(screenSpy).not.toHaveBeenCalled();
  expect(status.smartClickLastMethod).toBe('ocr');
  expect(status.smartClickLastSource).toBe('region');
  expect(status.smartClickLastConfidence).toBeGreaterThan(0.6);
  expect(result).not.toEqual({ x: 40, y: 30 });
  expect(result.x).toBeGreaterThanOrEqual(neighborhood.x);
  expect(result.x).toBeLessThanOrEqual(neighborhood.x + neighborhood.width);
  expect(result.y).toBeGreaterThanOrEqual(neighborhood.y);
  expect(result.y).toBeLessThanOrEqual(neighborhood.y + neighborhood.height);
  captureSpy.mockRestore();
  screenSpy.mockRestore();

  const { execFile } = require('child_process') as typeof import('child_process');
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  const file = path.join(os.tmpdir(), `sc-screen-word-${process.pid}.png`);
  const arg = `${Math.round(neighborhood.x)},${Math.round(neighborhood.y)},${Math.round(neighborhood.width)},${Math.round(neighborhood.height)}`;
  const captureStarted = Date.now();
  await new Promise<void>((resolve, reject) => {
    execFile('screencapture', ['-x', '-R', arg, file], error => {
      if (error) reject(error);
      else resolve();
    });
  });
  const captureMs = Date.now() - captureStarted;
  const native = await fs.promises.readFile(file);
  await fs.promises.unlink(file).catch(() => undefined);
  const resizeStarted = Date.now();
  const fitted = await sharp(native)
    .resize(Math.round(neighborhood.width), Math.round(neighborhood.height), { fit: 'fill' })
    .png()
    .toBuffer();
  const resizeMs = Date.now() - resizeStarted;
  const wallMs = captureMs + resizeMs + elapsed;
  expect(fitted.length).toBeLessThan(1_500_000);
  expect(native.length).toBeLessThan(7_000_000);
  if (wallMs >= 460) {
    throw new Error(
      `capture ${captureMs}ms + resize ${resizeMs}ms + match/ocr ${elapsed}ms = ${wallMs}ms click (${result.x}, ${result.y}) bytes ${native.length}`
    );
  }
}, 20000);

liveMatch('a screen target clicks a patch that moved inside the search radius', async () => {
  const { execFile } = require('child_process') as typeof import('child_process');
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  const sharp = require('sharp');
  const imageService = new ImageService('http://127.0.0.1:5001');
  expect(await imageService.healthCheck(800)).toBe(true);

  const origin = { x: 400, y: 300 };
  const size = 640;
  const patchOrigin = { x: 220, y: 180 };
  const patchSize = 96;
  const file = path.join(os.tmpdir(), `sc-screen-move-${process.pid}.png`);
  const arg = `${origin.x},${origin.y},${size},${size}`;
  const captureStarted = Date.now();
  await new Promise<void>((resolve, reject) => {
    execFile('screencapture', ['-x', '-R', arg, file], error => {
      if (error) reject(error);
      else resolve();
    });
  });
  const captureMs = Date.now() - captureStarted;
  const native = await fs.promises.readFile(file);
  await fs.promises.unlink(file).catch(() => undefined);
  const logical = await sharp(native).resize(size, size, { fit: 'fill' }).png().toBuffer();
  const patch = await sharp(logical)
    .extract({ left: patchOrigin.x, top: patchOrigin.y, width: patchSize, height: patchSize })
    .png()
    .toBuffer();
  const recordedHash = await computeDHash(patch);
  const recorded = { x: origin.x + size / 2, y: origin.y + size / 2 };
  const visual = {
    x: origin.x + patchOrigin.x + patchSize / 2,
    y: origin.y + patchOrigin.y + patchSize / 2,
  };

  const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockImplementation(async (region) => {
    if (region.width > size || region.height > size) {
      throw new Error(`desktop capture ${region.width}x${region.height}`);
    }
    return logical;
  });
  const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockImplementation(async () => {
    throw new Error('full screen capture');
  });
  const engine = new PlaybackEngine({
    inputPlayer: {} as any,
    imageService,
    windowManager: { getTargetBounds: () => null, getTargetBoundsAsync: async () => null } as any,
  }) as any;
  engine.config = {
    profileId: 'live-screen-move',
    target: 'screen',
    useImageMatching: true,
    imageMatchThreshold: 0.6,
    timingTolerance: 20,
    retryCount: 0,
    retryDelay: 10,
    takeoverHotkey: 'F11',
    speedMultiplier: 1,
    useRelativeCoords: false,
    imageSearchRadius: 320,
  };
  engine.status = engine.createStatus('playing');
  const started = Date.now();
  const result = await engine.resolveSmartClick(
    {
      t_ms: 0,
      type: 'mouse',
      btn: 'left',
      x: recorded.x,
      y: recorded.y,
      rel_x: 0,
      rel_y: 0,
      duration_ms: 0,
      human_override: false,
      img_patch_b64: patch.toString('base64'),
      metadata: { img_dhash: recordedHash, recorded_match_scale: 1 },
    },
    recorded
  );
  const elapsed = Date.now() - started;
  const status = engine.getStatus();
  expect(screenSpy).not.toHaveBeenCalled();
  captureSpy.mockRestore();
  screenSpy.mockRestore();

  expect(status.smartClickLastSource).toBe('region');
  expect(status.smartClickLastConfidence).toBeGreaterThan(0.6);
  expect(result.x).toBeGreaterThanOrEqual(visual.x - 8);
  expect(result.x).toBeLessThanOrEqual(visual.x + 8);
  expect(result.y).toBeGreaterThanOrEqual(visual.y - 8);
  expect(result.y).toBeLessThanOrEqual(visual.y + 8);
  expect(result).not.toEqual(recorded);
  if (captureMs + elapsed >= 460) {
    throw new Error(
      `capture ${captureMs}ms + match ${elapsed}ms = ${captureMs + elapsed}ms click (${result.x}, ${result.y}) recorded (${recorded.x}, ${recorded.y})`
    );
  }
}, 20000);

liveMatch('a flat patch that is not on screen is not the click', async () => {
  const { execFile } = require('child_process') as typeof import('child_process');
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  const sharp = require('sharp');
  const imageService = new ImageService('http://127.0.0.1:5001');
  expect(await imageService.healthCheck(800)).toBe(true);

  const origin = { x: 400, y: 300 };
  const size = 640;
  const file = path.join(os.tmpdir(), `sc-flat-miss-${process.pid}.png`);
  const arg = `${origin.x},${origin.y},${size},${size}`;
  await new Promise<void>((resolve, reject) => {
    execFile('screencapture', ['-x', '-R', arg, file], error => {
      if (error) reject(error);
      else resolve();
    });
  });
  const native = await fs.promises.readFile(file);
  await fs.promises.unlink(file).catch(() => undefined);
  const logical = await sharp(native).resize(size, size, { fit: 'fill' }).png().toBuffer();
  const patch = await sharp({
    create: { width: 96, height: 96, channels: 3, background: { r: 255, g: 0, b: 255 } },
  }).png().toBuffer();
  const recordedHash = await computeDHash(patch);
  const recorded = { x: origin.x + size / 2, y: origin.y + size / 2 };
  const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(logical);
  const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(logical);
  const engine = new PlaybackEngine({
    inputPlayer: {} as any,
    imageService,
    windowManager: { getTargetBounds: () => null, getTargetBoundsAsync: async () => null } as any,
  }) as any;
  engine.config = {
    profileId: 'live-flat-miss',
    target: 'screen',
    useImageMatching: true,
    imageMatchThreshold: 0.6,
    timingTolerance: 20,
    retryCount: 0,
    retryDelay: 10,
    takeoverHotkey: 'F11',
    speedMultiplier: 1,
    useRelativeCoords: false,
    imageSearchRadius: 320,
  };
  engine.status = engine.createStatus('playing');
  const result = await engine.resolveSmartClick(
    {
      t_ms: 0,
      type: 'mouse',
      btn: 'left',
      x: recorded.x,
      y: recorded.y,
      rel_x: 0,
      rel_y: 0,
      duration_ms: 0,
      human_override: false,
      img_patch_b64: patch.toString('base64'),
      metadata: { img_dhash: recordedHash, recorded_match_scale: 1 },
    },
    recorded
  );
  const status = engine.getStatus();
  captureSpy.mockRestore();
  screenSpy.mockRestore();
  expect(result).toEqual(recorded);
  expect(status.smartClickLastSource).toBe('expected_fallback');
  expect(status.successfulMatches).toBe(0);
  expect(status.smartClickLastConfidence).toBeUndefined();
}, 20000);

liveMatch('a real oversized screen capture clicks the cropped patch', async () => {
  const { execFile } = require('child_process') as typeof import('child_process');
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  const sharp = require('sharp');
  const imageService = new ImageService('http://127.0.0.1:5001');
  expect(await imageService.healthCheck(800)).toBe(true);

  const file = path.join(os.tmpdir(), `sc-live-fit-${process.pid}.png`);
  await new Promise<void>((resolve, reject) => {
    execFile('screencapture', ['-x', '-R', '20,20,1400,900', file], error => {
      if (error) reject(error);
      else resolve();
    });
  });
  const search = await fs.promises.readFile(file);
  await fs.promises.unlink(file).catch(() => undefined);
  const meta = await sharp(search).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  expect(search.length).toBeGreaterThan(900_000);
  expect(width * height).toBeGreaterThan(4_000_000);

  const probe = await sharp(search).extract({ left: 80, top: 80, width: 64, height: 64 }).png().toBuffer();
  const raw = await fetch('http://127.0.0.1:5001/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: probe.toString('base64'),
      searchArea: search.toString('base64'),
      threshold: 0.6,
      method: 'template',
      findAll: false,
      maxMatches: 1,
      minScale: 1,
      maxScale: 1,
      maxBudgetMs: 200,
    }),
  });
  expect(raw.ok).toBe(false);

  const hits: string[] = [];
  const misses: string[] = [];
  const origins: Array<[number, number]> = [
    [80, 80],
    [400, 180],
    [900, 400],
    [200, 700],
    [1400, 240],
    [1100, 860],
  ];
  for (const [left, top] of origins) {
    if (left + 96 > width || top + 96 > height) continue;
    const patch = await sharp(search).extract({ left, top, width: 96, height: 96 }).png().toBuffer();
    const result = await imageService.matchImage({
      template: patch.toString('base64'),
      searchArea: search.toString('base64'),
      threshold: 0.6,
      method: 'template',
      findAll: true,
      maxMatches: 4,
      minScale: 0.7,
      maxScale: 1.4,
      scaleHint: 1,
      maxBudgetMs: 400,
      timeoutMs: 2000,
    });
    const match = result.bestMatch;
    if (!match) {
      misses.push(`${left},${top} none ${result.error ?? ''}`);
      continue;
    }
    const dx = match.x - (left + 48);
    const dy = match.y - (top + 48);
    const line = `${left},${top} dx ${dx.toFixed(1)} dy ${dy.toFixed(1)} conf ${match.confidence.toFixed(3)}`;
    if (match.confidence > 0.6 && Math.hypot(dx, dy) <= 8) hits.push(line);
    else misses.push(line);
  }

  if (hits.length === 0) {
    throw new Error(misses.join('; ') || 'no tiles were matched');
  }
  expect(hits.length).toBeGreaterThan(0);
}, 30000);
