import { EventEmitter } from 'events';
import { PlaybackConfig, PlaybackStatus, Profile, RecordedEvent, WindowBounds } from '../types';
import { ImageService } from '../services/imageService';
import { InputPlayer } from './inputPlayer';
import { WindowManager } from './windowManager';
import { captureRegion } from './screenCapture';

type Clock = {
  now: () => number;
  setTimeout: (handler: () => void, timeout: number) => NodeJS.Timeout;
  clearTimeout: (handle: NodeJS.Timeout) => void;
};

export class PlaybackEngine extends EventEmitter {
  private isPlaying = false;
  private config: PlaybackConfig | null = null;
  private profile: Profile | null = null;
  private currentEventIndex = 0;
  private playbackTimer: NodeJS.Timeout | null = null;
  private status: PlaybackStatus;
  private inputPlayer: InputPlayer;
  private imageService: ImageService;
  private windowManager: WindowManager;
  private clock: Clock;
  private targetBounds: WindowBounds | null = null;
  private startedAt = 0;

  constructor(options?: {
    inputPlayer?: InputPlayer;
    imageService?: ImageService;
    windowManager?: WindowManager;
    clock?: Clock;
  }) {
    super();
    this.inputPlayer = options?.inputPlayer ?? new InputPlayer();
    this.imageService = options?.imageService ?? new ImageService();
    this.windowManager = options?.windowManager ?? new WindowManager();
    this.clock = options?.clock ?? {
      now: () => Date.now(),
      setTimeout: (handler, timeout) => setTimeout(handler, timeout),
      clearTimeout: (handle) => clearTimeout(handle),
    };
    this.status = this.createStatus('idle');
  }

  public get playing(): boolean {
    return this.isPlaying;
  }

  public getStatus(): PlaybackStatus {
    return this.status;
  }

  public async start(config: PlaybackConfig, profile: Profile): Promise<{ success: boolean; error?: string }> {
    if (this.isPlaying) {
      return { success: false, error: 'Already playing' };
    }

    this.config = config;
    this.profile = profile;
    this.isPlaying = true;
    this.currentEventIndex = 0;
    this.startedAt = this.clock.now();
    this.targetBounds = this.windowManager.getTargetBounds(config.target);
    this.status = this.createStatus('playing');
    this.emit('status', this.status);

    this.playNextEvent();
    return { success: true };
  }

  public async stop() {
    this.isPlaying = false;
    if (this.playbackTimer) {
      this.clock.clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }
    this.status = this.createStatus('idle');
    this.emit('status', this.status);
    return { success: true };
  }

  public pause() {
    this.isPlaying = false;
    if (this.playbackTimer) {
      this.clock.clearTimeout(this.playbackTimer);
    }
    this.status = { ...this.status, state: 'paused' };
    this.emit('status', this.status);
  }

  public resume() {
    if (this.config && this.profile) {
      this.isPlaying = true;
      this.status = { ...this.status, state: 'playing' };
      this.emit('status', this.status);
      this.playNextEvent();
    }
  }

  public async takeover() {
    this.status = { ...this.status, state: 'takeover' };
    this.emit('status', this.status);
    this.pause();
    this.emit('takeover');
    return { success: true };
  }

  private playNextEvent() {
    if (!this.isPlaying || !this.config || !this.profile) return;

    if (this.currentEventIndex >= this.profile.events.length) {
      this.finishPlayback();
      return;
    }

    const event = this.profile.events[this.currentEventIndex];
    const targetTime = this.startedAt + this.getAdjustedTime(event, this.currentEventIndex);
    const delay = Math.max(0, targetTime - this.clock.now());

    this.playbackTimer = this.clock.setTimeout(() => {
      void this.executeEvent(event).then(() => {
        this.currentEventIndex += 1;
        this.playNextEvent();
      });
    }, delay);
  }

  private getAdjustedTime(event: RecordedEvent, index: number): number {
    const base = event.t_ms / (this.config?.speedMultiplier ?? 1);
    const adjustments = this.profile?.metadata?.custom?.timing_adjustments as number[] | undefined;
    const jitter = adjustments?.[index] ?? 0;
    return base + jitter;
  }

