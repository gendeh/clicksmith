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

liveMatch('a painted patch is not clicked at a modest lookalike', async () => {
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
  const file = path.join(os.tmpdir(), `sc-painted-${process.pid}.png`);
  await new Promise<void>((resolve, reject) => {
    execFile('screencapture', ['-x', '-R', `${origin.x},${origin.y},${size},${size}`, file], error => {
      if (error) reject(error);
      else resolve();
    });
  });
  const native = await fs.promises.readFile(file);
  await fs.promises.unlink(file).catch(() => undefined);
  const logical = await sharp(native).resize(size, size, { fit: 'fill' }).png().toBuffer();
  const patch = await sharp(logical)
    .extract({ left: patchOrigin.x, top: patchOrigin.y, width: patchSize, height: patchSize })
    .png()
    .toBuffer();
  const paint = await sharp({
    create: { width: patchSize, height: patchSize, channels: 3, background: { r: 220, g: 30, b: 30 } },
  }).png().toBuffer();
  const painted = await sharp(logical)
    .composite([{ input: paint, left: patchOrigin.x, top: patchOrigin.y }])
    .png()
    .toBuffer();
  const recordedHash = await computeDHash(patch);
  const recorded = { x: origin.x + size / 2, y: origin.y + size / 2 };
  const trueCenter = {
    x: patchOrigin.x + patchSize / 2,
    y: patchOrigin.y + patchSize / 2,
  };
  const direct = await imageService.matchImage({
    template: patch.toString('base64'),
    searchArea: painted.toString('base64'),
    threshold: 0.6,
    method: 'template',
    findAll: true,
    maxMatches: 4,
    timeoutMs: 260,
    minScale: 1,
    maxScale: 1,
    scaleHint: 1,
    maxBudgetMs: 80,
  });
  const reported = direct.bestMatch;
  if (reported && reported.confidence >= 0.6) {
    const miss = Math.hypot(reported.x - trueCenter.x, reported.y - trueCenter.y);
    expect(miss).toBeGreaterThan(24);
    expect(reported.confidence).toBeLessThan(0.85);
  }
  const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(painted);
  const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(painted);
  const engine = new PlaybackEngine({
    inputPlayer: {} as any,
    imageService,
    windowManager: { getTargetBounds: () => null, getTargetBoundsAsync: async () => null } as any,
  }) as any;
  engine.config = {
    profileId: 'live-painted',
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

liveMatch('a moved screen target clicks the context image when the patch is painted out', async () => {
  const sharp = require('sharp');
  const imageService = new ImageService('http://127.0.0.1:5001');
  expect(await imageService.healthCheck(800)).toBe(true);

  const origin = { x: 400, y: 300 };
  const size = 640;
  const shift = 24;
  const patchOrigin = { x: 220, y: 180 };
  const patchSize = 96;
  const raw = Buffer.alloc(size * size * 3);
  const tile = 40;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 3;
      const tx = Math.floor(x / tile);
      const ty = Math.floor(y / tile);
      raw[i] = (tx * 37 + ty * 17) % 200 + 30;
      raw[i + 1] = (tx * 13 + ty * 53) % 200 + 20;
      raw[i + 2] = (tx * 71 + ty * 29) % 200 + 15;
      const inPatch =
        x >= patchOrigin.x &&
        x < patchOrigin.x + patchSize &&
        y >= patchOrigin.y &&
        y < patchOrigin.y + patchSize;
      if (inPatch) {
        const bar = Math.floor((x - patchOrigin.x) / 6) % 2 === 0;
        raw[i] = bar ? 250 : 12;
        raw[i + 1] = bar ? 20 : 230;
        raw[i + 2] = ((y - patchOrigin.y) * 9) % 255;
      }
    }
  }
  const logical = await sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
  const patch = await sharp(logical)
    .extract({ left: patchOrigin.x, top: patchOrigin.y, width: patchSize, height: patchSize })
    .png()
    .toBuffer();
  const contextSize = 288;
  const contextOrigin = {
    x: patchOrigin.x + patchSize / 2 - contextSize / 2,
    y: patchOrigin.y + patchSize / 2 - contextSize / 2,
  };
  const context = await sharp(logical)
    .extract({
      left: contextOrigin.x,
      top: contextOrigin.y,
      width: contextSize,
      height: contextSize,
    })
    .png()
    .toBuffer();
  const moved = await sharp(logical)
    .extract({ left: 0, top: 0, width: size - shift, height: size - shift })
    .png()
    .toBuffer();
  const shifted = await sharp({
    create: { width: size, height: size, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .composite([{ input: moved, left: shift, top: shift }])
    .png()
    .toBuffer();
  const paint = await sharp({
    create: { width: patchSize, height: patchSize, channels: 3, background: { r: 220, g: 30, b: 30 } },
  }).png().toBuffer();
  const painted = await sharp(shifted)
    .composite([{ input: paint, left: patchOrigin.x + shift, top: patchOrigin.y + shift }])
    .png()
    .toBuffer();
  const recordedHash = await computeDHash(patch);
  const recorded = { x: origin.x + size / 2, y: origin.y + size / 2 };
  const visual = {
    x: origin.x + patchOrigin.x + shift + patchSize / 2,
    y: origin.y + patchOrigin.y + shift + patchSize / 2,
  };
  const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(painted);
  const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockImplementation(async () => {
    throw new Error('full screen capture');
  });
  const engine = new PlaybackEngine({
    inputPlayer: {} as any,
    imageService,
    windowManager: { getTargetBounds: () => null, getTargetBoundsAsync: async () => null } as any,
  }) as any;
  engine.config = {
    profileId: 'live-context-move',
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
      img_context_b64: context.toString('base64'),
      metadata: { img_dhash: recordedHash, recorded_match_scale: 1 },
    },
    recorded
  );
  const elapsed = Date.now() - started;
  const status = engine.getStatus();
  captureSpy.mockRestore();
  screenSpy.mockRestore();
  expect(screenSpy).not.toHaveBeenCalled();
  if (
    Math.abs(result.x - visual.x) > 8 ||
    Math.abs(result.y - visual.y) > 8
  ) {
    throw new Error(
      `click (${result.x}, ${result.y}) visual (${visual.x}, ${visual.y}) ${status.smartClickLastMethod} ${status.smartClickLastConfidence} source ${status.smartClickLastSource}`
    );
  }
  expect(result).not.toEqual(recorded);
  expect(status.smartClickLastMethod).toBe('feature');
  expect(status.smartClickLastSource).toBe('region');
  expect(status.smartClickLastConfidence).toBeGreaterThan(0.6);
  if (elapsed >= 460) {
    throw new Error(`context click took ${elapsed}ms at (${result.x}, ${result.y})`);
  }
}, 20000);

liveMatch('a flat screen patch at 140% clicks the scaled center', async () => {
  const sharp = require('sharp');
  const imageService = new ImageService('http://127.0.0.1:5001');
  expect(await imageService.healthCheck(800)).toBe(true);

  const origin = { x: 400, y: 300 };
  const size = 640;
  const patchSize = 96;
  const scale = 1.4;
  const patchOrigin = { x: 220, y: 180 };
  const scaledW = Math.round(patchSize * scale);
  const scaledH = Math.round(patchSize * scale);
  const raw = Buffer.alloc(size * size * 3, 24);
  for (let y = patchOrigin.y; y < patchOrigin.y + scaledH; y += 1) {
    for (let x = patchOrigin.x; x < patchOrigin.x + scaledW; x += 1) {
      const i = (y * size + x) * 3;
      raw[i] = 140;
      raw[i + 1] = 140;
      raw[i + 2] = 140;
    }
  }
  const search = await sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
  const patchRaw = Buffer.alloc(patchSize * patchSize * 3, 140);
  const patch = await sharp(patchRaw, { raw: { width: patchSize, height: patchSize, channels: 3 } }).png().toBuffer();
  const recordedHash = await computeDHash(patch);
  const recorded = { x: origin.x + size / 2, y: origin.y + size / 2 };
  const visual = {
    x: origin.x + patchOrigin.x + scaledW / 2,
    y: origin.y + patchOrigin.y + scaledH / 2,
  };
  const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(search);
  const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockImplementation(async () => {
    throw new Error('full screen capture');
  });
  const engine = new PlaybackEngine({
    inputPlayer: {} as any,
    imageService,
    windowManager: { getTargetBounds: () => null, getTargetBoundsAsync: async () => null } as any,
  }) as any;
  engine.config = {
    profileId: 'live-flat-140',
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
  captureSpy.mockRestore();
  screenSpy.mockRestore();
  expect(screenSpy).not.toHaveBeenCalled();
  if (
    Math.abs(result.x - visual.x) > 8 ||
    Math.abs(result.y - visual.y) > 8
  ) {
    throw new Error(
      `click (${result.x}, ${result.y}) visual (${visual.x}, ${visual.y}) scale ${status.smartClickLastScale} ${status.smartClickLastConfidence} source ${status.smartClickLastSource}`
    );
  }
  expect(result).not.toEqual(recorded);
  expect(status.smartClickLastSource).toBe('region');
  expect(status.smartClickLastConfidence).toBeGreaterThan(0.6);
  expect(status.smartClickLastScale).toBeGreaterThanOrEqual(scale - 0.08);
  expect(status.smartClickLastScale).toBeLessThanOrEqual(scale + 0.08);
  if (elapsed >= 460) {
    throw new Error(`flat 140 click took ${elapsed}ms at (${result.x}, ${result.y})`);
  }
}, 20000);

liveMatch('two copies eight pixels apart click the recorded one', async () => {
  const sharp = require('sharp');
  const imageService = new ImageService('http://127.0.0.1:5001');
  expect(await imageService.healthCheck(800)).toBe(true);

  const origin = { x: 400, y: 300 };
  const size = 640;
  const patchSize = 40;
  const gap = 8;
  const raw = Buffer.alloc(size * size * 3, 18);
  const patch = Buffer.alloc(patchSize * patchSize * 3, 0);
  for (let y = 0; y < patchSize; y += 1) {
    for (let x = 0; x < patchSize; x += 1) {
      const i = (y * patchSize + x) * 3;
      const border = x < 2 || y < 2 || x >= patchSize - 2 || y >= patchSize - 2;
      const diag = Math.abs(x - y) < 2;
      const blob = (x - 12) ** 2 + (y - 26) ** 2 < 36;
      patch[i] = border ? 240 : diag ? 255 : blob ? 30 : 80 + ((x * 3) % 40);
      patch[i + 1] = border ? 40 : blob ? 180 : 60;
      patch[i + 2] = border ? 40 : diag ? 20 : 200;
    }
  }
  const rightLeft = size / 2 - patchSize / 2;
  const leftLeft = rightLeft - patchSize - gap;
  const top = size / 2 - patchSize / 2;
  const blit = (destX: number, destY: number) => {
    for (let y = 0; y < patchSize; y += 1) {
      for (let x = 0; x < patchSize; x += 1) {
        const src = (y * patchSize + x) * 3;
        const dst = ((destY + y) * size + (destX + x)) * 3;
        raw[dst] = patch[src];
        raw[dst + 1] = patch[src + 1];
        raw[dst + 2] = patch[src + 2];
      }
    }
  };
  blit(leftLeft, top);
  blit(rightLeft, top);
  const search = await sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
  const patchPng = await sharp(patch, { raw: { width: patchSize, height: patchSize, channels: 3 } }).png().toBuffer();
  const recordedHash = await computeDHash(patchPng);
  const recorded = { x: origin.x + size / 2, y: origin.y + size / 2 };
  const other = {
    x: origin.x + leftLeft + patchSize / 2,
    y: origin.y + top + patchSize / 2,
  };
  const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(search);
  const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockImplementation(async () => {
    throw new Error('full screen capture');
  });
  const engine = new PlaybackEngine({
    inputPlayer: {} as any,
    imageService,
    windowManager: { getTargetBounds: () => null, getTargetBoundsAsync: async () => null } as any,
  }) as any;
  engine.config = {
    profileId: 'live-nearby-copy',
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
      img_patch_b64: patchPng.toString('base64'),
      metadata: { img_dhash: recordedHash, recorded_match_scale: 1 },
    },
    recorded
  );
  const elapsed = Date.now() - started;
  const status = engine.getStatus();
  captureSpy.mockRestore();
  screenSpy.mockRestore();
  expect(screenSpy).not.toHaveBeenCalled();
  const recordedError = Math.hypot(result.x - recorded.x, result.y - recorded.y);
  const otherError = Math.hypot(result.x - other.x, result.y - other.y);
  if (recordedError > 8 || otherError <= 8) {
    throw new Error(
      `click (${result.x}, ${result.y}) recorded (${recorded.x}, ${recorded.y}) other (${other.x}, ${other.y}) ${status.smartClickLastMethod} ${status.smartClickLastConfidence} source ${status.smartClickLastSource}`
    );
  }
  expect(status.smartClickLastSource).toBe('region');
  expect(status.smartClickLastConfidence).toBeGreaterThan(0.6);
  if (elapsed >= 460) {
    throw new Error(`nearby copy click took ${elapsed}ms at (${result.x}, ${result.y})`);
  }
}, 20000);

liveMatch('a textured context at 140% clicks the scaled center', async () => {
  const { execFileSync } = require('child_process') as typeof import('child_process');
  const imageService = new ImageService('http://127.0.0.1:5001');
  expect(await imageService.healthCheck(800)).toBe(true);
  const serviceDir = '/Users/Shared/OpenClaw_Shared/Git/clicksmith-smartclick-c741/image-service';
  const python = '/Users/Shared/OpenClaw_Shared/Git/clicksmith/image-service/.venv/bin/python';
  const raw = execFileSync(
    python,
    [
      '-c',
      [
        'import json, os, sys',
        `sys.path.insert(0, ${JSON.stringify(serviceDir)})`,
        `os.chdir(${JSON.stringify(serviceDir)})`,
        'from tests.test_match import make_feature_template, embed_scaled_template, expected_center, to_base64',
        'import numpy as np',
        'template = make_feature_template(128)',
        'origin = (220, 180)',
        'scale = 1.4',
        'search = embed_scaled_template(template, scale, canvas_size=640, origin=origin)',
        'patch = np.full((96, 96, 3), (255, 0, 255), dtype=np.uint8)',
        'cx, cy = expected_center(template, scale, origin)',
        'print(json.dumps({"template": to_base64(template), "search": to_base64(search), "patch": to_base64(patch), "cx": cx, "cy": cy}))',
      ].join('\n'),
    ],
    { encoding: 'utf8' }
  );
  const fixture = JSON.parse(raw) as { template: string; search: string; patch: string; cx: number; cy: number };
  const search = Buffer.from(fixture.search, 'base64');
  const patch = Buffer.from(fixture.patch, 'base64');
  const context = Buffer.from(fixture.template, 'base64');
  const recordedHash = await computeDHash(patch);
  const origin = { x: 400, y: 300 };
  const recorded = { x: origin.x + 320, y: origin.y + 320 };
  const visual = { x: origin.x + fixture.cx, y: origin.y + fixture.cy };
  const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(search);
  const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockImplementation(async () => {
    throw new Error('full screen capture');
  });
  const engine = new PlaybackEngine({
    inputPlayer: {} as any,
    imageService,
    windowManager: { getTargetBounds: () => null, getTargetBoundsAsync: async () => null } as any,
  }) as any;
  engine.config = {
    profileId: 'live-feature-140',
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
      img_context_b64: context.toString('base64'),
      metadata: { img_dhash: recordedHash, recorded_match_scale: 1 },
    },
    recorded
  );
  const elapsed = Date.now() - started;
  const status = engine.getStatus();
  captureSpy.mockRestore();
  screenSpy.mockRestore();
  expect(screenSpy).not.toHaveBeenCalled();
  if (Math.abs(result.x - visual.x) > 8 || Math.abs(result.y - visual.y) > 8) {
    throw new Error(
      `click (${result.x}, ${result.y}) visual (${visual.x}, ${visual.y}) ${status.smartClickLastMethod} ${status.smartClickLastConfidence} scale ${status.smartClickLastScale} source ${status.smartClickLastSource}`
    );
  }
  expect(result).not.toEqual(recorded);
  expect(status.smartClickLastMethod).toBe('feature');
  expect(status.smartClickLastSource).toBe('region');
  expect(status.smartClickLastConfidence).toBeGreaterThan(0.6);
  expect(status.smartClickLastScale).toBeGreaterThanOrEqual(1.4 - 0.08);
  expect(status.smartClickLastScale).toBeLessThanOrEqual(1.4 + 0.08);
  if (elapsed >= 460) {
    throw new Error(`feature 140 click took ${elapsed}ms at (${result.x}, ${result.y})`);
  }
}, 20000);

liveMatch('a screen patch outside the search radius clicks the far center', async () => {
  const { execFileSync } = require('child_process') as typeof import('child_process');
  const imageService = new ImageService('http://127.0.0.1:5001');
  expect(await imageService.healthCheck(800)).toBe(true);
  const serviceDir = '/Users/Shared/OpenClaw_Shared/Git/clicksmith-smartclick-c741/image-service';
  const python = '/Users/Shared/OpenClaw_Shared/Git/clicksmith/image-service/.venv/bin/python';
  const raw = execFileSync(
    python,
    [
      '-c',
      [
        'import json, os, sys',
        `sys.path.insert(0, ${JSON.stringify(serviceDir)})`,
        `os.chdir(${JSON.stringify(serviceDir)})`,
        'from tests.test_match import make_feature_template, expected_center, to_base64',
        'import numpy as np',
        'template = make_feature_template(96)',
        'origin = (1400, 700)',
        'desktop = np.zeros((1080, 1920, 3), dtype=np.uint8)',
        'desktop[origin[1]:origin[1] + 96, origin[0]:origin[0] + 96] = template',
        'neighborhood = np.zeros((640, 640, 3), dtype=np.uint8)',
        'neighborhood[40:180, 40:200] = (40, 40, 180)',
        'cx, cy = expected_center(template, 1.0, origin)',
        'print(json.dumps({"template": to_base64(template), "neighborhood": to_base64(neighborhood), "desktop": to_base64(desktop), "cx": cx, "cy": cy}))',
      ].join('\n'),
    ],
    { encoding: 'utf8' }
  );
  const fixture = JSON.parse(raw) as {
    template: string;
    neighborhood: string;
    desktop: string;
    cx: number;
    cy: number;
  };
  const patch = Buffer.from(fixture.template, 'base64');
  const neighborhood = Buffer.from(fixture.neighborhood, 'base64');
  const desktop = Buffer.from(fixture.desktop, 'base64');
  const recordedHash = await computeDHash(patch);
  const recorded = { x: 480, y: 360 };
  const visual = { x: fixture.cx, y: fixture.cy };
  const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(neighborhood);
  const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(desktop);
  const engine = new PlaybackEngine({
    inputPlayer: {} as any,
    imageService,
    windowManager: { getTargetBounds: () => null, getTargetBoundsAsync: async () => null } as any,
  }) as any;
  engine.config = {
    profileId: 'live-far-patch',
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
  const region = captureSpy.mock.calls[0]?.[0] as { x: number; y: number; width: number; height: number } | undefined;
  const fullscreenCaptures = screenSpy.mock.calls.length;
  captureSpy.mockRestore();
  screenSpy.mockRestore();
  expect(region).toBeDefined();
  expect(
    visual.x < region!.x ||
      visual.x >= region!.x + region!.width ||
      visual.y < region!.y ||
      visual.y >= region!.y + region!.height
  ).toBe(true);
  expect(fullscreenCaptures).toBeGreaterThan(0);
  if (Math.abs(result.x - visual.x) > 8 || Math.abs(result.y - visual.y) > 8) {
    throw new Error(
      `click (${result.x}, ${result.y}) visual (${visual.x}, ${visual.y}) ${status.smartClickLastMethod} ${status.smartClickLastConfidence} scale ${status.smartClickLastScale} source ${status.smartClickLastSource} elapsed ${elapsed}`
    );
  }
  expect(result).not.toEqual(recorded);
  expect(status.smartClickLastSource).toBe('fullscreen');
  expect(status.smartClickLastConfidence).toBeGreaterThan(0.6);
  if (elapsed >= 460) {
    throw new Error(`far patch click took ${elapsed}ms at (${result.x}, ${result.y})`);
  }
}, 20000);

liveMatch('a 140% screen patch outside the search radius clicks the scaled center', async () => {
  const { execFileSync } = require('child_process') as typeof import('child_process');
  const imageService = new ImageService('http://127.0.0.1:5001');
  expect(await imageService.healthCheck(800)).toBe(true);
  const serviceDir = '/Users/Shared/OpenClaw_Shared/Git/clicksmith-smartclick-c741/image-service';
  const python = '/Users/Shared/OpenClaw_Shared/Git/clicksmith/image-service/.venv/bin/python';
  const raw = execFileSync(
    python,
    [
      '-c',
      [
        'import json, os, sys',
        `sys.path.insert(0, ${JSON.stringify(serviceDir)})`,
        `os.chdir(${JSON.stringify(serviceDir)})`,
        'from tests.test_match import make_feature_template, expected_center, to_base64',
        'import cv2',
        'import numpy as np',
        'template = make_feature_template(96)',
        'scale = 1.4',
        'origin = (1100, 500)',
        'scaled = cv2.resize(template, None, fx=scale, fy=scale, interpolation=cv2.INTER_LINEAR)',
        'desktop = np.zeros((1080, 1920, 3), dtype=np.uint8)',
        'height, width = scaled.shape[:2]',
        'desktop[origin[1]:origin[1] + height, origin[0]:origin[0] + width] = scaled',
        'neighborhood = np.zeros((640, 640, 3), dtype=np.uint8)',
        'neighborhood[40:180, 40:200] = (40, 40, 180)',
        'cx, cy = expected_center(template, scale, origin)',
        'print(json.dumps({"template": to_base64(template), "neighborhood": to_base64(neighborhood), "desktop": to_base64(desktop), "cx": cx, "cy": cy}))',
      ].join('\n'),
    ],
    { encoding: 'utf8' }
  );
  const fixture = JSON.parse(raw) as {
    template: string;
    neighborhood: string;
    desktop: string;
    cx: number;
    cy: number;
  };
  const patch = Buffer.from(fixture.template, 'base64');
  const neighborhood = Buffer.from(fixture.neighborhood, 'base64');
  const desktop = Buffer.from(fixture.desktop, 'base64');
  const recordedHash = await computeDHash(patch);
  const recorded = { x: 480, y: 360 };
  const visual = { x: fixture.cx, y: fixture.cy };
  const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(neighborhood);
  const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(desktop);
  const engine = new PlaybackEngine({
    inputPlayer: {} as any,
    imageService,
    windowManager: { getTargetBounds: () => null, getTargetBoundsAsync: async () => null } as any,
  }) as any;
  engine.config = {
    profileId: 'live-far-140',
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
  const region = captureSpy.mock.calls[0]?.[0] as { x: number; y: number; width: number; height: number } | undefined;
  const fullscreenCaptures = screenSpy.mock.calls.length;
  captureSpy.mockRestore();
  screenSpy.mockRestore();
  expect(region).toBeDefined();
  expect(
    visual.x < region!.x ||
      visual.x >= region!.x + region!.width ||
      visual.y < region!.y ||
      visual.y >= region!.y + region!.height
  ).toBe(true);
  expect(fullscreenCaptures).toBeGreaterThan(0);
  if (Math.abs(result.x - visual.x) > 8 || Math.abs(result.y - visual.y) > 8) {
    throw new Error(
      `click (${result.x}, ${result.y}) visual (${visual.x}, ${visual.y}) ${status.smartClickLastMethod} ${status.smartClickLastConfidence} scale ${status.smartClickLastScale} source ${status.smartClickLastSource} elapsed ${elapsed}`
    );
  }
  expect(result).not.toEqual(recorded);
  expect(status.smartClickLastSource).toBe('fullscreen');
  expect(status.smartClickLastConfidence).toBeGreaterThan(0.6);
  expect(status.smartClickLastScale).toBeGreaterThanOrEqual(1.4 - 0.08);
  expect(status.smartClickLastScale).toBeLessThanOrEqual(1.4 + 0.08);
  if (elapsed >= 460) {
    throw new Error(`far 140 click took ${elapsed}ms at (${result.x}, ${result.y})`);
  }
}, 20000);

liveMatch('a 110% patch inside the search radius clicks the scaled center', async () => {
  const { execFileSync } = require('child_process') as typeof import('child_process');
  const imageService = new ImageService('http://127.0.0.1:5001');
  expect(await imageService.healthCheck(800)).toBe(true);
  const serviceDir = '/Users/Shared/OpenClaw_Shared/Git/clicksmith-smartclick-c741/image-service';
  const python = '/Users/Shared/OpenClaw_Shared/Git/clicksmith/image-service/.venv/bin/python';
  const raw = execFileSync(
    python,
    [
      '-c',
      [
        'import json, os, sys',
        `sys.path.insert(0, ${JSON.stringify(serviceDir)})`,
        `os.chdir(${JSON.stringify(serviceDir)})`,
        'from tests.test_match import make_feature_template, embed_scaled_template, expected_center, to_base64',
        'template = make_feature_template(96)',
        'origin = (180, 140)',
        'scenes = []',
        'for scale in (1.1, 0.9):',
        '    search = embed_scaled_template(template, scale, canvas_size=640, origin=origin)',
        '    cx, cy = expected_center(template, scale, origin)',
        '    scenes.append({"scale": scale, "search": to_base64(search), "cx": cx, "cy": cy})',
        'print(json.dumps({"template": to_base64(template), "scenes": scenes}))',
      ].join('\n'),
    ],
    { encoding: 'utf8' }
  );
  const fixture = JSON.parse(raw) as {
    template: string;
    scenes: Array<{ scale: number; search: string; cx: number; cy: number }>;
  };
  const patch = Buffer.from(fixture.template, 'base64');
  const recordedHash = await computeDHash(patch);
  const recorded = { x: 480, y: 400 };
  for (const scene of fixture.scenes) {
    const search = Buffer.from(scene.search, 'base64');
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(search);
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockImplementation(async () => {
      throw new Error('full screen capture');
    });
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService,
      windowManager: { getTargetBounds: () => null, getTargetBoundsAsync: async () => null } as any,
    }) as any;
    engine.config = {
      profileId: `live-zoom-${scene.scale}`,
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
    const region = captureSpy.mock.calls[0]?.[0] as { x: number; y: number; width: number; height: number };
    const fullscreenCaptures = screenSpy.mock.calls.length;
    captureSpy.mockRestore();
    screenSpy.mockRestore();
    const visual = { x: region.x + scene.cx, y: region.y + scene.cy };
    expect(fullscreenCaptures).toBe(0);
    if (Math.abs(result.x - visual.x) > 8 || Math.abs(result.y - visual.y) > 8) {
      throw new Error(
        `scale ${scene.scale} click (${result.x}, ${result.y}) visual (${visual.x}, ${visual.y}) ${status.smartClickLastMethod} ${status.smartClickLastConfidence} scale ${status.smartClickLastScale} source ${status.smartClickLastSource} elapsed ${elapsed}`
      );
    }
    expect(result).not.toEqual(recorded);
    expect(status.smartClickLastSource).toBe('region');
    expect(status.smartClickLastConfidence).toBeGreaterThan(0.6);
    expect(status.smartClickLastScale).toBeGreaterThanOrEqual(scene.scale - 0.08);
    expect(status.smartClickLastScale).toBeLessThanOrEqual(scene.scale + 0.08);
    if (elapsed >= 460) {
      throw new Error(`scale ${scene.scale} click took ${elapsed}ms at (${result.x}, ${result.y})`);
    }
  }
}, 20000);

liveMatch('a 120% patch inside the search radius clicks the scaled center', async () => {
  const { execFileSync } = require('child_process') as typeof import('child_process');
  const imageService = new ImageService('http://127.0.0.1:5001');
  expect(await imageService.healthCheck(800)).toBe(true);
  const serviceDir = '/Users/Shared/OpenClaw_Shared/Git/clicksmith-smartclick-c741/image-service';
  const python = '/Users/Shared/OpenClaw_Shared/Git/clicksmith/image-service/.venv/bin/python';
  const raw = execFileSync(
    python,
    [
      '-c',
      [
        'import json, os, sys',
        `sys.path.insert(0, ${JSON.stringify(serviceDir)})`,
        `os.chdir(${JSON.stringify(serviceDir)})`,
        'from tests.test_match import make_feature_template, embed_scaled_template, expected_center, to_base64',
        'template = make_feature_template(96)',
        'origin = (40, 50)',
        'scale = 1.2',
        'search = embed_scaled_template(template, scale, canvas_size=640, origin=origin)',
        'cx, cy = expected_center(template, scale, origin)',
        'print(json.dumps({"template": to_base64(template), "search": to_base64(search), "cx": cx, "cy": cy, "scale": scale}))',
      ].join('\n'),
    ],
    { encoding: 'utf8' }
  );
  const fixture = JSON.parse(raw) as {
    template: string;
    search: string;
    cx: number;
    cy: number;
    scale: number;
  };
  const patch = Buffer.from(fixture.template, 'base64');
  const search = Buffer.from(fixture.search, 'base64');
  const recordedHash = await computeDHash(patch);
  const recorded = { x: 480, y: 400 };
  const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(search);
  const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockImplementation(async () => {
    throw new Error('full screen capture');
  });
  const engine = new PlaybackEngine({
    inputPlayer: {} as any,
    imageService,
    windowManager: { getTargetBounds: () => null, getTargetBoundsAsync: async () => null } as any,
  }) as any;
  engine.config = {
    profileId: 'live-zoom-1.2',
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
  const region = captureSpy.mock.calls[0]?.[0] as { x: number; y: number; width: number; height: number };
  const fullscreenCaptures = screenSpy.mock.calls.length;
  captureSpy.mockRestore();
  screenSpy.mockRestore();
  const visual = { x: region.x + fixture.cx, y: region.y + fixture.cy };
  if (
    fullscreenCaptures !== 0 ||
    Math.abs(result.x - visual.x) > 8 ||
    Math.abs(result.y - visual.y) > 8
  ) {
    throw new Error(
      `scale 1.2 click (${result.x}, ${result.y}) visual (${visual.x}, ${visual.y}) fullscreen ${fullscreenCaptures} ${status.smartClickLastMethod} ${status.smartClickLastConfidence} scale ${status.smartClickLastScale} source ${status.smartClickLastSource} elapsed ${elapsed}`
    );
  }
  expect(result).not.toEqual(recorded);
  expect(status.smartClickLastSource).toBe('region');
  expect(status.smartClickLastConfidence).toBeGreaterThan(0.6);
  expect(status.smartClickLastScale).toBeGreaterThanOrEqual(fixture.scale - 0.08);
  expect(status.smartClickLastScale).toBeLessThanOrEqual(fixture.scale + 0.08);
  if (elapsed >= 460) {
    throw new Error(`scale 1.2 click took ${elapsed}ms at (${result.x}, ${result.y})`);
  }
}, 20000);

liveMatch('a scrolled patch inside the window clicks its new center', async () => {
  const { execFileSync } = require('child_process') as typeof import('child_process');
  const imageService = new ImageService('http://127.0.0.1:5001');
  expect(await imageService.healthCheck(800)).toBe(true);
  const serviceDir = '/Users/Shared/OpenClaw_Shared/Git/clicksmith-smartclick-c741/image-service';
  const python = '/Users/Shared/OpenClaw_Shared/Git/clicksmith/image-service/.venv/bin/python';
  const raw = execFileSync(
    python,
    [
      '-c',
      [
        'import json, os, sys, cv2',
        'import numpy as np',
        `sys.path.insert(0, ${JSON.stringify(serviceDir)})`,
        `os.chdir(${JSON.stringify(serviceDir)})`,
        'from tests.test_match import make_feature_template, expected_center, to_base64',
        'template = make_feature_template(96)',
        'origin = (80, 430)',
        'scenes = []',
        'for scale in (1.0, 0.7, 0.8, 1.25, 1.4):',
        '    search = np.zeros((600, 800, 3), dtype=np.uint8)',
        '    scaled = cv2.resize(template, dsize=None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA if scale < 1.0 else cv2.INTER_LINEAR)',
        '    height, width = scaled.shape[:2]',
        '    x, y = origin',
        '    search[y:y + height, x:x + width] = scaled',
        '    cx, cy = expected_center(template, scale, origin)',
        '    scenes.append({"scale": scale, "search": to_base64(search), "cx": cx, "cy": cy})',
        'print(json.dumps({"template": to_base64(template), "scenes": scenes}))',
      ].join('\n'),
    ],
    { encoding: 'utf8' }
  );
  const fixture = JSON.parse(raw) as {
    template: string;
    scenes: Array<{ scale: number; search: string; cx: number; cy: number }>;
  };
  const patch = Buffer.from(fixture.template, 'base64');
  const recordedHash = await computeDHash(patch);
  const windowOrigin = { x: 120, y: 80 };
  const windowSize = { width: 800, height: 600 };
  const recorded = {
    x: Math.round(windowOrigin.x + windowSize.width * 0.25),
    y: Math.round(windowOrigin.y + windowSize.height * (70 / 600)),
  };
  for (const scene of fixture.scenes) {
    const search = Buffer.from(scene.search, 'base64');
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(search);
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockImplementation(async () => {
      throw new Error('full screen capture');
    });
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService,
      windowManager: {
        getTargetBounds: () => ({ ...windowOrigin, ...windowSize }),
        getTargetBoundsAsync: async () => ({ ...windowOrigin, ...windowSize }),
      } as any,
    }) as any;
    engine.config = {
      profileId: `live-scroll-${scene.scale}`,
      target: 'Terminal',
      useImageMatching: true,
      imageMatchThreshold: 0.6,
      timingTolerance: 20,
      retryCount: 0,
      retryDelay: 10,
      takeoverHotkey: 'F11',
      speedMultiplier: 1,
      useRelativeCoords: true,
      imageSearchRadius: 160,
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
        rel_x: 0.25,
        rel_y: 70 / 600,
        duration_ms: 0,
        human_override: false,
        img_patch_b64: patch.toString('base64'),
        metadata: { img_dhash: recordedHash, recorded_match_scale: 1 },
      },
      recorded
    );
    const elapsed = Date.now() - started;
    const status = engine.getStatus();
    const fullscreenCaptures = screenSpy.mock.calls.length;
    captureSpy.mockRestore();
    screenSpy.mockRestore();
    const visual = { x: windowOrigin.x + scene.cx, y: windowOrigin.y + scene.cy };
    expect(fullscreenCaptures).toBe(0);
    if (Math.abs(result.x - visual.x) > 8 || Math.abs(result.y - visual.y) > 8) {
      throw new Error(
        `scale ${scene.scale} click (${result.x}, ${result.y}) visual (${visual.x}, ${visual.y}) recorded (${recorded.x}, ${recorded.y}) ${status.smartClickLastMethod} ${status.smartClickLastConfidence} scale ${status.smartClickLastScale} source ${status.smartClickLastSource} elapsed ${elapsed}`
      );
    }
    expect(result).not.toEqual(recorded);
    expect(status.smartClickLastSource).toBe('window');
    expect(status.smartClickLastConfidence).toBeGreaterThan(0.6);
    expect(status.smartClickLastScale).toBeGreaterThanOrEqual(scene.scale - 0.08);
    expect(status.smartClickLastScale).toBeLessThanOrEqual(scene.scale + 0.08);
    if (elapsed >= 460) {
      throw new Error(`scale ${scene.scale} click took ${elapsed}ms at (${result.x}, ${result.y})`);
    }
  }
}, 25000);

liveMatch('a re-rendered 70% button clicks its center', async () => {
  const { execFileSync } = require('child_process') as typeof import('child_process');
  const imageService = new ImageService('http://127.0.0.1:5001');
  expect(await imageService.healthCheck(800)).toBe(true);
  const serviceDir = '/Users/Shared/OpenClaw_Shared/Git/clicksmith-smartclick-c741/image-service';
  const python = '/Users/Shared/OpenClaw_Shared/Git/clicksmith/image-service/.venv/bin/python';
  const raw = execFileSync(
    python,
    [
      '-c',
      [
        'import json, os, sys',
        'import numpy as np',
        `sys.path.insert(0, ${JSON.stringify(serviceDir)})`,
        `os.chdir(${JSON.stringify(serviceDir)})`,
        'from tests.test_match import redraw_text_button, to_base64',
        'template = redraw_text_button(1.0)',
        'button = redraw_text_button(0.7)',
        'origin = (40, 50)',
        'search = np.full((640, 640, 3), 245, dtype=np.uint8)',
        'height, width = button.shape[:2]',
        'search[origin[1]:origin[1] + height, origin[0]:origin[0] + width] = button',
        'print(json.dumps({"template": to_base64(template), "search": to_base64(search), "cx": origin[0] + width / 2.0, "cy": origin[1] + height / 2.0}))',
      ].join('\n'),
    ],
    { encoding: 'utf8' }
  );
  const fixture = JSON.parse(raw) as { template: string; search: string; cx: number; cy: number };
  const patch = Buffer.from(fixture.template, 'base64');
  const search = Buffer.from(fixture.search, 'base64');
  const recordedHash = await computeDHash(patch);
  const recorded = { x: 480, y: 400 };
  const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(search);
  const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockImplementation(async () => {
    throw new Error('full screen capture');
  });
  const engine = new PlaybackEngine({
    inputPlayer: {} as any,
    imageService,
    windowManager: { getTargetBounds: () => null, getTargetBoundsAsync: async () => null } as any,
  }) as any;
  engine.config = {
    profileId: 'live-button-0.7',
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
  const region = captureSpy.mock.calls[0]?.[0] as { x: number; y: number; width: number; height: number };
  const fullscreenCaptures = screenSpy.mock.calls.length;
  captureSpy.mockRestore();
  screenSpy.mockRestore();
  const visual = { x: region.x + fixture.cx, y: region.y + fixture.cy };
  if (
    fullscreenCaptures !== 0 ||
    Math.abs(result.x - visual.x) > 8 ||
    Math.abs(result.y - visual.y) > 8
  ) {
    throw new Error(
      `button click (${result.x}, ${result.y}) visual (${visual.x}, ${visual.y}) fullscreen ${fullscreenCaptures} ${status.smartClickLastMethod} ${status.smartClickLastConfidence} scale ${status.smartClickLastScale} source ${status.smartClickLastSource} elapsed ${elapsed}`
    );
  }
  expect(result).not.toEqual(recorded);
  expect(status.smartClickLastSource).toBe('region');
  expect(status.smartClickLastConfidence).toBeGreaterThan(0.6);
  expect(status.smartClickLastScale).toBeGreaterThanOrEqual(0.62);
  expect(status.smartClickLastScale).toBeLessThanOrEqual(0.78);
  if (elapsed >= 460) {
    throw new Error(`button click took ${elapsed}ms at (${result.x}, ${result.y})`);
  }
}, 20000);

liveMatch('re-rendered buttons at 75%, 125%, 133%, and 140% click their centers', async () => {
  const { execFileSync } = require('child_process') as typeof import('child_process');
  const imageService = new ImageService('http://127.0.0.1:5001');
  expect(await imageService.healthCheck(800)).toBe(true);
  const serviceDir = '/Users/Shared/OpenClaw_Shared/Git/clicksmith-smartclick-c741/image-service';
  const python = '/Users/Shared/OpenClaw_Shared/Git/clicksmith/image-service/.venv/bin/python';
  const raw = execFileSync(
    python,
    [
      '-c',
      [
        'import json, os, sys',
        'import numpy as np',
        `sys.path.insert(0, ${JSON.stringify(serviceDir)})`,
        `os.chdir(${JSON.stringify(serviceDir)})`,
        'from tests.test_match import redraw_text_button, to_base64',
        'template = redraw_text_button(1.0)',
        'scenes = []',
        'for scale in (0.75, 1.25, 1.33, 1.4):',
        '    button = redraw_text_button(scale)',
        '    origin = (40, 50)',
        '    search = np.full((640, 640, 3), 245, dtype=np.uint8)',
        '    height, width = button.shape[:2]',
        '    search[origin[1]:origin[1] + height, origin[0]:origin[0] + width] = button',
        '    scenes.append({"scale": scale, "search": to_base64(search), "cx": origin[0] + width / 2.0, "cy": origin[1] + height / 2.0})',
        'print(json.dumps({"template": to_base64(template), "scenes": scenes}))',
      ].join('\n'),
    ],
    { encoding: 'utf8' }
  );
  const fixture = JSON.parse(raw) as {
    template: string;
    scenes: Array<{ scale: number; search: string; cx: number; cy: number }>;
  };
  const patch = Buffer.from(fixture.template, 'base64');
  const recordedHash = await computeDHash(patch);
  const recorded = { x: 480, y: 400 };
  const failures: string[] = [];
  for (const scene of fixture.scenes) {
    const search = Buffer.from(scene.search, 'base64');
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(search);
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockImplementation(async () => {
      throw new Error('full screen capture');
    });
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService,
      windowManager: { getTargetBounds: () => null, getTargetBoundsAsync: async () => null } as any,
    }) as any;
    engine.config = {
      profileId: `live-button-${scene.scale}`,
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
    const region = captureSpy.mock.calls[0]?.[0] as { x: number; y: number; width: number; height: number };
    captureSpy.mockRestore();
    screenSpy.mockRestore();
    const visual = { x: region.x + scene.cx, y: region.y + scene.cy };
    const off = Math.hypot(result.x - visual.x, result.y - visual.y);
    if (off > 8 || elapsed >= 460 || !(status.smartClickLastConfidence > 0.6)) {
      failures.push(
        `${scene.scale} click (${result.x}, ${result.y}) visual (${visual.x}, ${visual.y}) off ${off.toFixed(1)} ${status.smartClickLastMethod} ${status.smartClickLastConfidence} scale ${status.smartClickLastScale} source ${status.smartClickLastSource} dHash ${status.smartClickLastDHashDistance} elapsed ${elapsed}`
      );
    }
  }
  if (failures.length) {
    throw new Error(failures.join('\n'));
  }
}, 30000);

liveMatch('Sunflower then the next harness button at 75% and at 120%', async () => {
  const { execFileSync } = require('child_process') as typeof import('child_process');
  const imageService = new ImageService('http://127.0.0.1:5001');
  expect(await imageService.healthCheck(800)).toBe(true);
  const serviceDir = '/Users/Shared/OpenClaw_Shared/Git/clicksmith-smartclick-c741/image-service';
  const python = '/Users/Shared/OpenClaw_Shared/Git/clicksmith/image-service/.venv/bin/python';
  const raw = execFileSync(
    python,
    [
      '-c',
      [
        'import json, os, sys',
        'import cv2, numpy as np',
        `sys.path.insert(0, ${JSON.stringify(serviceDir)})`,
        `os.chdir(${JSON.stringify(serviceDir)})`,
        'from tests.test_match import to_base64',
        'def button(scale, label, fill):',
        '    width = max(2, int(220 * scale))',
        '    height = max(2, int(48 * scale))',
        '    image = np.full((height, width, 3), fill, dtype=np.uint8)',
        '    cv2.rectangle(image, (1, 1), (width - 2, height - 2), (17, 24, 39), 2)',
        '    cv2.putText(image, label, (8, max(12, int(32 * scale))), cv2.FONT_HERSHEY_SIMPLEX, max(0.3, 0.7 * scale), (20, 20, 20), max(1, int(2 * scale)), cv2.LINE_AA)',
        '    return image',
        'fills = {"A": ((199, 243, 254), "Target A: Sunflower"), "B": ((229, 250, 209), "Target B: Mint"), "C": ((254, 234, 219), "Target C: Ocean"), "D": ((226, 226, 254), "Target D: Coral")}',
        'spots = {"A": (40, 110), "B": (300, 110), "C": (560, 110), "D": (40, 320)}',
        'pages = []',
        'for scale, keys in ((0.75, ["A", "D"]), (1.2, ["A", "C"])):',
        '    search = np.full((700, 980, 3), 245, dtype=np.uint8)',
        '    centers = {}',
        '    for key, (x, y) in spots.items():',
        '        img = button(scale, fills[key][1], fills[key][0])',
        '        h, w = img.shape[:2]',
        '        search[y:y + h, x:x + w] = img',
        '        centers[key] = [x + w / 2.0, y + h / 2.0]',
        '    templates = {key: to_base64(button(1.0, fills[key][1], fills[key][0])) for key in keys}',
        '    pages.append({"scale": scale, "keys": keys, "search": to_base64(search), "centers": centers, "templates": templates})',
        'print(json.dumps({"pages": pages}))',
      ].join('\n'),
    ],
    { encoding: 'utf8' }
  );
  const fixture = JSON.parse(raw) as {
    pages: Array<{
      scale: number;
      keys: string[];
      search: string;
      centers: Record<string, [number, number]>;
      templates: Record<string, string>;
    }>;
  };
  const windowOrigin = { x: 120, y: 80 };
  const windowSize = { width: 980, height: 700 };
  const recorded = {
    x: Math.round(windowOrigin.x + windowSize.width * 0.25),
    y: Math.round(windowOrigin.y + 40),
  };
  for (const page of fixture.pages) {
    const search = Buffer.from(page.search, 'base64');
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(search);
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockImplementation(async () => {
      throw new Error('full screen capture');
    });
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService,
      windowManager: {
        getTargetBounds: () => ({ ...windowOrigin, ...windowSize }),
        getTargetBoundsAsync: async () => ({ ...windowOrigin, ...windowSize }),
      } as any,
    }) as any;
    engine.config = {
      profileId: `live-harness-${page.scale}`,
      target: 'Terminal',
      useImageMatching: true,
      imageMatchThreshold: 0.6,
      timingTolerance: 20,
      retryCount: 0,
      retryDelay: 10,
      takeoverHotkey: 'F11',
      speedMultiplier: 1,
      useRelativeCoords: true,
      imageSearchRadius: 160,
    };
    engine.status = engine.createStatus('playing');
    for (const key of page.keys) {
      const patch = Buffer.from(page.templates[key], 'base64');
      const recordedHash = await computeDHash(patch);
      const started = Date.now();
      const result = await engine.resolveSmartClick(
        {
          t_ms: 0,
          type: 'mouse',
          btn: 'left',
          x: recorded.x,
          y: recorded.y,
          rel_x: 0.25,
          rel_y: 40 / windowSize.height,
          duration_ms: 0,
          human_override: false,
          img_patch_b64: patch.toString('base64'),
          metadata: { img_dhash: recordedHash, recorded_match_scale: 1 },
        },
        recorded
      );
      const elapsed = Date.now() - started;
      const status = engine.getStatus();
      const visual = {
        x: windowOrigin.x + page.centers[key][0],
        y: windowOrigin.y + page.centers[key][1],
      };
      if (Math.abs(result.x - visual.x) > 8 || Math.abs(result.y - visual.y) > 8 || elapsed >= 460) {
        captureSpy.mockRestore();
        screenSpy.mockRestore();
        throw new Error(
          `scale ${page.scale} ${key} click (${result.x}, ${result.y}) visual (${visual.x}, ${visual.y}) ${status.smartClickLastMethod} ${status.smartClickLastConfidence} scale ${status.smartClickLastScale} source ${status.smartClickLastSource} dHash ${status.smartClickLastDHashDistance} elapsed ${elapsed}`
        );
      }
    }
    captureSpy.mockRestore();
    screenSpy.mockRestore();
  }
}, 30000);

