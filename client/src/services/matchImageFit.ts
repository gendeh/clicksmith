import sharp from 'sharp';
import { ImageMatchRequest, ImageMatchResponse, ImageOcrResponse, MatchResult, OcrItem } from '../types';

const MATCH_MAX_PIXELS = 4_000_000;
const OCR_MAX_PIXELS = 1_900_000;
const MAX_PNG_BYTES = 900_000;

export type FittedMatch = {
  request: ImageMatchRequest;
  coordinateScale: number;
};

export type FittedOcr = {
  image: string;
  coordinateScale: number;
};

function pngSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  if (buffer[0] !== 0x89 || buffer.toString('ascii', 1, 4) !== 'PNG') return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width < 1 || height < 1) return null;
  return { width, height };
}

function decodeImage(value: string): Buffer | null {
  const trimmed = value.trim();
  const comma = trimmed.indexOf(',');
  const payload = comma === -1 ? trimmed : trimmed.slice(comma + 1);
  if (!payload) return null;
  const buffer = Buffer.from(payload, 'base64');
  return pngSize(buffer) ? buffer : null;
}

async function shrinkPng(
  buffer: Buffer,
  maxPixels: number,
  maxBytes: number
): Promise<{ buffer: Buffer; coordinateScale: number }> {
  const original = pngSize(buffer);
  if (!original) return { buffer, coordinateScale: 1 };
  let current = buffer;
  let size = original;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const pixels = size.width * size.height;
    if (pixels <= maxPixels && current.length <= maxBytes) {
      return { buffer: current, coordinateScale: original.width / size.width };
    }
    const pixelFactor = pixels > maxPixels ? Math.sqrt(maxPixels / pixels) : 1;
    const byteFactor = current.length > maxBytes ? Math.sqrt(maxBytes / current.length) : 1;
    const factor = Math.min(pixelFactor, byteFactor) * 0.95;
    if (!(factor > 0) || factor >= 1) break;
    const width = Math.max(8, Math.floor(size.width * factor));
    const height = Math.max(8, Math.floor(size.height * factor));
    current = await sharp(current).resize(width, height, { fit: 'fill' }).png().toBuffer();
    const next = pngSize(current);
    if (!next) break;
    size = next;
  }
  return { buffer: current, coordinateScale: original.width / size.width };
}

export async function fitMatchRequest(request: ImageMatchRequest): Promise<FittedMatch> {
  if (!request.searchArea) return { request, coordinateScale: 1 };
  const search = decodeImage(request.searchArea);
  if (!search) return { request, coordinateScale: 1 };
  const size = pngSize(search);
  if (!size) return { request, coordinateScale: 1 };
  if (size.width * size.height <= MATCH_MAX_PIXELS && search.length <= MAX_PNG_BYTES) {
    return { request, coordinateScale: 1 };
  }
  const fitted = await shrinkPng(search, MATCH_MAX_PIXELS, MAX_PNG_BYTES);
  const template = decodeImage(request.template);
  let templateB64 = request.template;
  if (template && fitted.coordinateScale !== 1) {
    const templateSize = pngSize(template);
    if (templateSize) {
      const width = Math.max(4, Math.round(templateSize.width / fitted.coordinateScale));
      const height = Math.max(4, Math.round(templateSize.height / fitted.coordinateScale));
      const resized = await sharp(template).resize(width, height, { fit: 'fill' }).png().toBuffer();
      templateB64 = resized.toString('base64');
    }
  }
  return {
    coordinateScale: fitted.coordinateScale,
    request: {
      ...request,
      template: templateB64,
      searchArea: fitted.buffer.toString('base64'),
      templateHash: fitted.coordinateScale === 1 ? request.templateHash : undefined,
    },
  };
}

export async function fitOcrImage(image: string): Promise<FittedOcr> {
  const decoded = decodeImage(image);
  if (!decoded) return { image, coordinateScale: 1 };
  const size = pngSize(decoded);
  if (!size) return { image, coordinateScale: 1 };
  if (size.width * size.height <= OCR_MAX_PIXELS && decoded.length <= MAX_PNG_BYTES) {
    return { image, coordinateScale: 1 };
  }
  const fitted = await shrinkPng(decoded, OCR_MAX_PIXELS, MAX_PNG_BYTES);
  return {
    image: fitted.buffer.toString('base64'),
    coordinateScale: fitted.coordinateScale,
  };
}

function scaleMatch(match: MatchResult, scale: number): MatchResult {
  return {
    ...match,
    x: match.x * scale,
    y: match.y * scale,
    bounds: {
      ...match.bounds,
      x: match.bounds.x * scale,
      y: match.bounds.y * scale,
      width: match.bounds.width * scale,
      height: match.bounds.height * scale,
    },
  };
}

export function scaleMatchResponse(response: ImageMatchResponse, scale: number): ImageMatchResponse {
  if (scale === 1 || !response.success) return response;
  return {
    ...response,
    matches: (response.matches ?? []).map(match => scaleMatch(match, scale)),
    bestMatch: response.bestMatch ? scaleMatch(response.bestMatch, scale) : response.bestMatch,
  };
}

function scaleOcrItem(item: OcrItem, scale: number): OcrItem {
  return {
    ...item,
    bounds: {
      ...item.bounds,
      x: item.bounds.x * scale,
      y: item.bounds.y * scale,
      width: item.bounds.width * scale,
      height: item.bounds.height * scale,
    },
  };
}

export function scaleOcrResponse(response: ImageOcrResponse, scale: number): ImageOcrResponse {
  if (scale === 1 || !response.success) return response;
  return {
    ...response,
    items: (response.items ?? []).map(item => scaleOcrItem(item, scale)),
  };
}
