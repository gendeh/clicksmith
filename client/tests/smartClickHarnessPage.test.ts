import path from 'path';
import { PlaybackEngine } from '../src/main/playbackEngine';
import { computeDHash } from '../src/main/imageHash';
import { ImageService } from '../src/services/imageService';
import * as screenCapture from '../src/main/screenCapture';

const liveMatch = process.env.CLICKSMITH_LIVE_MATCH === '1' ? test : test.skip;

const recordedFile = path.join(__dirname, 'fixtures/harness-100.png');
const zoomedFile = path.join(__dirname, 'fixtures/harness-70.png');
const recordedBox = { x: 75, y: 154.96875, w: 199.640625, h: 51.796875 };
const zoomedBox = { x: 217.796875, y: 108.734375, w: 138.9375, h: 35.4375 };

function center(box: { x: number; y: number; w: number; h: number }) {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

liveMatch('a zoomed harness label still clicks Sunflower when the patch misses', async () => {
  const fs = require('fs') as typeof import('fs');
  const sharp = require('sharp');
  const imageService = new ImageService('http://127.0.0.1:5001');
  expect(await imageService.healthCheck(800)).toBe(true);
  const recordedPng = await fs.promises.readFile(recordedFile);
  const zoomedPng = await fs.promises.readFile(zoomedFile);
  const point = center(recordedBox);
  const size = 384;
  const left = Math.round(point.x - size / 2);
  const top = Math.round(point.y - size / 2);
  const meta = await sharp(recordedPng).metadata();
  const frameW = meta.width ?? 1100;
  const frameH = meta.height ?? 800;
  const extractLeft = Math.max(0, left);
  const extractTop = Math.max(0, top);
  const extractRight = Math.min(frameW, left + size);
  const extractBottom = Math.min(frameH, top + size);
  const extracted = await sharp(recordedPng)
    .extract({
      left: extractLeft,
      top: extractTop,
      width: extractRight - extractLeft,
      height: extractBottom - extractTop,
    })
    .png()
    .toBuffer();
  const context = await sharp({
    create: { width: size, height: size, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .composite([{ input: extracted, left: extractLeft - left, top: extractTop - top }])
    .png()
    .toBuffer();
  const cropOcr = await imageService.ocrImage({ image: context.toString('base64'), timeoutMs: 900 });
  const click = size / 2;
  let recordedText = '';
  let anchorX = 0;
  let anchorY = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const item of cropOcr.items ?? []) {
    const text = item.text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length < 2) continue;
    const bounds = item.bounds;
    const contains =
      click >= bounds.x &&
      click <= bounds.x + bounds.width &&
      click >= bounds.y &&
      click <= bounds.y + bounds.height;
    const dist = Math.hypot(bounds.x + bounds.width / 2 - click, bounds.y + bounds.height / 2 - click);
    const score = (contains ? 2000 : 0) + Math.max(0, 300 - dist) + Math.max(0, item.confidence);
    if (score > bestScore) {
      bestScore = score;
      recordedText = text;
      anchorX = bounds.width > 0 ? (click - (bounds.x + bounds.width / 2)) / bounds.width : 0;
      anchorY = bounds.height > 0 ? (click - (bounds.y + bounds.height / 2)) / bounds.height : 0;
    }
  }
  const patch = await sharp({
    create: { width: 96, height: 96, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
  const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(zoomedPng);
  const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockImplementation(async () => {
    throw new Error('full screen capture');
  });
  const windowSize = { width: 1100, height: 800 };
  const engine = new PlaybackEngine({
    inputPlayer: {} as any,
    imageService,
    windowManager: {
      getTargetBounds: () => ({ x: 0, y: 0, ...windowSize }),
      getTargetBoundsAsync: async () => ({ x: 0, y: 0, ...windowSize }),
    } as any,
  }) as any;
  engine.config = {
    profileId: 'live-harness-ocr',
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
  const recorded = { x: point.x, y: point.y };
  const started = Date.now();
  const result = await engine.resolveSmartClick(
    {
      t_ms: 0,
      type: 'mouse',
      btn: 'left',
      x: recorded.x,
      y: recorded.y,
      rel_x: recorded.x / windowSize.width,
      rel_y: recorded.y / windowSize.height,
      duration_ms: 0,
      human_override: false,
      img_patch_b64: patch.toString('base64'),
      metadata: {
        ocr_primary_text_normalized: recordedText,
        ocr_anchor_norm_x: anchorX,
        ocr_anchor_norm_y: anchorY,
      },
    },
    recorded
  );
  const elapsed = Date.now() - started;
  const status = engine.getStatus();
  captureSpy.mockRestore();
  screenSpy.mockRestore();
  const visual = center(zoomedBox);
  const off = Math.hypot(result.x - visual.x, result.y - visual.y);
  if (
    recordedText !== 'sunflower' ||
    off > 8 ||
    elapsed >= 460 ||
    status.smartClickLastMethod !== 'ocr' ||
    !(status.smartClickLastConfidence > 0.6) ||
    status.smartClickLastSource !== 'window'
  ) {
    throw new Error(
      `recorded ${JSON.stringify(recordedText)} click (${result.x}, ${result.y}) button (${visual.x.toFixed(1)}, ${visual.y.toFixed(1)}) off ${off.toFixed(1)} ${status.smartClickLastMethod} ${status.smartClickLastConfidence} source ${status.smartClickLastSource} elapsed ${elapsed}`
    );
  }
}, 30000);

const eightyFile = path.join(__dirname, 'fixtures/harness-80.png');
const eightyBox = { x: 170.1875, y: 124.125, w: 158.5, h: 40.21875 };

liveMatch('an eighty percent harness page clicks the recorded Sunflower patch', async () => {
  const fs = require('fs') as typeof import('fs');
  const sharp = require('sharp');
  const imageService = new ImageService('http://127.0.0.1:5001');
  expect(await imageService.healthCheck(800)).toBe(true);
  const recordedPng = await fs.promises.readFile(recordedFile);
  const zoomedPng = await fs.promises.readFile(eightyFile);
  const meta = await sharp(zoomedPng).metadata();
  const frameW = meta.width ?? 1100;
  const frameH = meta.height ?? 800;
  const point = center(recordedBox);
  const size = 128;
  const left = Math.max(0, Math.round(point.x - size / 2));
  const top = Math.max(0, Math.round(point.y - size / 2));
  const patch = await sharp(recordedPng).extract({ left, top, width: size, height: size }).png().toBuffer();
  const recordedHash = await computeDHash(patch);
  const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockImplementation(async (region) => {
    const extractLeft = Math.max(0, Math.min(frameW - 1, Math.round(region.x)));
    const extractTop = Math.max(0, Math.min(frameH - 1, Math.round(region.y)));
    const width = Math.max(1, Math.min(frameW - extractLeft, Math.round(region.width)));
    const height = Math.max(1, Math.min(frameH - extractTop, Math.round(region.height)));
    return sharp(zoomedPng).extract({ left: extractLeft, top: extractTop, width, height }).png().toBuffer();
  });
  const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockImplementation(async () => {
    throw new Error('full screen capture');
  });
  const engine = new PlaybackEngine({
    inputPlayer: {} as any,
    imageService,
    windowManager: {
      getTargetBounds: () => ({ x: 0, y: 0, width: frameW, height: frameH }),
      getTargetBoundsAsync: async () => ({ x: 0, y: 0, width: frameW, height: frameH }),
    } as any,
  }) as any;
  engine.config = {
    profileId: 'live-harness-80',
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
      x: point.x,
      y: point.y,
      rel_x: point.x / frameW,
      rel_y: point.y / frameH,
      duration_ms: 0,
      human_override: false,
      img_patch_b64: patch.toString('base64'),
      metadata: { img_dhash: recordedHash },
    },
    point
  );
  const elapsed = Date.now() - started;
  const status = engine.getStatus();
  captureSpy.mockRestore();
  screenSpy.mockRestore();
  const visual = center(eightyBox);
  const off = Math.hypot(result.x - visual.x, result.y - visual.y);
  if (
    off > 8 ||
    elapsed >= 460 ||
    status.smartClickLastMethod !== 'template' ||
    !(status.smartClickLastConfidence > 0.6) ||
    status.smartClickLastSource !== 'window'
  ) {
    throw new Error(
      `click (${result.x}, ${result.y}) button (${visual.x.toFixed(1)}, ${visual.y.toFixed(1)}) off ${off.toFixed(1)} ${status.smartClickLastMethod} ${status.smartClickLastConfidence} source ${status.smartClickLastSource} elapsed ${elapsed}`
    );
  }
}, 30000);

const oneTwentyFile = path.join(__dirname, 'fixtures/harness-120.png');
const oneTwentyClicks = [
  {
    name: 'coral',
    recorded: { x: 572, y: 154.96875, w: 161.546875, h: 51.796875 },
    visual: { x: 642.984375, y: 185.75, w: 193.046875, h: 61.34375 },
  },
  {
    name: 'ocean',
    recorded: { x: 75, y: 222.765625, w: 170.0625, h: 51.796875 },
    visual: { x: 46.59375, y: 266.28125, w: 203.265625, h: 61.34375 },
  },
];

liveMatch('a one hundred twenty percent harness page clicks the recorded Coral and Ocean patches', async () => {
  const fs = require('fs') as typeof import('fs');
  const sharp = require('sharp');
  const imageService = new ImageService('http://127.0.0.1:5001');
  expect(await imageService.healthCheck(800)).toBe(true);
  const recordedPng = await fs.promises.readFile(recordedFile);
  const zoomedPng = await fs.promises.readFile(oneTwentyFile);
  const meta = await sharp(zoomedPng).metadata();
  const frameW = meta.width ?? 1100;
  const frameH = meta.height ?? 800;
  const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockImplementation(async (region) => {
    const extractLeft = Math.max(0, Math.min(frameW - 1, Math.round(region.x)));
    const extractTop = Math.max(0, Math.min(frameH - 1, Math.round(region.y)));
    const width = Math.max(1, Math.min(frameW - extractLeft, Math.round(region.width)));
    const height = Math.max(1, Math.min(frameH - extractTop, Math.round(region.height)));
    return sharp(zoomedPng).extract({ left: extractLeft, top: extractTop, width, height }).png().toBuffer();
  });
  const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockImplementation(async () => {
    throw new Error('full screen capture');
  });
  const engine = new PlaybackEngine({
    inputPlayer: {} as any,
    imageService,
    windowManager: {
      getTargetBounds: () => ({ x: 0, y: 0, width: frameW, height: frameH }),
      getTargetBoundsAsync: async () => ({ x: 0, y: 0, width: frameW, height: frameH }),
    } as any,
  }) as any;
  engine.config = {
    profileId: 'live-harness-120',
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
  try {
    for (const item of oneTwentyClicks) {
      const point = center(item.recorded);
      const size = 128;
      const left = Math.max(0, Math.round(point.x - size / 2));
      const top = Math.max(0, Math.round(point.y - size / 2));
      const patch = await sharp(recordedPng).extract({ left, top, width: size, height: size }).png().toBuffer();
      const recordedHash = await computeDHash(patch);
      const started = Date.now();
      const result = await engine.resolveSmartClick(
        {
          t_ms: 0,
          type: 'mouse',
          btn: 'left',
          x: point.x,
          y: point.y,
          rel_x: point.x / frameW,
          rel_y: point.y / frameH,
          duration_ms: 0,
          human_override: false,
          img_patch_b64: patch.toString('base64'),
          metadata: { img_dhash: recordedHash },
        },
        point
      );
      const elapsed = Date.now() - started;
      const status = engine.getStatus();
      const visual = center(item.visual);
      const off = Math.hypot(result.x - visual.x, result.y - visual.y);
      if (
        off > 8 ||
        elapsed >= 460 ||
        status.smartClickLastMethod !== 'template' ||
        !(status.smartClickLastConfidence > 0.6) ||
        status.smartClickLastSource !== 'window'
      ) {
        throw new Error(
          `${item.name} click (${result.x}, ${result.y}) button (${visual.x.toFixed(1)}, ${visual.y.toFixed(1)}) off ${off.toFixed(1)} ${status.smartClickLastMethod} ${status.smartClickLastConfidence} source ${status.smartClickLastSource} elapsed ${elapsed}`
        );
      }
    }
  } finally {
    captureSpy.mockRestore();
    screenSpy.mockRestore();
  }
}, 30000);