liveMatch('a second re-rendered 120% click still hits the center', async () => {
  const { execFileSync } = require('child_process') as typeof import('child_process');
  const imageService = new ImageService('http://127.0.0.1:5001');
  expect(await imageService.healthCheck(800)).toBe(true);
  const serviceDir = '/Users/Shared/OpenClaw_Shared/Git/clicksmith-smartclick-c741/image-service';
  const python = '/Users/Shared/OpenClaw_Shared/Git/clicksmith/image-service/.venv/bin/python';
  const raw = execFileSync(
    python,
    [
      '-c',
      [
        'import json, os, sys',
        'import numpy as np',
        `sys.path.insert(0, ${JSON.stringify(serviceDir)})`,
        `os.chdir(${JSON.stringify(serviceDir)})`,
        'from tests.test_match import redraw_text_button, to_base64',
        'template = redraw_text_button(1.0)',
        'button = redraw_text_button(1.2)',
        'origin = (40, 50)',
        'search = np.full((640, 640, 3), 245, dtype=np.uint8)',
        'height, width = button.shape[:2]',
        'search[origin[1]:origin[1] + height, origin[0]:origin[0] + width] = button',
        'print(json.dumps({"template": to_base64(template), "search": to_base64(search), "cx": origin[0] + width / 2.0, "cy": origin[1] + height / 2.0}))',
      ].join('\n'),
    ],
    { encoding: 'utf8' }
  );
  const fixture = JSON.parse(raw) as { template: string; search: string; cx: number; cy: number };
  const patch = Buffer.from(fixture.template, 'base64');
  const search = Buffer.from(fixture.search, 'base64');
  const recordedHash = await computeDHash(patch);
  const recorded = { x: 480, y: 400 };
  const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(search);
  const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockImplementation(async () => {
    throw new Error('full screen capture');
  });
  const engine = new PlaybackEngine({
    inputPlayer: {} as any,
    imageService,
    windowManager: { getTargetBounds: () => null, getTargetBoundsAsync: async () => null } as any,
  }) as any;
  engine.config = {
    profileId: 'live-button-1.2-again',
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
  const event = {
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
  };
  for (const label of ['first', 'second']) {
    const callsBefore = captureSpy.mock.calls.length;
    const started = Date.now();
    const result = await engine.resolveSmartClick(event, recorded);
    const elapsed = Date.now() - started;
    const status = engine.getStatus();
    const region = captureSpy.mock.calls[callsBefore]?.[0] as { x: number; y: number; width: number; height: number };
    const visual = { x: region.x + fixture.cx, y: region.y + fixture.cy };
    if (
      screenSpy.mock.calls.length !== 0 ||
      Math.abs(result.x - visual.x) > 8 ||
      Math.abs(result.y - visual.y) > 8 ||
      elapsed >= 460
    ) {
      throw new Error(
        `${label} 120% click (${result.x}, ${result.y}) visual (${visual.x}, ${visual.y}) ${status.smartClickLastMethod} ${status.smartClickLastConfidence} scale ${status.smartClickLastScale} source ${status.smartClickLastSource} dHash ${status.smartClickLastDHashDistance} elapsed ${elapsed}`
      );
    }
    expect(status.smartClickLastSource).toBe('region');
    expect(status.smartClickLastConfidence).toBeGreaterThan(0.6);
    expect(status.smartClickLastScale).toBeGreaterThanOrEqual(1.2 - 0.08);
    expect(status.smartClickLastScale).toBeLessThanOrEqual(1.2 + 0.08);
  }
  captureSpy.mockRestore();
  screenSpy.mockRestore();
}, 20000);

liveMatch('after scroll, Coral clicks its new center', async () => {
  const { execFileSync } = require('child_process') as typeof import('child_process');
  const imageService = new ImageService('http://127.0.0.1:5001');
  expect(await imageService.healthCheck(800)).toBe(true);
  const serviceDir = '/Users/Shared/OpenClaw_Shared/Git/clicksmith-smartclick-c741/image-service';
  const python = '/Users/Shared/OpenClaw_Shared/Git/clicksmith/image-service/.venv/bin/python';
  const raw = execFileSync(
    python,
    [
      '-c',
      [
        'import json, os, sys',
        'import cv2, numpy as np',
        `sys.path.insert(0, ${JSON.stringify(serviceDir)})`,
        `os.chdir(${JSON.stringify(serviceDir)})`,
        'from tests.test_match import to_base64',
        'def button(scale, label, fill):',
        '    width = max(2, int(220 * scale))',
        '    height = max(2, int(48 * scale))',
        '    image = np.full((height, width, 3), fill, dtype=np.uint8)',
        '    cv2.rectangle(image, (1, 1), (width - 2, height - 2), (17, 24, 39), 2)',
        '    cv2.putText(image, label, (8, max(12, int(32 * scale))), cv2.FONT_HERSHEY_SIMPLEX, max(0.3, 0.7 * scale), (20, 20, 20), max(1, int(2 * scale)), cv2.LINE_AA)',
        '    return image',
        'fills = {"A": ((199, 243, 254), "Target A: Sunflower"), "B": ((229, 250, 209), "Target B: Mint"), "C": ((254, 234, 219), "Target C: Ocean"), "D": ((226, 226, 254), "Target D: Coral")}',
        'spots = {"A": (40, 110), "B": (280, 110), "C": (520, 110), "D": (40, 280)}',
        'shift = 90',
        'search = np.full((600, 800, 3), 245, dtype=np.uint8)',
        'recorded = button(1.0, fills["D"][1], fills["D"][0])',
        'sample = button(0.7, fills["D"][1], fills["D"][0])',
        'h, w = sample.shape[:2]',
        'centers = {}',
        'for key, (x, y) in spots.items():',
        '    img = button(0.7, fills[key][1], fills[key][0])',
        '    ny = y - shift',
        '    if ny >= 0:',
        '        search[ny:ny + h, x:x + w] = img',
        '    centers[key] = [x + w / 2.0, ny + h / 2.0]',
        'print(json.dumps({"template": to_base64(recorded), "search": to_base64(search), "centers": centers, "recorded": [spots["D"][0] + w / 2.0, spots["D"][1] + h / 2.0]}))',
      ].join('\n'),
    ],
    { encoding: 'utf8' }
  );
  const fixture = JSON.parse(raw) as {
    template: string;
    search: string;
    centers: Record<string, [number, number]>;
    recorded: [number, number];
  };
  const patch = Buffer.from(fixture.template, 'base64');
  const search = Buffer.from(fixture.search, 'base64');
  const recordedHash = await computeDHash(patch);
  const windowOrigin = { x: 120, y: 80 };
  const recorded = {
    x: Math.round(windowOrigin.x + fixture.recorded[0]),
    y: Math.round(windowOrigin.y + fixture.recorded[1]),
  };
  const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(search);
  const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockImplementation(async () => {
    throw new Error('full screen capture');
  });
  const engine = new PlaybackEngine({
    inputPlayer: {} as any,
    imageService,
    windowManager: {
      getTargetBounds: () => ({ ...windowOrigin, width: 800, height: 600 }),
      getTargetBoundsAsync: async () => ({ ...windowOrigin, width: 800, height: 600 }),
    } as any,
  }) as any;
  engine.config = {
    profileId: 'live-scroll-coral',
    target: 'Terminal',
    useImageMatching: true,
    imageMatchThreshold: 0.6,
    timingTolerance: 20,
    retryCount: 0,
    retryDelay: 10,
    takeoverHotkey: 'F11',
    speedMultiplier: 1,
    useRelativeCoords: true,
    imageSearchRadius: 160,
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
      rel_x: fixture.recorded[0] / 800,
      rel_y: fixture.recorded[1] / 600,
      duration_ms: 0,
      human_override: false,
      img_patch_b64: patch.toString('base64'),
      metadata: { img_dhash: recordedHash, recorded_match_scale: 1 },
    },
    recorded
  );
  const elapsed = Date.now() - started;
  const status = engine.getStatus();
  captureSpy.mockRestore();
  screenSpy.mockRestore();
  const visual = {
    x: windowOrigin.x + fixture.centers.D[0],
    y: windowOrigin.y + fixture.centers.D[1],
  };
  if (Math.abs(result.x - visual.x) > 8 || Math.abs(result.y - visual.y) > 8 || elapsed >= 460) {
    throw new Error(
      `scrolled coral (${result.x}, ${result.y}) visual (${visual.x}, ${visual.y}) recorded (${recorded.x}, ${recorded.y}) ${status.smartClickLastMethod} ${status.smartClickLastConfidence} scale ${status.smartClickLastScale} source ${status.smartClickLastSource} dHash ${status.smartClickLastDHashDistance} elapsed ${elapsed}`
    );
  }
  expect(status.smartClickLastSource).toBe('window');
  expect(status.smartClickLastConfidence).toBeGreaterThan(0.6);
  expect(Math.abs(result.y - (windowOrigin.y + fixture.centers.A[1])) > 8).toBe(true);
}, 20000);