  private async executeEvent(event: RecordedEvent) {
    if (!this.config) return;
    const expected = this.resolveCoords(event);
    const resolved = await this.resolveSmartClick(event, expected);

    if (event.type === 'mouse') {
      this.inputPlayer.moveMouse(resolved.x, resolved.y);
      await this.inputPlayer.clickWithDuration(event.btn ?? 'left', event.duration_ms);
    } else if (event.type === 'keyboard') {
      await this.playKeyboardEvent(event);
    }

    this.status = this.updateStatus(this.status, event);
    this.emit('status', this.status);
  }

  private resolveCoords(event: RecordedEvent) {
    if (!this.config?.useRelativeCoords || !this.targetBounds) {
      return { x: event.x, y: event.y };
    }
    return {
      x: Math.round(this.targetBounds.x + this.targetBounds.width * event.rel_x),
      y: Math.round(this.targetBounds.y + this.targetBounds.height * event.rel_y),
    };
  }

  private async resolveSmartClick(event: RecordedEvent, expected: { x: number; y: number }) {
    if (!this.config?.useImageMatching || !event.img_patch_b64) {
      return expected;
    }

    const searchRadius = this.config.imageSearchRadius ?? 160;
    const region = {
      x: Math.max(0, expected.x - searchRadius),
      y: Math.max(0, expected.y - searchRadius),
      width: searchRadius * 2,
      height: searchRadius * 2,
    };

    for (let attempt = 0; attempt <= this.config.retryCount; attempt += 1) {
      try {
        const searchArea = await captureRegion(region);
        const response = await this.imageService.matchImage({
          template: event.img_patch_b64,
          searchArea: searchArea.toString('base64'),
          threshold: this.config.imageMatchThreshold,
          method: 'hybrid',
          findAll: false,
          maxMatches: 1,
        });

        if (response.success && response.bestMatch && response.bestMatch.confidence >= this.config.imageMatchThreshold) {
          this.status = {
            ...this.status,
            successfulMatches: this.status.successfulMatches + 1,
          };
          return {
            x: region.x + response.bestMatch.x,
            y: region.y + response.bestMatch.y,
          };
        }
      } catch (error) {
        this.status = { ...this.status, lastError: 'image_match_failed' };
      }

      if (attempt < this.config.retryCount) {
        this.status = { ...this.status, retries: this.status.retries + 1 };
        await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));
      }
    }

    this.status = { ...this.status, failedMatches: this.status.failedMatches + 1 };
    return expected;
  }

  private async playKeyboardEvent(event: RecordedEvent) {
    const key = event.key ?? (event.keyCode ? `key_${event.keyCode}` : '');
    if (!key) return;
    const modifiers = event.modifiers ?? [];
    modifiers.forEach(mod => this.inputPlayer.keyDown(mod));
    this.inputPlayer.keyDown(key);
    if (event.duration_ms > 0) {
      await new Promise(resolve => setTimeout(resolve, event.duration_ms));
    }
    this.inputPlayer.keyUp(key);
    modifiers.forEach(mod => this.inputPlayer.keyUp(mod));
  }

  private finishPlayback() {
    this.isPlaying = false;
    this.status = { ...this.status, state: 'idle' };
    this.emit('status', this.status);
    this.emit('complete', this.status);
  }

  private createStatus(state: PlaybackStatus['state']): PlaybackStatus {
    return {
      state,
      currentEventIndex: this.currentEventIndex,
      totalEvents: this.profile?.events.length ?? 0,
      elapsedMs: 0,
      successfulMatches: 0,
      failedMatches: 0,
      retries: 0,
      timingDrift: 0,
    };
  }

  private updateStatus(status: PlaybackStatus, event: RecordedEvent): PlaybackStatus {
    const elapsed = this.clock.now() - this.startedAt;
    const expected = event.t_ms / (this.config?.speedMultiplier ?? 1);
    const drift = elapsed - expected;
    const driftError =
      Math.abs(drift) > (this.config?.timingTolerance ?? 20) ? 'timing_drift_exceeded' : status.lastError;
    return {
      ...status,
      currentEventIndex: this.currentEventIndex,
      totalEvents: this.profile?.events.length ?? 0,
      elapsedMs: elapsed,
      timingDrift: drift,
      lastError: driftError,
    };
  }
}
