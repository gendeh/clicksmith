import { systemPreferences } from 'electron';
import { CoordinateNormalizer } from './coordinateNormalizer';

export interface CaptureRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

let screenshotLib: ((opts: { format: string }) => Promise<Buffer | string>) | null = null;
let sharpLib: any = null;

function getScreenshotLib() {
  if (!screenshotLib) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    screenshotLib = require('screenshot-desktop');
  }
  return screenshotLib as (opts: { format: string }) => Promise<Buffer | string>;
}

function getSharpLib() {
  if (!sharpLib) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sharpLib = require('sharp');
  }
  return sharpLib;
}

function hasScreenCapturePermission(): boolean {
  if (process.platform !== 'darwin') return true;
  return systemPreferences.getMediaAccessStatus('screen') === 'granted';
}

export async function captureScreen(): Promise<Buffer> {
  if (!hasScreenCapturePermission()) {
    throw new Error('screen_recording_permission_denied');
  }
  const screenshot = getScreenshotLib();
  const image = await screenshot({ format: 'png' });
  const raw = Buffer.isBuffer(image) ? image : Buffer.from(image);
  const sharp = getSharpLib();
  const metadata = await sharp(raw).metadata();
  const nativeWidth = metadata.width ?? 0;
  const nativeHeight = metadata.height ?? 0;
  if (nativeWidth <= 0 || nativeHeight <= 0) {
    throw new Error('screen_capture_invalid_image');
  }

  if (process.platform !== 'darwin') {
    return raw;
  }

  const normalizer = CoordinateNormalizer.fromNativeImageDimensions(nativeWidth, nativeHeight);
  const logicalWidth = Math.max(1, Math.round(nativeWidth / normalizer.scaleX));
  const logicalHeight = Math.max(1, Math.round(nativeHeight / normalizer.scaleY));

  const shouldScale = Math.abs(normalizer.scaleX - 1) > 0.05 || Math.abs(normalizer.scaleY - 1) > 0.05;
  if (!shouldScale) {
    return raw;
  }

  return sharp(raw)
    .resize(logicalWidth, logicalHeight, { fit: 'fill' })
    .png()
    .toBuffer();
}

export async function captureRegion(region: CaptureRegion): Promise<Buffer> {
  const sharp = getSharpLib();
  const screen = await captureScreen();
  const metadata = await sharp(screen).metadata();
  const maxWidth = Math.max(1, metadata.width ?? region.width);
  const maxHeight = Math.max(1, metadata.height ?? region.height);
  const desktopBounds = CoordinateNormalizer.getVirtualLogicalBounds();

  const requestWidth = Math.max(1, Math.round(region.width));
  const requestHeight = Math.max(1, Math.round(region.height));
  const requestX = Math.round(region.x - desktopBounds.x);
  const requestY = Math.round(region.y - desktopBounds.y);

  const left = requestX;
  const top = requestY;
  const right = requestX + requestWidth;
  const bottom = requestY + requestHeight;
  const safeX = Math.max(0, Math.min(maxWidth - 1, left));
  const safeY = Math.max(0, Math.min(maxHeight - 1, top));
  const safeRight = Math.max(safeX + 1, Math.min(maxWidth, right));
  const safeBottom = Math.max(safeY + 1, Math.min(maxHeight, bottom));
  const safeWidth = Math.max(1, safeRight - safeX);
  const safeHeight = Math.max(1, safeBottom - safeY);

  return sharp(screen)
    .extract({ left: safeX, top: safeY, width: safeWidth, height: safeHeight })
    .png()
    .toBuffer();
}

export async function capturePatch(centerX: number, centerY: number, size: number): Promise<Buffer> {
  const half = Math.floor(size / 2);
  const region = {
    x: centerX - half,
    y: centerY - half,
    width: size,
    height: size,
  };
  return captureRegion(region);
}
