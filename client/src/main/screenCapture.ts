import screenshot from 'screenshot-desktop';
import sharp from 'sharp';

export interface CaptureRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function captureScreen(): Promise<Buffer> {
  const image = await screenshot({ format: 'png' });
  return Buffer.isBuffer(image) ? image : Buffer.from(image);
}

export async function captureRegion(region: CaptureRegion): Promise<Buffer> {
  const screen = await captureScreen();
  const metadata = await sharp(screen).metadata();
  const maxWidth = metadata.width ?? region.width;
  const maxHeight = metadata.height ?? region.height;

  const safeWidth = Math.min(region.width, Math.max(1, maxWidth - region.x));
  const safeHeight = Math.min(region.height, Math.max(1, maxHeight - region.y));
  const safeX = Math.max(0, Math.min(region.x, maxWidth - safeWidth));
  const safeY = Math.max(0, Math.min(region.y, maxHeight - safeHeight));

  return sharp(screen)
    .extract({ left: safeX, top: safeY, width: safeWidth, height: safeHeight })
    .png()
    .toBuffer();
}

export async function capturePatch(centerX: number, centerY: number, size: number): Promise<Buffer> {
  const half = Math.floor(size / 2);
  const region = {
    x: Math.max(0, centerX - half),
    y: Math.max(0, centerY - half),
    width: size,
    height: size,
  };
  return captureRegion(region);
}