liveMatch('a re-rendered Sunflower among similar buttons clicks Sunflower', async () => {
  const { execFileSync } = require('child_process') as typeof import('child_process');
  const imageService = new ImageService('http://127.0.0.1:5001');
  expect(await imageService.healthCheck(800)).toBe(true);
  const serviceDir = '/Users/Shared/OpenClaw_Shared/Git/clicksmith-smartclick-c741/image-service';
  const python = '/Users/Shared/OpenClaw_Shared/Git/clicksmith/image-service/.venv/bin/python';
  const raw = execFileSync(
    python,
    [
      '-c',
      [
        'import json, os, sys',
        'import cv2, numpy as np',
        `sys.path.insert(0, ${JSON.stringify(serviceDir)})`,
        `os.chdir(${JSON.stringify(serviceDir)})`,
        'from tests.test_match import to_base64',
        'def button(scale, label, fill):',
        '    width = max(2, int(220 * scale))',
        '    height = max(2, int(48 * scale))',
        '    image = np.full((height, width, 3), fill, dtype=np.uint8)',
        '    cv2.rectangle(image, (1, 1), (width - 2, height - 2), (17, 24, 39), 2)',
        '    cv2.putText(image, label, (8, max(12, int(32 * scale))), cv2.FONT_HERSHEY_SIMPLEX, max(0.3, 0.7 * scale), (20, 20, 20), max(1, int(2 * scale)), cv2.LINE_AA)',
        '    return image',
        'fills = {"A": ((199, 243, 254), "Target A: Sunflower"), "B": ((229, 250, 209), "Target B: Mint"), "C": ((254, 234, 219), "Target C: Ocean"), "D": ((226, 226, 254), "Target D: Coral")}',
        'template = button(1.0, fills["A"][1], fills["A"][0])',
        'search = np.full((600, 800, 3), 245, dtype=np.uint8)',
        'spots = {"A": (40, 110), "B": (280, 110), "C": (520, 110), "D": (40, 280)}',
        'centers = {}',
        'for key, (x, y) in spots.items():',
        '    img = button(0.7, fills[key][1], fills[key][0])',
        '    h, w = img.shape[:2]',
        '    search[y:y + h, x:x + w] = img',
        '    centers[key] = [x + w / 2.0, y + h / 2.0]',
        'print(json.dumps({"template": to_base64(template), "search": to_base64(search), "centers": centers}))',
      ].join('\n'),
    ],
    { encoding: 'utf8' }
  );
  const fixture = JSON.parse(raw) as {
    template: string;
    search: string;
    centers: { A: [number, number]; B: [number, number] };
  };
  const patch = Buffer.from(fixture.template, 'base64');
  const search = Buffer.from(fixture.search, 'base64');
  const recordedHash = await computeDHash(patch);
  const windowOrigin = { x: 120, y: 80 };
  const windowSize = { width: 800, height: 600 };
  const recorded = {
    x: Math.round(windowOrigin.x + windowSize.width * 0.25),
    y: Math.round(windowOrigin.y + 40),
  };
  const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(search);
  const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockImplementation(async () => {
    throw new Error('full screen capture');
  });
  const engine = new PlaybackEngine({
    inputPlayer: {} as any,
    imageService,
    windowManager: {
      getTargetBounds: () => ({ ...windowOrigin, ...windowSize }),
      getTargetBoundsAsync: async () => ({ ...windowOrigin, ...windowSize }),
    } as any,
  }) as any;
  engine.config = {
    profileId: 'live-sunflower-0.7',
    target: 'Terminal',
    useImageMatching: true,
    imageMatchThreshold: 0.6,
    timingTolerance: 20,
    retryCount: 0,
    retryDelay: 10,
    takeoverHotkey: 'F11',
    speedMultiplier: 1,
    useRelativeCoords: true,
    imageSearchRadius: 160,
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
      rel_x: 0.25,
      rel_y: 40 / 600,
      duration_ms: 0,
      human_override: false,
      img_patch_b64: patch.toString('base64'),
      metadata: { img_dhash: recordedHash, recorded_match_scale: 1 },
    },
    recorded
  );
  const elapsed = Date.now() - started;
  const status = engine.getStatus();
  captureSpy.mockRestore();
  screenSpy.mockRestore();
  const visual = {
    x: windowOrigin.x + fixture.centers.A[0],
    y: windowOrigin.y + fixture.centers.A[1],
  };
  const mint = {
    x: windowOrigin.x + fixture.centers.B[0],
    y: windowOrigin.y + fixture.centers.B[1],
  };
  if (Math.abs(result.x - visual.x) > 8 || Math.abs(result.y - visual.y) > 8) {
    throw new Error(
      `sunflower click (${result.x}, ${result.y}) visual (${visual.x}, ${visual.y}) mint (${mint.x}, ${mint.y}) ${status.smartClickLastMethod} ${status.smartClickLastConfidence} scale ${status.smartClickLastScale} source ${status.smartClickLastSource} dHash ${status.smartClickLastDHashDistance} elapsed ${elapsed}`
    );
  }
  expect(Math.abs(result.x - mint.x) > 8 || Math.abs(result.y - mint.y) > 8).toBe(true);
  expect(status.smartClickLastSource).toBe('window');
  expect(status.smartClickLastConfidence).toBeGreaterThan(0.6);
  if (elapsed >= 460) {
    throw new Error(`sunflower click took ${elapsed}ms`);
  }
}, 20000);

