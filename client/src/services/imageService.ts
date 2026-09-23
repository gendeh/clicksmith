import crypto from 'crypto';
import { ImageMatchRequest, ImageMatchResponse, ImageOcrRequest, ImageOcrResponse } from '../types';

type CachedMatch = {
  expiresAt: number;
  response: ImageMatchResponse;
};

const CACHE_TTL_MS = 1_500;
const CACHE_LIMIT = 128;
const IMAGE_HASH_CACHE_LIMIT = 256;
const IMAGE_HASH_CACHE_MAX_CHARS = 750_000;
const SEARCH_AREA_CACHE_MAX_CHARS = 750_000;

function normalizeBase64(value: string): string {
  const trimmed = value.trim();
  const commaIdx = trimmed.indexOf(',');
  if (commaIdx === -1) return trimmed;
  return trimmed.slice(commaIdx + 1);
}

function base64ToBuffer(value: string): Buffer {
  return Buffer.from(normalizeBase64(value), 'base64');
}

export class ImageService {
  private endpoint: string;
  private readonly cache = new Map<string, CachedMatch>();
  private readonly imageHashCache = new Map<string, string>();

  constructor(endpoint: string = process.env.CLICKSMITH_IMAGE_URL || 'http://127.0.0.1:5001') {
    this.endpoint = endpoint;
  }

  public getEndpoint(): string {
    return this.endpoint;
  }

  public async matchImage(request: ImageMatchRequest): Promise<ImageMatchResponse> {
    const key = this.makeCacheKey(request);
    const now = Date.now();
    const cached = key ? this.cache.get(key) : undefined;
    if (cached && cached.expiresAt > now) {
      return cached.response;
    }

    const payload = await this.requestMatch(request);
    if (key) {
      this.cache.set(key, {
        response: payload,
        expiresAt: now + CACHE_TTL_MS,
      });
      this.enforceCacheLimit();
    }
    return payload;
  }

  public async healthCheck(timeoutMs = 450): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(120, timeoutMs));
    try {
      const response = await fetch(`${this.endpoint}/health`, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!response.ok) return false;
      const payload = (await response.json()) as { status?: string };
      return payload?.status === 'ok';
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  public async ocrImage(request: ImageOcrRequest): Promise<ImageOcrResponse> {
    const timeoutMs = Math.max(150, Math.min(3000, request.timeoutMs ?? 900));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.endpoint}/ocr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          success: false,
          items: [],
          processingTimeMs: 0,
          error: `image_service_http_${response.status}`,
        };
      }
      const payload = (await response.json()) as ImageOcrResponse;
      return payload;
    } catch (error) {
      return {
        success: false,
        items: [],
        processingTimeMs: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestMatch(request: ImageMatchRequest): Promise<ImageMatchResponse> {
    const timeoutMs = Math.max(120, Math.min(2500, request.timeoutMs ?? 450));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const binaryMode = process.env.CLICKSMITH_IMAGE_TRANSPORT === 'binary';
      const fetchRequest = binaryMode
        ? await this.makeBinaryRequest(request)
        : this.makeJsonRequest(request);

      const response = await fetch(`${this.endpoint}/match`, {
        ...fetchRequest,
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          success: false,
          matches: [],
          processingTimeMs: 0,
          error: `image_service_http_${response.status}`,
        };
      }
      const payload = (await response.json()) as ImageMatchResponse;
      return payload;
    } catch (error) {
      return {
        success: false,
        matches: [],
        processingTimeMs: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private makeJsonRequest(request: ImageMatchRequest): RequestInit {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    };
  }

  private async makeBinaryRequest(request: ImageMatchRequest): Promise<RequestInit> {
    const form = new FormData();
    form.append('threshold', String(request.threshold));
    form.append('method', request.method);
    form.append('findAll', String(request.findAll));
    form.append('maxMatches', String(request.maxMatches));

    const templateBuffer = base64ToBuffer(request.template);
    const templatePart = templateBuffer as unknown as BlobPart;
    form.append('template_file', new Blob([templatePart]), 'template.bin');
    if (request.searchArea) {
      const searchBuffer = base64ToBuffer(request.searchArea);
      const searchPart = searchBuffer as unknown as BlobPart;
      form.append('search_area_file', new Blob([searchPart]), 'search.bin');
    }

    return {
      method: 'POST',
      body: form,
    };
  }

  private makeCacheKey(request: ImageMatchRequest): string | null {
    const hash = crypto.createHash('sha1');
    hash.update(request.templateHash ?? this.hashBase64Image(request.template));
    hash.update('|');
    if (request.searchArea) {
      if (request.searchAreaHash) {
        hash.update(request.searchAreaHash);
      } else {
        const normalizedSearchArea = normalizeBase64(request.searchArea);
        if (normalizedSearchArea.length > SEARCH_AREA_CACHE_MAX_CHARS) {
          return null;
        }
        hash.update(this.hashNormalizedBase64Image(normalizedSearchArea));
      }
    }
    hash.update('|');
    hash.update(request.method);
    hash.update('|');
    hash.update(String(request.threshold));
    hash.update('|');
    hash.update(String(request.findAll));
    hash.update('|');
    hash.update(String(request.maxMatches));
    hash.update('|');
    hash.update(String(request.timeoutMs ?? ''));
    hash.update('|');
    hash.update(String(request.minScale ?? ''));
    hash.update('|');
    hash.update(String(request.maxScale ?? ''));
    hash.update('|');
    hash.update(String(request.scaleHint ?? ''));
    hash.update('|');
    hash.update(String(request.maxBudgetMs ?? ''));
    return hash.digest('hex');
  }

  private hashBase64Image(value: string): string {
    return this.hashNormalizedBase64Image(normalizeBase64(value));
  }

  private hashNormalizedBase64Image(normalized: string): string {
    if (normalized.length > IMAGE_HASH_CACHE_MAX_CHARS) {
      return crypto.createHash('sha1').update(normalized).digest('hex');
    }
    const cached = this.imageHashCache.get(normalized);
    if (cached) {
      this.imageHashCache.delete(normalized);
      this.imageHashCache.set(normalized, cached);
      return cached;
    }
    const digest = crypto.createHash('sha1').update(normalized).digest('hex');
    this.imageHashCache.set(normalized, digest);
    while (this.imageHashCache.size > IMAGE_HASH_CACHE_LIMIT) {
      const oldestKey = this.imageHashCache.keys().next().value;
      if (!oldestKey) break;
      this.imageHashCache.delete(oldestKey);
    }
    return digest;
  }

  private enforceCacheLimit() {
    while (this.cache.size > CACHE_LIMIT) {
      const oldestKey = this.cache.keys().next().value;
      if (!oldestKey) break;
      this.cache.delete(oldestKey);
    }
  }
}
