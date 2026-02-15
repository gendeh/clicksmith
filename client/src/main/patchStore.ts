import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { RecordedEvent } from '../types';

const PATCH_EXT = '.b64';

function normalizeBase64(value: string): string {
  const trimmed = value.trim();
  const commaIdx = trimmed.indexOf(',');
  if (commaIdx === -1) return trimmed;
  return trimmed.slice(commaIdx + 1);
}

function isPatchRef(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

export class PatchStore {
  private readonly rootDir: string;
  private readonly cache = new Map<string, string>();

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  public compactEvents(events: RecordedEvent[]): RecordedEvent[] {
    return events.map(event => this.compactEvent(event));
  }

  public hydrateEvents(events: RecordedEvent[]): RecordedEvent[] {
    return events.map(event => this.hydrateEvent(event));
  }

  private compactEvent(event: RecordedEvent): RecordedEvent {
    if (!event.img_patch_b64) {
      return { ...event };
    }

    const normalized = normalizeBase64(event.img_patch_b64);
    let patchRef = event.img_patch_ref ?? event.img_hash;
    if (!patchRef || !isPatchRef(patchRef)) {
      const patchBuffer = Buffer.from(normalized, 'base64');
      patchRef = crypto.createHash('sha256').update(patchBuffer).digest('hex');
    }

    this.writePatchIfMissing(patchRef, normalized);
    return {
      ...event,
      img_hash: patchRef,
      img_patch_ref: patchRef,
      img_patch_b64: undefined,
    };
  }

  private hydrateEvent(event: RecordedEvent): RecordedEvent {
    if (event.img_patch_b64) {
      return { ...event };
    }

    const patchRef = event.img_patch_ref ?? event.img_hash;
    if (!patchRef || !isPatchRef(patchRef)) {
      return { ...event };
    }

    const patch = this.readPatch(patchRef);
    if (!patch) {
      return { ...event };
    }

    return {
      ...event,
      img_hash: event.img_hash ?? patchRef,
      img_patch_ref: patchRef,
      img_patch_b64: patch,
    };
  }

  private writePatchIfMissing(ref: string, base64Data: string) {
    if (!isPatchRef(ref)) return;
    const filePath = this.patchPath(ref);
    if (this.cache.has(ref) || fs.existsSync(filePath)) {
      if (!this.cache.has(ref)) {
        this.cache.set(ref, base64Data);
      }
      return;
    }
    fs.writeFileSync(filePath, base64Data, 'utf-8');
    this.cache.set(ref, base64Data);
  }

  private readPatch(ref: string): string | null {
    if (!isPatchRef(ref)) return null;
    const fromCache = this.cache.get(ref);
    if (fromCache) return fromCache;
    const filePath = this.patchPath(ref);
    if (!fs.existsSync(filePath)) return null;
    try {
      const content = fs.readFileSync(filePath, 'utf-8').trim();
      this.cache.set(ref, content);
      return content;
    } catch {
      return null;
    }
  }

  private patchPath(ref: string): string {
    return path.join(this.rootDir, `${ref}${PATCH_EXT}`);
  }
}