liveMatch('each re-rendered harness button clicks itself, then A then C', async () => {
  const { execFileSync } = require('child_process') as typeof import('child_process');
  const imageService = new ImageService('http://127.0.0.1:5001');
  expect(await imageService.healthCheck(800)).toBe(true);
  const serviceDir = '/Users/Shared/OpenClaw_Shared/Git/clicksmith-smartclick-c741/image-service';
  const python = '/Users/Shared/OpenClaw_Shared/Git/clicksmith/image-service/.venv/bin/python';
  const raw = execFileSync(
    python,
    [
      '-c',
      [
        'import json, os, sys',
        'import cv2, numpy as np',
        `sys.path.insert(0, ${JSON.stringify(serviceDir)})`,
        `os.chdir(${JSON.stringify(serviceDir)})`,
        'from tests.test_match import to_base64',
        'def button(scale, label, fill):',
        '    width = max(2, int(220 * scale))',
        '    height = max(2, int(48 * scale))',
        '    image = np.full((height, width, 3), fill, dtype=np.uint8)',
        '    cv2.rectangle(image, (1, 1), (width - 2, height - 2), (17, 24, 39), 2)',
        '    cv2.putText(image, label, (8, max(12, int(32 * scale))), cv2.FONT_HERSHEY_SIMPLEX, max(0.3, 0.7 * scale), (20, 20, 20), max(1, int(2 * scale)), cv2.LINE_AA)',
        '    return image',
        'fills = {"A": ((199, 243, 254), "Target A: Sunflower"), "B": ((229, 250, 209), "Target B: Mint"), "C": ((254, 234, 219), "Target C: Ocean"), "D": ((226, 226, 254), "Target D: Coral")}',
        'search = np.full((600, 800, 3), 245, dtype=np.uint8)',
        'spots = {"A": (40, 110), "B": (280, 110), "C": (520, 110), "D": (40, 400)}',
        'centers = {}',
        'for key, (x, y) in spots.items():',
        '    img = button(0.7, fills[key][1], fills[key][0])',
        '    h, w = img.shape[:2]',
        '    search[y:y + h, x:x + w] = img',
        '    centers[key] = [x + w / 2.0, y + h / 2.0]',
        'templates = {key: to_base64(button(1.0, fills[key][1], fills[key][0])) for key in fills}',
        'print(json.dumps({"templates": templates, "search": to_base64(search), "centers": centers}))',
      ].join('\n'),
    ],
    { encoding: 'utf8' }
  );
  const fixture = JSON.parse(raw) as {
    templates: Record<string, string>;
    search: string;
    centers: Record<string, [number, number]>;
  };
  const search = Buffer.from(fixture.search, 'base64');
  const windowOrigin = { x: 120, y: 80 };
  const windowSize = { width: 800, height: 600 };
  const recorded = {
    x: Math.round(windowOrigin.x + windowSize.width * 0.25),
    y: Math.round(windowOrigin.y + 40),
  };
  const click = async (engine: any, key: string) => {
    const patch = Buffer.from(fixture.templates[key], 'base64');
    const recordedHash = await computeDHash(patch);
    const started = Date.now();
    const result = await engine.resolveSmartClick(
      {
        t_ms: 0,
        type: 'mouse',
        btn: 'left',
        x: recorded.x,
        y: recorded.y,
        rel_x: 0.25,
        rel_y: 40 / 600,
        duration_ms: 0,
        human_override: false,
        img_patch_b64: patch.toString('base64'),
        metadata: { img_dhash: recordedHash, recorded_match_scale: 1 },
      },
      recorded
    );
    return { result, elapsed: Date.now() - started, status: engine.getStatus() };
  };
  const makeEngine = () => {
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService,
      windowManager: {
        getTargetBounds: () => ({ ...windowOrigin, ...windowSize }),
        getTargetBoundsAsync: async () => ({ ...windowOrigin, ...windowSize }),
      } as any,
    }) as any;
    engine.config = {
      profileId: 'live-harness',
      target: 'Terminal',
      useImageMatching: true,
      imageMatchThreshold: 0.6,
      timingTolerance: 20,
      retryCount: 0,
      retryDelay: 10,
      takeoverHotkey: 'F11',
      speedMultiplier: 1,
      useRelativeCoords: true,
      imageSearchRadius: 160,
    };
    engine.status = engine.createStatus('playing');
    return engine;
  };
  for (const key of ['A', 'B', 'C', 'D']) {
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(search);
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockImplementation(async () => {
      throw new Error('full screen capture');
    });
    const engine = makeEngine();
    const { result, elapsed, status } = await click(engine, key);
    captureSpy.mockRestore();
    screenSpy.mockRestore();
    const visual = {
      x: windowOrigin.x + fixture.centers[key][0],
      y: windowOrigin.y + fixture.centers[key][1],
    };
    if (Math.abs(result.x - visual.x) > 8 || Math.abs(result.y - visual.y) > 8 || elapsed >= 460) {
      throw new Error(
        `${key} click (${result.x}, ${result.y}) visual (${visual.x}, ${visual.y}) ${status.smartClickLastMethod} ${status.smartClickLastConfidence} scale ${status.smartClickLastScale} source ${status.smartClickLastSource} dHash ${status.smartClickLastDHashDistance} elapsed ${elapsed}`
      );
    }
  }
  const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(search);
  const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockImplementation(async () => {
    throw new Error('full screen capture');
  });
  const sequence = makeEngine();
  for (const key of ['A', 'C']) {
    const { result, elapsed, status } = await click(sequence, key);
    const visual = {
      x: windowOrigin.x + fixture.centers[key][0],
      y: windowOrigin.y + fixture.centers[key][1],
    };
    if (Math.abs(result.x - visual.x) > 8 || Math.abs(result.y - visual.y) > 8 || elapsed >= 460) {
      throw new Error(
        `sequence ${key} click (${result.x}, ${result.y}) visual (${visual.x}, ${visual.y}) ${status.smartClickLastMethod} ${status.smartClickLastConfidence} scale ${status.smartClickLastScale} source ${status.smartClickLastSource} dHash ${status.smartClickLastDHashDistance} elapsed ${elapsed}`
      );
    }
  }
  captureSpy.mockRestore();
  screenSpy.mockRestore();
}, 30000);

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

