import { ImageMatchRequest, ImageMatchResponse, MatchResult } from '../types';

export class ImageService {
  private endpoint: string;

  constructor(endpoint: string = process.env.CLICKSMITH_IMAGE_URL || 'http://127.0.0.1:5001') {
    this.endpoint = endpoint;
  }

  public async matchImage(request: ImageMatchRequest): Promise<ImageMatchResponse> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);
      const response = await fetch(`${this.endpoint}/match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const payload = (await response.json()) as ImageMatchResponse;
      return payload;
    } catch (error) {
      console.error('ImageService Error:', error);
      return {
        success: false,
        matches: [],
        processingTimeMs: 0,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
}
