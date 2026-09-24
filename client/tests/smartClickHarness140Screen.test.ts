import fs from 'fs';
import path from 'path';
import { PlaybackEngine } from '../src/main/playbackEngine';
import { computeDHash } from '../src/main/imageHash';
import { ImageService } from '../src/services/imageService';
import * as screenCapture from '../src/main/screenCapture';

const liveMatch = process.env.CLICKSMITH_LIVE_MATCH === '1' ? test : test.skip;

const recordedFile = path.join(__dirname, 'fixtures/harness-100.png');
const pageFile = path.join(__dirname, 'fixtures/harness-140.png');

function center(box: { x: number; y: number; w: number; h: number }) {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

const clicks = [
  {
    name: 'sunflower',
    recorded: { x: 75, y: 154.96875, w: 199.640625, h: 51.796875 },
    visual: { x: 84.59375, y: 216.5625, w: 277.875, h: 70.90625 },
    text: '',
    source: 'region',
  },
  {
    name: 'coral',
    recorded: { x: 572, y: 154.96875, w: 161.546875, h: 51.796875 },
    visual: { x: 780.390625, y: 216.5625, w: 224.53125, h: 70.90625 },
    text: 'target d coral',
    source: 'fullscreen',
  },
];

liveMatch('a 140 percent screen click lands on Sunflower in the neighborhood and Coral on the full page', async () => {
  const sharp = require('sharp');
  const imageService = new ImageService('http://127.0.0.1:5001');
  expect(await imageService.healthCheck(800)).toBe(true);
  const recordedPng = await fs.promises.readFile(recordedFile);
  const pagePng = await fs.promises.readFile(pageFile);
  const meta = await sharp(pagePng).metadata();
  const frameW = meta.width ?? 1500;
  const frameH = meta.height ?? 1100;
  const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockImplementation(async (region) => {
    const extractLeft = Math.max(0, Math.min(frameW - 1, Math.round(region.x)));
    const extractTop = Math.max(0, Math.min(frameH - 1, Math.round(region.y)));
    const width = Math.max(1, Math.min(frameW - extractLeft, Math.round(region.width)));
    const height = Math.max(1, Math.min(frameH - extractTop, Math.round(region.height)));
    return sharp(pagePng).extract({ left: extractLeft, top: extractTop, width, height }).png().toBuffer();
  });
  const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(pagePng);
  const misses: string[] = [];
  try {
    for (const item of clicks) {
      const point = center(item.recorded);
      const seen = center(item.visual);
      const patch = await sharp(recordedPng)
        .extract({ left: Math.round(point.x - 64), top: Math.round(point.y - 64), width: 128, height: 128 })
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
        profileId: `live-140-screen-${item.name}`,
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
            ...(item.text ? { ocr_primary_text_normalized: item.text } : {}),
          },
        },
        point
      );
      const elapsed = Date.now() - started;
      const status = engine.getStatus();
      const off = Math.hypot(result.x - seen.x, result.y - seen.y);
      const screenCaptures = screenSpy.mock.calls.length;
      if (
        off > 8 ||
        elapsed >= 460 ||
        !(status.smartClickLastConfidence > 0.6) ||
        status.smartClickLastSource !== item.source ||
        (item.source === 'region' && screenCaptures !== 0) ||
        (item.source === 'fullscreen' && screenCaptures < 1)
      ) {
        misses.push(
          `${item.name} click (${result.x.toFixed(1)}, ${result.y.toFixed(1)}) visual (${seen.x.toFixed(1)}, ${seen.y.toFixed(1)}) off ${off.toFixed(1)} ${status.smartClickLastMethod} ${status.smartClickLastConfidence} scale ${status.smartClickLastScale} source ${status.smartClickLastSource} elapsed ${elapsed} screen ${screenCaptures}`
        );
      }
    }
  } finally {
    captureSpy.mockRestore();
    screenSpy.mockRestore();
  }
  if (misses.length) throw new Error(misses.join('\n'));
}, 30000);
