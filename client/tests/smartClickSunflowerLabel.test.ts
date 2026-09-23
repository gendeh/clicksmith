import { PlaybackEngine } from '../src/main/playbackEngine';
import { ImageService } from '../src/services/imageService';
import * as screenCapture from '../src/main/screenCapture';

const liveMatch = process.env.CLICKSMITH_LIVE_MATCH === '1' ? test : test.skip;

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

liveMatch('a clipped Sunflower label still clicks Sunflower when the button is gone', async () => {
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
        'x, y = spots["A"]',
        'cx, cy = x + 110, y + 24',
        'half = 192',
        'crop = np.full((384, 384, 3), 245, dtype=np.uint8)',
        'x0, y0 = max(0, cx - half), max(0, cy - half)',
        'x1, y1 = min(800, cx + half), min(600, cy + half)',
        'dx, dy = x0 - (cx - half), y0 - (cy - half)',
        'crop[dy:dy + (y1 - y0), dx:dx + (x1 - x0)] = page[y0:y1, x0:x1]',
        'print(json.dumps({"text": to_base64(text), "crop": to_base64(crop)}))',
      ].join('\n'),
    ],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
  );
  const fixture = JSON.parse(raw) as { text: string; crop: string };
  const search = Buffer.from(fixture.text, 'base64');
  const cropOcr = await imageService.ocrImage({ image: fixture.crop, timeoutMs: 800 });
  const pageOcr = await imageService.ocrImage({ image: search.toString('base64'), timeoutMs: 800 });
  let recordedText = '';
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const item of cropOcr.items ?? []) {
    const text = normalize(item.text);
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
  const words = (pageOcr.items ?? [])
    .filter(item => !item.text.includes(' '))
    .map(item => {
      const center = {
        x: item.bounds.x + item.bounds.width / 2,
        y: item.bounds.y + item.bounds.height / 2,
      };
      return `${item.text}@(${center.x.toFixed(0)},${center.y.toFixed(0)})`;
    })
    .join(' ');
  const sunflower = (pageOcr.items ?? []).find(item => item.text.trim().toLowerCase() === 'sunflower');
  const sharp = require('sharp');
  const patch = await sharp({
    create: { width: 96, height: 96, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).png().toBuffer();
  const windowOrigin = { x: 120, y: 80 };
  const windowSize = { width: 800, height: 600 };
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
    profileId: 'measure-sunflower-label',
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
  const recorded = { x: windowOrigin.x + 200, y: windowOrigin.y + 40 };
  const started = Date.now();
  const result = await engine.resolveSmartClick(
    {
      t_ms: 0,
      type: 'mouse',
      btn: 'left',
      x: recorded.x,
      y: recorded.y,
      rel_x: 200 / 800,
      rel_y: 40 / 600,
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
  const local = { x: result.x - windowOrigin.x, y: result.y - windowOrigin.y };
  const word = sunflower
    ? { x: sunflower.bounds.x + sunflower.bounds.width / 2, y: sunflower.bounds.y + sunflower.bounds.height / 2 }
    : null;
  captureSpy.mockRestore();
  screenSpy.mockRestore();
  const off = word ? Math.hypot(local.x - word.x, local.y - word.y) : 999;
  if (
    !recordedText.includes('sunflowe') ||
    !word ||
    off > 8 ||
    elapsed >= 460 ||
    status.smartClickLastMethod !== 'ocr' ||
    !(status.smartClickLastConfidence > 0.6) ||
    status.smartClickLastSource !== 'window'
  ) {
    throw new Error(
      [
        `recorded ${JSON.stringify(recordedText)}`,
        `words ${words}`,
        `click local (${local.x}, ${local.y}) sunflower ${word ? `(${word.x.toFixed(1)}, ${word.y.toFixed(1)}) off ${off.toFixed(1)}` : 'missing'}`,
        `${status.smartClickLastMethod} ${status.smartClickLastConfidence} source ${status.smartClickLastSource} elapsed ${elapsed}`,
      ].join('\n')
    );
  }
}, 30000);