liveMatch('a template miss clicks the recorded word on the text-only page', async () => {
  const { execFileSync } = require('child_process') as typeof import('child_process');
  const imageService = new ImageService('http://127.0.0.1:5001');
  expect(await imageService.healthCheck(800)).toBe(true);
  const serviceDir = '/Users/Shared/OpenClaw_Shared/Git/clicksmith-smartclick-c741/image-service';
  const python = '/Users/Shared/OpenClaw_Shared/Git/clicksmith/image-service/.venv/bin/python';
  const raw = execFileSync(
    python,
    [
      '-c',
      [
        'import json, os, sys',
        'import cv2, numpy as np',
        `sys.path.insert(0, ${JSON.stringify(serviceDir)})`,
        `os.chdir(${JSON.stringify(serviceDir)})`,
        'from tests.test_match import to_base64',
        'page = np.full((600, 800, 3), 245, dtype=np.uint8)',
        'cv2.putText(page, "Target A: Sunflower Target B: Mint Target C: Ocean", (48, 142), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (20, 20, 20), 2, cv2.LINE_AA)',
        'cv2.putText(page, "Target D: Coral", (48, 312), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (20, 20, 20), 2, cv2.LINE_AA)',
        'print(json.dumps({"search": to_base64(page)}))',
      ].join('\n'),
    ],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
  );
  const search = Buffer.from((JSON.parse(raw) as { search: string }).search, 'base64');
  const ocr = await imageService.ocrImage({ image: search.toString('base64'), timeoutMs: 800 });
  const wordCenter = (label: string) => {
    const item = (ocr.items ?? []).find(entry => entry.text.trim().toLowerCase() === label);
    if (!item) return null;
    return {
      x: item.bounds.x + item.bounds.width / 2,
      y: item.bounds.y + item.bounds.height / 2,
    };
  };
  const sunflower = wordCenter('sunflower');
  const coral = wordCenter('coral');
  expect(sunflower).toBeTruthy();
  expect(coral).toBeTruthy();
  const windowOrigin = { x: 120, y: 80 };
  const windowSize = { width: 800, height: 600 };
  const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(search);
  const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockImplementation(async () => {
    throw new Error('full screen capture');
  });
  const patch = await patternPng(96);
  const recordedLocal = { x: 200, y: 40 };
  const cases = [
    { key: 'A', text: 'target a sunflower', word: sunflower! },
    { key: 'D', text: 'target d coral', word: coral! },
  ];
  for (const entry of cases) {
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService,
      windowManager: {
        getTargetBounds: () => ({ ...windowOrigin, ...windowSize }),
        getTargetBoundsAsync: async () => ({ ...windowOrigin, ...windowSize }),
      } as any,
    }) as any;
    engine.config = {
      profileId: `live-word-${entry.key}`,
      target: 'Terminal',
      useImageMatching: true,
      imageMatchThreshold: 0.6,
      timingTolerance: 20,
      retryCount: 0,
      retryDelay: 10,
      takeoverHotkey: 'F11',
      speedMultiplier: 1,
      useRelativeCoords: true,
      imageSearchRadius: 160,
    };
    engine.status = engine.createStatus('playing');
    const recorded = {
      x: windowOrigin.x + recordedLocal.x,
      y: windowOrigin.y + recordedLocal.y,
    };
    const started = Date.now();
    const result = await engine.resolveSmartClick(
      {
        t_ms: 0,
        type: 'mouse',
        btn: 'left',
        x: recorded.x,
        y: recorded.y,
        rel_x: recordedLocal.x / windowSize.width,
        rel_y: recordedLocal.y / windowSize.height,
        duration_ms: 0,
        human_override: false,
        img_patch_b64: patch.toString('base64'),
        metadata: {
          ocr_primary_text_normalized: entry.text,
          ocr_anchor_norm_x: 0.4,
          ocr_anchor_norm_y: -0.4,
        },
      },
      recorded
    );
    const elapsed = Date.now() - started;
    const status = engine.getStatus();
    const visual = {
      x: windowOrigin.x + entry.word.x,
      y: windowOrigin.y + entry.word.y,
    };
    const off = Math.hypot(result.x - visual.x, result.y - visual.y);
    if (
      off > 8 ||
      elapsed >= 460 ||
      status.smartClickLastMethod !== 'ocr' ||
      !(status.smartClickLastConfidence > 0.6) ||
      status.smartClickLastSource !== 'window'
    ) {
      captureSpy.mockRestore();
      screenSpy.mockRestore();
      throw new Error(
        `${entry.key} click (${result.x}, ${result.y}) word (${visual.x}, ${visual.y}) off ${off.toFixed(1)} ${status.smartClickLastMethod} ${status.smartClickLastConfidence} source ${status.smartClickLastSource} elapsed ${elapsed}`
      );
    }
  }
  captureSpy.mockRestore();
  screenSpy.mockRestore();
}, 30000);

