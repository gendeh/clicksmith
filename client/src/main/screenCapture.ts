import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { screen, systemPreferences } from 'electron';
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

function captureDisplayRect(rect: CaptureRegion): Promise<Buffer> {
  const file = path.join(os.tmpdir(), `clicksmith-cap-${process.hrtime.bigint()}.png`);
  const arg = `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`;
  return new Promise((resolve, reject) => {
    execFile('screencapture', ['-x', '-R', arg, file], async (error) => {
      if (error) {
        reject(error);
        return;
      }
      try {
        resolve(await fs.readFile(file));
      } catch (readError) {
        reject(readError);
      } finally {
        await fs.unlink(file).catch(() => undefined);
      }
    });
  });
}

async function toLogicalPng(nativePng: Buffer, logicalWidth: number, logicalHeight: number): Promise<Buffer> {
  const sharp = getSharpLib();
  const metadata = await sharp(nativePng).metadata();
  const width = metadata.width ?? logicalWidth;
  const height = metadata.height ?? logicalHeight;
  if (width === logicalWidth && height === logicalHeight) {
    return nativePng;
  }
  return sharp(nativePng).resize(logicalWidth, logicalHeight, { fit: 'fill' }).png().toBuffer();
}

async function captureDarwinRegion(region: CaptureRegion): Promise<Buffer> {
  const sharp = getSharpLib();
  const desktop = CoordinateNormalizer.getVirtualLogicalBounds();
  const requestWidth = Math.max(1, Math.round(region.width));
  const requestHeight = Math.max(1, Math.round(region.height));
  const requestX = Math.round(region.x);
  const requestY = Math.round(region.y);
  const visibleLeft = Math.max(desktop.x, requestX);
  const visibleTop = Math.max(desktop.y, requestY);
  const visibleRight = Math.min(desktop.x + desktop.width, requestX + requestWidth);
  const visibleBottom = Math.min(desktop.y + desktop.height, requestY + requestHeight);
  const visibleWidth = visibleRight - visibleLeft;
  const visibleHeight = visibleBottom - visibleTop;
  if (visibleWidth < 1 || visibleHeight < 1) {
    return sharp({
      create: {
        width: requestWidth,
        height: requestHeight,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    }).png().toBuffer();
  }

  const native = await captureDisplayRect({
    x: visibleLeft,
    y: visibleTop,
    width: visibleWidth,
    height: visibleHeight,
  });
  const scale = Math.max(1, Number(screen.getPrimaryDisplay().scaleFactor) || 1);
  const metadata = await sharp(native).metadata();
  const logicalWidth = Math.max(1, Math.round((metadata.width ?? visibleWidth * scale) / scale));
  const logicalHeight = Math.max(1, Math.round((metadata.height ?? visibleHeight * scale) / scale));
  const cropped = await toLogicalPng(native, logicalWidth, logicalHeight);
  const placeLeft = visibleLeft - requestX;
  const placeTop = visibleTop - requestY;
  if (placeLeft === 0 && placeTop === 0 && logicalWidth === requestWidth && logicalHeight === requestHeight) {
    return cropped;
  }
  return sharp({
    create: {
      width: requestWidth,
      height: requestHeight,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite([{ input: cropped, left: placeLeft, top: placeTop }])
    .png()
    .toBuffer();
}

export async function captureRegion(region: CaptureRegion): Promise<Buffer> {
  if (process.platform === 'darwin') {
    try {
      return await captureDarwinRegion(region);
    } catch {
      return cropFullFrame(region);
    }
  }
  return cropFullFrame(region);
}

async function cropFullFrame(region: CaptureRegion): Promise<Buffer> {
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
  const right = left + requestWidth;
  const bottom = top + requestHeight;
  const extractLeft = Math.max(0, Math.min(maxWidth, left));
  const extractTop = Math.max(0, Math.min(maxHeight, top));
  const extractRight = Math.max(extractLeft, Math.min(maxWidth, right));
  const extractBottom = Math.max(extractTop, Math.min(maxHeight, bottom));
  const extractWidth = extractRight - extractLeft;
  const extractHeight = extractBottom - extractTop;
  const placeLeft = Math.max(0, -left);
  const placeTop = Math.max(0, -top);

  if (extractWidth < 1 || extractHeight < 1) {
    return sharp({
      create: {
        width: requestWidth,
        height: requestHeight,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();
  }

  const cropped = await sharp(screen)
    .extract({ left: extractLeft, top: extractTop, width: extractWidth, height: extractHeight })
    .png()
    .toBuffer();
  if (placeLeft === 0 && placeTop === 0 && extractWidth === requestWidth && extractHeight === requestHeight) {
    return cropped;
  }

  return sharp({
    create: {
      width: requestWidth,
      height: requestHeight,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite([{ input: cropped, left: placeLeft, top: placeTop }])
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
