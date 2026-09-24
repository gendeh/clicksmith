import path from 'path';
import { PlaybackEngine } from '../src/main/playbackEngine';
import { ImageService } from '../src/services/imageService';
import * as screenCapture from '../src/main/screenCapture';

const liveMatch = process.env.CLICKSMITH_LIVE_MATCH === '1' ? test : test.skip;

const zoomedFile = path.join(__dirname, 'fixtures/harness-70.png');
const recordedBox = { x: 572, y: 154.96875, w: 161.546875, h: 51.796875 };
const zoomedBox = { x: 565.6875, y: 108.734375, w: 112.265625, h: 35.4375 };
const scrollPx = 400;

function center(box: { x: number; y: number; w: number; h: number }) {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

liveMatch('a scrolled Coral word still clicks when the patch misses', async () => {
  const fs = require('fs') as typeof import('fs');
  const sharp = require('sharp');
  const imageService = new ImageService('http://127.0.0.1:5001');
  expect(await imageService.healthCheck(800)).toBe(true);
  const zoomedPng = await fs.promises.readFile(zoomedFile);
  const meta = await sharp(zoomedPng).metadata();
  const frameW = meta.width ?? 1100;
  const frameH = meta.height ?? 800;
  const shifted = await sharp({
    create: { width: frameW, height: frameH, channels: 3, background: { r: 245, g: 247, b: 251 } },
  })
    .composite([{ input: zoomedPng, left: 0, top: scrollPx }])
    .png()
    .toBuffer();
  const patch = await sharp({
    create: { width: 128, height: 128, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
  const point = center(recordedBox);
  const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockImplementation(async (region) => {
    const left = Math.max(0, Math.min(frameW - 1, Math.round(region.x)));
    const top = Math.max(0, Math.min(frameH - 1, Math.round(region.y)));
    const width = Math.max(1, Math.min(frameW - left, Math.round(region.width)));
    const height = Math.max(1, Math.min(frameH - top, Math.round(region.height)));
    return sharp(shifted).extract({ left, top, width, height }).png().toBuffer();
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
    profileId: 'live-scrolled-coral',
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
      metadata: {
        ocr_primary_text_normalized: 'coral',
        ocr_anchor_norm_x: 0,
        ocr_anchor_norm_y: 0,
      },
    },
    point
  );
  const elapsed = Date.now() - started;
  const status = engine.getStatus();
  captureSpy.mockRestore();
  screenSpy.mockRestore();
  const box = {
    x: zoomedBox.x,
    y: zoomedBox.y + scrollPx,
    w: zoomedBox.w,
    h: zoomedBox.h,
  };
  const inside =
    result.x >= box.x - 8 &&
    result.x <= box.x + box.w + 8 &&
    result.y >= box.y - 8 &&
    result.y <= box.y + box.h + 8;
  if (!inside || elapsed >= 460 || status.smartClickLastMethod !== 'ocr' || !(status.smartClickLastConfidence > 0.6) || status.smartClickLastSource !== 'window') {
    throw new Error(
      `click (${result.x}, ${result.y}) button (${box.x.toFixed(1)}, ${box.y.toFixed(1)}, ${box.w.toFixed(1)}x${box.h.toFixed(1)}) ${status.smartClickLastMethod} ${status.smartClickLastConfidence} source ${status.smartClickLastSource} elapsed ${elapsed}`
    );
  }
}, 30000);
