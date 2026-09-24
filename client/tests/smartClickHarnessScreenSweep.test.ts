import fs from 'fs';
import path from 'path';
import { PlaybackEngine } from '../src/main/playbackEngine';
import { computeDHash } from '../src/main/imageHash';
import { ImageService } from '../src/services/imageService';
import * as screenCapture from '../src/main/screenCapture';

const liveMatch = process.env.CLICKSMITH_LIVE_MATCH === '1' ? test : test.skip;

const recordedFile = path.join(__dirname, 'fixtures/harness-100.png');

function center(box: { x: number; y: number; w: number; h: number }) {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

const recordedButtons = [
  { name: 'sunflower', text: 'target a sunflower', box: { x: 75, y: 154.96875, w: 199.640625, h: 51.796875 } },
  { name: 'mint', text: 'target b mint', box: { x: 289.09375, y: 154.96875, w: 153.015625, h: 51.796875 } },
  { name: 'ocean', text: 'target c ocean', box: { x: 75, y: 222.765625, w: 170.0625, h: 51.796875 } },
  { name: 'coral', text: 'target d coral', box: { x: 572, y: 154.96875, w: 161.546875, h: 51.796875 } },
];

const pages = [
  {
    zoom: '70',
    file: 'harness-70.png',
    boxes: {
      sunflower: { x: 217.796875, y: 108.734375, w: 138.9375, h: 35.4375 },
      mint: { x: 366.859375, y: 108.734375, w: 106.3125, h: 35.4375 },
      ocean: { x: 217.796875, y: 155.359375, w: 118.234375, h: 35.4375 },
      coral: { x: 565.6875, y: 108.734375, w: 112.265625, h: 35.4375 },
    },
  },
  {
    zoom: '80',
    file: 'harness-80.png',
    boxes: {
      sunflower: { x: 170.1875, y: 124.125, w: 158.5, h: 40.21875 },
      mint: { x: 340.25, y: 124.125, w: 121.203125, h: 40.21875 },
      ocean: { x: 170.1875, y: 177.125, w: 134.828125, h: 40.21875 },
      coral: { x: 567.78125, y: 124.125, w: 128.015625, h: 40.21875 },
    },
  },
  {
    zoom: '120',
    file: 'harness-120.png',
    boxes: {
      sunflower: { x: 46.59375, y: 185.75, w: 238.75, h: 61.34375 },
      mint: { x: 302.6875, y: 185.75, w: 182.8125, h: 61.34375 },
      ocean: { x: 46.59375, y: 266.28125, w: 203.265625, h: 61.34375 },
      coral: { x: 642.984375, y: 185.75, w: 193.046875, h: 61.34375 },
    },
  },
  {
    zoom: '140',
    file: 'harness-140.png',
    boxes: {
      sunflower: { x: 84.59375, y: 216.5625, w: 277.875, h: 70.90625 },
      mint: { x: 382.703125, y: 216.5625, w: 212.609375, h: 70.90625 },
      ocean: { x: 84.59375, y: 309.84375, w: 236.46875, h: 70.90625 },
      coral: { x: 780.390625, y: 216.5625, w: 224.53125, h: 70.90625 },
    },
  },
];

liveMatch('a screen target clicks each harness button from 70 to 140 percent', async () => {
  const sharp = require('sharp');
  const imageService = new ImageService('http://127.0.0.1:5001');
  expect(await imageService.healthCheck(800)).toBe(true);
  const recordedPng = await fs.promises.readFile(recordedFile);
  const misses: string[] = [];
  for (const page of pages) {
    const pagePng = await fs.promises.readFile(path.join(__dirname, 'fixtures', page.file));
    const meta = await sharp(pagePng).metadata();
    const frameW = meta.width ?? 1;
    const frameH = meta.height ?? 1;
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockImplementation(async (region) => {
      const extractLeft = Math.max(0, Math.min(frameW - 1, Math.round(region.x)));
      const extractTop = Math.max(0, Math.min(frameH - 1, Math.round(region.y)));
      const width = Math.max(1, Math.min(frameW - extractLeft, Math.round(region.width)));
      const height = Math.max(1, Math.min(frameH - extractTop, Math.round(region.height)));
      return sharp(pagePng).extract({ left: extractLeft, top: extractTop, width, height }).png().toBuffer();
    });
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(pagePng);
    try {
      for (const button of recordedButtons) {
        const point = center(button.box);
        const seen = center(page.boxes[button.name as keyof typeof page.boxes]);
        const patch = await sharp(recordedPng)
          .extract({
            left: Math.max(0, Math.round(point.x - 64)),
            top: Math.max(0, Math.round(point.y - 64)),
            width: 128,
            height: 128,
          })
          .png()
          .toBuffer();
        const recordedHash = await computeDHash(patch);
        const engine = new PlaybackEngine({
          inputPlayer: {} as any,
          imageService,
          windowManager: {
            getTargetBounds: () => null,
            getTargetBoundsAsync: async () => null,
          } as any,
        }) as any;
        engine.config = {
          profileId: `live-screen-${page.zoom}-${button.name}`,
          target: 'screen',
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
        screenSpy.mockClear();
        const started = Date.now();
        const result = await engine.resolveSmartClick(
          {
            t_ms: 0,
            type: 'mouse',
            btn: 'left',
            x: point.x,
            y: point.y,
            rel_x: 0,
            rel_y: 0,
            duration_ms: 0,
            human_override: false,
            img_patch_b64: patch.toString('base64'),
            metadata: {
              img_dhash: recordedHash,
              recorded_match_scale: 1,
              ocr_primary_text_normalized: button.text,
            },
          },
          point
        );
        const elapsed = Date.now() - started;
        const status = engine.getStatus();
        const off = Math.hypot(result.x - seen.x, result.y - seen.y);
        if (
          off > 8 ||
          elapsed >= 460 ||
          !(status.smartClickLastConfidence > 0.6) ||
          (status.smartClickLastSource !== 'region' && status.smartClickLastSource !== 'fullscreen')
        ) {
          misses.push(
            `${page.zoom} ${button.name} click (${result.x.toFixed(1)}, ${result.y.toFixed(1)}) visual (${seen.x.toFixed(1)}, ${seen.y.toFixed(1)}) off ${off.toFixed(1)} ${status.smartClickLastMethod} ${status.smartClickLastConfidence} scale ${status.smartClickLastScale} source ${status.smartClickLastSource} elapsed ${elapsed} screen ${screenSpy.mock.calls.length}`
          );
        }
      }
    } finally {
      captureSpy.mockRestore();
      screenSpy.mockRestore();
    }
  }
  if (misses.length) throw new Error(misses.join('\n'));
}, 120000);

liveMatch('a named window clicks each harness button from 70 to 140 percent', async () => {
  const sharp = require('sharp');
  const imageService = new ImageService('http://127.0.0.1:5001');
  expect(await imageService.healthCheck(800)).toBe(true);
  const recordedPng = await fs.promises.readFile(recordedFile);
  const recordedMeta = await sharp(recordedPng).metadata();
  const recordedW = recordedMeta.width ?? 1100;
  const recordedH = recordedMeta.height ?? 800;
  const misses: string[] = [];
  for (const page of pages) {
    const pagePng = await fs.promises.readFile(path.join(__dirname, 'fixtures', page.file));
    const meta = await sharp(pagePng).metadata();
    const frameW = meta.width ?? 1;
    const frameH = meta.height ?? 1;
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockImplementation(async (region) => {
      const extractLeft = Math.max(0, Math.min(frameW - 1, Math.round(region.x)));
      const extractTop = Math.max(0, Math.min(frameH - 1, Math.round(region.y)));
      const width = Math.max(1, Math.min(frameW - extractLeft, Math.round(region.width)));
      const height = Math.max(1, Math.min(frameH - extractTop, Math.round(region.height)));
      return sharp(pagePng).extract({ left: extractLeft, top: extractTop, width, height }).png().toBuffer();
    });
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockImplementation(async () => {
      throw new Error('full screen capture');
    });
    try {
      for (const button of recordedButtons) {
        const point = center(button.box);
        const seen = center(page.boxes[button.name as keyof typeof page.boxes]);
        const patch = await sharp(recordedPng)
          .extract({
            left: Math.max(0, Math.round(point.x - 64)),
            top: Math.max(0, Math.round(point.y - 64)),
            width: 128,
            height: 128,
          })
          .png()
          .toBuffer();
        const recordedHash = await computeDHash(patch);
        const engine = new PlaybackEngine({
          inputPlayer: {} as any,
          imageService,
          windowManager: {
            getTargetBounds: () => ({ x: 0, y: 0, width: frameW, height: frameH }),
            getTargetBoundsAsync: async () => ({ x: 0, y: 0, width: frameW, height: frameH }),
          } as any,
        }) as any;
        engine.config = {
          profileId: `live-window-${page.zoom}-${button.name}`,
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
            rel_x: point.x / recordedW,
            rel_y: point.y / recordedH,
            duration_ms: 0,
            human_override: false,
            img_patch_b64: patch.toString('base64'),
            metadata: {
              img_dhash: recordedHash,
              recorded_match_scale: 1,
              ocr_primary_text_normalized: button.text,
            },
          },
          point
        );
        const elapsed = Date.now() - started;
        const status = engine.getStatus();
        const off = Math.hypot(result.x - seen.x, result.y - seen.y);
        if (
          off > 8 ||
          elapsed >= 460 ||
          !(status.smartClickLastConfidence > 0.6) ||
          status.smartClickLastSource !== 'window' ||
          screenSpy.mock.calls.length !== 0
        ) {
          misses.push(
            `${page.zoom} ${button.name} click (${result.x.toFixed(1)}, ${result.y.toFixed(1)}) visual (${seen.x.toFixed(1)}, ${seen.y.toFixed(1)}) off ${off.toFixed(1)} ${status.smartClickLastMethod} ${status.smartClickLastConfidence} scale ${status.smartClickLastScale} source ${status.smartClickLastSource} elapsed ${elapsed} screen ${screenSpy.mock.calls.length}`
          );
        }
      }
    } finally {
      captureSpy.mockRestore();
      screenSpy.mockRestore();
    }
  }
  if (misses.length) throw new Error(misses.join('\n'));
}, 120000);
