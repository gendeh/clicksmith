import { capturePatch } from '../src/main/screenCapture';

const mockCaptureArgs: string[][] = [];

jest.mock('electron', () => ({
  systemPreferences: {
    getMediaAccessStatus: () => 'granted',
  },
  screen: {
    getAllDisplays: () => [
      { id: 1, bounds: { x: 0, y: 0, width: 100, height: 80 }, scaleFactor: 1 },
    ],
    getPrimaryDisplay: () => ({
      id: 1,
      bounds: { x: 0, y: 0, width: 100, height: 80 },
      scaleFactor: 1,
    }),
    on: () => undefined,
  },
}));

jest.mock('child_process', () => ({
  execFile: (command: string, args: string[], callback: (error: Error | null) => void) => {
    mockCaptureArgs.push([command, ...args]);
    const rect = String(args[args.indexOf('-R') + 1] || '0,0,1,1');
    const [originX, originY, width, height] = rect.split(',').map((value) => Number(value));
    const sharp = require('sharp');
    const raw = Buffer.alloc(width * height * 3, 0);
    const pixelX = 10 - originX;
    const pixelY = 10 - originY;
    if (pixelX >= 0 && pixelY >= 0 && pixelX < width && pixelY < height) {
      const index = (pixelY * width + pixelX) * 3;
      raw[index] = 10;
      raw[index + 1] = 220;
      raw[index + 2] = 30;
    }
    sharp(raw, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer()
      .then((png: Buffer) => {
        require('fs').writeFileSync(args[args.length - 1], png);
        callback(null);
      })
      .catch((error: Error) => callback(error));
  },
}));

jest.mock('screenshot-desktop', () => {
  return async () => {
    const sharp = require('sharp');
    const raw = Buffer.alloc(100 * 80 * 3, 0);
    const x = 10;
    const y = 10;
    const i = (y * 100 + x) * 3;
    raw[i] = 10;
    raw[i + 1] = 220;
    raw[i + 2] = 30;
    return sharp(raw, { raw: { width: 100, height: 80, channels: 3 } }).png().toBuffer();
  };
});

test('a patch clipped by the screen edge keeps the click at its center', async () => {
  const patch = await capturePatch(10, 10, 40);
  const sharp = require('sharp');
  const image = sharp(patch);
  const metadata = await image.metadata();
  expect(metadata.width).toBe(40);
  expect(metadata.height).toBe(40);
  const { data } = await image.raw().toBuffer({ resolveWithObject: true });
  const center = (20 * 40 + 20) * metadata.channels!;
  expect(data[center]).toBe(10);
  expect(data[center + 1]).toBe(220);
  expect(data[center + 2]).toBe(30);
  const corner = 0;
  expect(data[corner]).toBe(0);
  expect(data[corner + 1]).toBe(0);
  expect(data[corner + 2]).toBe(0);
  if (process.platform === 'darwin') {
    expect(mockCaptureArgs[0]).toEqual(['screencapture', '-x', '-R', '0,0,30,30', expect.any(String)]);
  } else {
    expect(mockCaptureArgs).toEqual([]);
  }
});
