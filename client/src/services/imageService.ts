import crypto from 'crypto';
import { ImageMatchRequest, ImageMatchResponse } from '../types';

type CachedMatch = {
  expiresAt: number;
  response: ImageMatchResponse;
};

const CACHE_TTL_MS = 1_500;
const CACHE_LIMIT = 128;

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

  constructor(endpoint: string = process.env.CLICKSMITH_IMAGE_URL || 'http://127.0.0.1:5001') {
    this.endpoint = endpoint;
  }

  public async matchImage(request: ImageMatchRequest): Promise<ImageMatchResponse> {
    const key = this.makeCacheKey(request);
    const cached = this.cache.get(key);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.response;
    }

    const payload = await this.requestMatch(request);
    this.cache.set(key, {
      response: payload,
      expiresAt: now + CACHE_TTL_MS,
    });
    this.enforceCacheLimit();
    return payload;
  }

  private async requestMatch(request: ImageMatchRequest): Promise<ImageMatchResponse> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);
      const binaryMode = process.env.CLICKSMITH_IMAGE_TRANSPORT === 'binary';
      const fetchRequest = binaryMode
        ? await this.makeBinaryRequest(request)
        : this.makeJsonRequest(request);

      const response = await fetch(`${this.endpoint}/match`, {
        ...fetchRequest,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const payload = (await response.json()) as ImageMatchResponse;
      return payload;
    } catch (error) {
      return {
        success: false,
        matches: [],
        processingTimeMs: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
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

  private makeCacheKey(request: ImageMatchRequest): string {
    const hash = crypto.createHash('sha1');
    hash.update(normalizeBase64(request.template));
    hash.update('|');
    if (request.searchArea) {
      hash.update(normalizeBase64(request.searchArea));
    }
    hash.update('|');
    hash.update(request.method);
    hash.update('|');
    hash.update(String(request.threshold));
    hash.update('|');
    hash.update(String(request.findAll));
    hash.update('|');
    hash.update(String(request.maxMatches));
    return hash.digest('hex');
  }

  private enforceCacheLimit() {
    while (this.cache.size > CACHE_LIMIT) {
      const oldestKey = this.cache.keys().next().value;
      if (!oldestKey) break;
      this.cache.delete(oldestKey);
    }
  }
}