liveMatch('a recorded small label still clicks that word when the button is gone', async () => {
  const { execFileSync } = require('child_process') as typeof import('child_process');
  const imageService = new ImageService('http://127.0.0.1:5001');
  expect(await imageService.healthCheck(800)).toBe(true);
  const serviceDir = '/Users/Shared/OpenClaw_Shared/Git/clicksmith-smartclick-c741/image-service';
  const python = '/Users/Shared/OpenClaw_Shared/Git/clicksmith/image-service/.venv/bin/python';
  const raw = execFileSync(
    python,
    [
      '-c',
      [
        'import json, os, sys',
        'import cv2, numpy as np',
        `sys.path.insert(0, ${JSON.stringify(serviceDir)})`,
        `os.chdir(${JSON.stringify(serviceDir)})`,
        'from tests.test_match import to_base64',
        'def button(label, fill):',
        '    image = np.full((48, 220, 3), fill, dtype=np.uint8)',
        '    cv2.rectangle(image, (1, 1), (218, 46), (17, 24, 39), 2)',
        '    cv2.putText(image, label, (8, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (20, 20, 20), 2, cv2.LINE_AA)',
        '    return image',
        'spots = {"A": (40, 110), "B": (280, 110), "C": (520, 110), "D": (40, 280)}',
        'labels = {"A": ((199, 243, 254), "Target A: Sunflower"), "B": ((229, 250, 209), "Target B: Mint"), "C": ((254, 234, 219), "Target C: Ocean"), "D": ((226, 226, 254), "Target D: Coral")}',
        'page = np.full((600, 800, 3), 245, dtype=np.uint8)',
        'text = np.full((600, 800, 3), 245, dtype=np.uint8)',
        'for key, (x, y) in spots.items():',
        '    img = button(labels[key][1], labels[key][0])',
        '    page[y:y + 48, x:x + 220] = img',
        '    cv2.putText(text, labels[key][1], (x + 8, y + 32), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (20, 20, 20), 2, cv2.LINE_AA)',
        'crops = {}',
        'for key in ("B", "C"):',
        '    x, y = spots[key]',
        '    cx, cy = x + 110, y + 24',
        '    half = 192',
        '    crop = np.full((384, 384, 3), 245, dtype=np.uint8)',
        '    x0, y0 = max(0, cx - half), max(0, cy - half)',
        '    x1, y1 = min(800, cx + half), min(600, cy + half)',
        '    dx, dy = x0 - (cx - half), y0 - (cy - half)',
        '    crop[dy:dy + (y1 - y0), dx:dx + (x1 - x0)] = page[y0:y1, x0:x1]',
        '    crops[key] = to_base64(crop)',
        'print(json.dumps({"text": to_base64(text), "crops": crops}))',
      ].join('\n'),
    ],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
  );
  const fixture = JSON.parse(raw) as { text: string; crops: Record<string, string> };
  const search = Buffer.from(fixture.text, 'base64');
  const pageOcr = await imageService.ocrImage({ image: search.toString('base64'), timeoutMs: 800 });
  const wordCenter = (label: string) => {
    const item = (pageOcr.items ?? []).find(entry => entry.text.trim().toLowerCase() === label);
    if (!item) return null;
    return {
      x: item.bounds.x + item.bounds.width / 2,
      y: item.bounds.y + item.bounds.height / 2,
    };
  };
  const windowOrigin = { x: 120, y: 80 };
  const windowSize = { width: 800, height: 600 };
  const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(search);
  const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockImplementation(async () => {
    throw new Error('full screen capture');
  });
  const patch = await patternPng(96);
  const recordedLocal = { x: 200, y: 40 };
  for (const entry of [
    { key: 'B', word: 'mint' },
    { key: 'C', word: 'ocean' },
  ]) {
    const cropOcr = await imageService.ocrImage({ image: fixture.crops[entry.key], timeoutMs: 800 });
    let recordedText = '';
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const item of cropOcr.items ?? []) {
      const text = item.text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
      if (text.length < 2 || !text.includes(' ')) continue;
      const bounds = item.bounds;
      const contains = 192 >= bounds.x && 192 <= bounds.x + bounds.width && 192 >= bounds.y && 192 <= bounds.y + bounds.height;
      const dist = Math.hypot(bounds.x + bounds.width / 2 - 192, bounds.y + bounds.height / 2 - 192);
      const score = (contains ? 2000 : 0) + Math.max(0, 300 - dist) + Math.max(0, item.confidence);
      if (score > bestScore) {
        bestScore = score;
        recordedText = text;
      }
    }
    const center = wordCenter(entry.word);
    if (!recordedText.includes(entry.word) || !center) {
      captureSpy.mockRestore();
      screenSpy.mockRestore();
      throw new Error(`${entry.key} recorded ${JSON.stringify(recordedText)} center ${JSON.stringify(center)}`);
    }
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService,
      windowManager: {
        getTargetBounds: () => ({ ...windowOrigin, ...windowSize }),
        getTargetBoundsAsync: async () => ({ ...windowOrigin, ...windowSize }),
      } as any,
    }) as any;
    engine.config = {
      profileId: `live-small-label-${entry.key}`,
      target: 'Terminal',
      useImageMatching: true,
      imageMatchThreshold: 0.6,
      timingTolerance: 20,
      retryCount: 0,
      retryDelay: 10,
      takeoverHotkey: 'F11',
      speedMultiplier: 1,
      useRelativeCoords: true,
      imageSearchRadius: 160,
    };
    engine.status = engine.createStatus('playing');
    const recorded = {
      x: windowOrigin.x + recordedLocal.x,
      y: windowOrigin.y + recordedLocal.y,
    };
    const started = Date.now();
    const result = await engine.resolveSmartClick(
      {
        t_ms: 0,
        type: 'mouse',
        btn: 'left',
        x: recorded.x,
        y: recorded.y,
        rel_x: recordedLocal.x / windowSize.width,
        rel_y: recordedLocal.y / windowSize.height,
        duration_ms: 0,
        human_override: false,
        img_patch_b64: patch.toString('base64'),
        metadata: {
          ocr_primary_text_normalized: recordedText,
          ocr_anchor_norm_x: 0.4,
          ocr_anchor_norm_y: -0.4,
        },
      },
      recorded
    );
    const elapsed = Date.now() - started;
    const status = engine.getStatus();
    const visual = { x: windowOrigin.x + center.x, y: windowOrigin.y + center.y };
    const off = Math.hypot(result.x - visual.x, result.y - visual.y);
    if (
      off > 8 ||
      elapsed >= 460 ||
      status.smartClickLastMethod !== 'ocr' ||
      !(status.smartClickLastConfidence > 0.6) ||
      status.smartClickLastSource !== 'window'
    ) {
      captureSpy.mockRestore();
      screenSpy.mockRestore();
      throw new Error(
        `${entry.key} recorded ${JSON.stringify(recordedText)} click (${result.x}, ${result.y}) word (${visual.x}, ${visual.y}) off ${off.toFixed(1)} ${status.smartClickLastMethod} ${status.smartClickLastConfidence} source ${status.smartClickLastSource} elapsed ${elapsed}`
      );
    }
  }
  captureSpy.mockRestore();
  screenSpy.mockRestore();
}, 30000);
