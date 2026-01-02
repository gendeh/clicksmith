import { EventEmitter } from 'events';
import { ModifierKey, MouseButton, RecordingConfig, RecordedEvent, WindowBounds } from '../types';
import { capturePatch } from './screenCapture';
import { computeDHash, computeSha256 } from './imageHash';
import { createDefaultInputHook, HookEvent, InputHook, HookKeyEvent, HookMouseEvent } from './inputHooks';
import { WindowManager } from './windowManager';

const KEYCODE_MAP: Record<number, string> = {
  28: 'enter',
  57: 'space',
  14: 'backspace',
  15: 'tab',
  42: 'shift',
  54: 'shift',
  29: 'control',
  56: 'alt',
};

export class RecordingEngine extends EventEmitter {
  private isRecording = false;
  private config: RecordingConfig | null = null;
  private events: RecordedEvent[] = [];
  private startTime = 0;
  private lastEventTime = 0;
  private inputHook: InputHook;
  private windowManager: WindowManager;
  private targetBounds: WindowBounds | null = null;
  private pendingMouseDown = new Map<MouseButton, { t: number; x: number; y: number }>();
  private pendingKeyDown = new Map<number, { t: number; key: string }>();
  private lastMousePosition = { x: 0, y: 0 };
  private takeoverActive = false;

  constructor(options?: { inputHook?: InputHook; windowManager?: WindowManager }) {
    super();
    this.inputHook = options?.inputHook ?? createDefaultInputHook();
    this.windowManager = options?.windowManager ?? new WindowManager();
  }

  public get recording(): boolean {
    return this.isRecording;
  }

  public setTakeoverActive(active: boolean) {
    this.takeoverActive = active;
  }

  public recordTakeoverMarker() {
    if (!this.isRecording || !this.config) return;
    const t_ms = Date.now() - this.startTime;
    const { rel_x, rel_y } = this.getRelativeCoords(this.lastMousePosition.x, this.lastMousePosition.y);
    const marker: RecordedEvent = {
      t_ms,
      type: 'mouse',
      btn: 'left',
      x: this.lastMousePosition.x,
      y: this.lastMousePosition.y,
      rel_x,
      rel_y,
      duration_ms: 0,
      human_override: true,
      metadata: { takeover_marker: true },
    };
    this.events.push(marker);
    this.emit('event', marker);
  }

  public async start(config: RecordingConfig): Promise<{ success: boolean; error?: string }> {
    if (this.isRecording) {
      return { success: false, error: 'Already recording' };
    }

    this.config = config;
    this.isRecording = true;
    this.events = [];
    this.startTime = Date.now();
    this.lastEventTime = 0;
    this.targetBounds = this.windowManager.getTargetBounds(config.target);
    this.attachListeners();
    this.inputHook.start();
    this.emit('status', { state: 'recording' });

    return { success: true };
  }

  public async stop(): Promise<{ success: boolean; profile?: any }> {
    if (!this.isRecording) {
      return { success: false };
    }

    this.isRecording = false;
    this.takeoverActive = false;
    this.pendingMouseDown.clear();
    this.pendingKeyDown.clear();
    this.inputHook.stop();
    this.inputHook.removeAllListeners();
    this.emit('status', { state: 'idle' });

    return {
      success: true,
      profile: {
        events: this.events,
        duration: Date.now() - this.startTime,
      },
    };
  }

  public pause() {
    this.isRecording = false;
    this.emit('status', { state: 'paused' });
  }

  public resume() {
    this.isRecording = true;
    this.emit('status', { state: 'recording' });
  }

  private attachListeners() {
    this.inputHook.on('mousemove', (event: HookEvent) => {
      const mouse = event as HookMouseEvent;
      this.lastMousePosition = { x: mouse.x, y: mouse.y };
    });

    this.inputHook.on('mousedown', (event: HookEvent) => this.handleMouseDown(event as HookMouseEvent));
    this.inputHook.on('mouseup', (event: HookEvent) => void this.handleMouseUp(event as HookMouseEvent));
    this.inputHook.on('keydown', (event: HookEvent) => this.handleKeyDown(event as HookKeyEvent));
    this.inputHook.on('keyup', (event: HookEvent) => void this.handleKeyUp(event as HookKeyEvent));
  }

  private handleMouseDown(event: HookMouseEvent) {
    if (!this.isRecording || !this.config?.recordMouse) return;
    const button = this.mapMouseButton(event.button);
    this.pendingMouseDown.set(button, { t: Date.now(), x: event.x, y: event.y });
  }

  private async handleMouseUp(event: HookMouseEvent) {
    if (!this.isRecording || !this.config?.recordMouse) return;
    const button = this.mapMouseButton(event.button);
    const downEvent = this.pendingMouseDown.get(button);
    const duration = downEvent ? Date.now() - downEvent.t : 0;

    const t_ms = Date.now() - this.startTime;
    if (t_ms - this.lastEventTime < this.config.minEventInterval) return;
    this.lastEventTime = t_ms;

    const { rel_x, rel_y } = this.getRelativeCoords(event.x, event.y);
    const recordedEvent: RecordedEvent = {
      t_ms,
      type: 'mouse',
      btn: button,
      x: event.x,
      y: event.y,
      rel_x,
      rel_y,
      duration_ms: duration,
      human_override: this.takeoverActive,
      modifiers: this.mapModifiers(event),
      metadata: { source: 'mouse' },
    };

    this.events.push(recordedEvent);
    this.emit('event', recordedEvent);

    if (this.config.captureImages) {
      await this.attachImageContext(recordedEvent, event.x, event.y, this.config.imagePatchSize);
    }
  }

  private handleKeyDown(event: HookKeyEvent) {
    if (!this.isRecording || !this.config?.recordKeyboard) return;
    const key = this.mapKey(event);
    this.pendingKeyDown.set(event.keycode, { t: Date.now(), key });
  }

  private async handleKeyUp(event: HookKeyEvent) {
    if (!this.isRecording || !this.config?.recordKeyboard) return;
    const pending = this.pendingKeyDown.get(event.keycode);
    const duration = pending ? Date.now() - pending.t : 0;
    const key = pending?.key ?? this.mapKey(event);

    const t_ms = Date.now() - this.startTime;
    if (t_ms - this.lastEventTime < this.config.minEventInterval) return;
    this.lastEventTime = t_ms;

    const { rel_x, rel_y } = this.getRelativeCoords(this.lastMousePosition.x, this.lastMousePosition.y);
    const recordedEvent: RecordedEvent = {
      t_ms,
      type: 'keyboard',
      key,
      keyCode: event.keycode,
      x: this.lastMousePosition.x,
      y: this.lastMousePosition.y,
      rel_x,
      rel_y,
      duration_ms: duration,
      human_override: this.takeoverActive,
      modifiers: this.mapModifiers(event),
      metadata: { source: 'keyboard' },
    };

    this.events.push(recordedEvent);
    this.emit('event', recordedEvent);
  }

  private mapMouseButton(button?: number): MouseButton {
    switch (button) {
      case 2:
        return 'right';
      case 3:
        return 'middle';
      case 1:
      default:
        return 'left';
    }
  }

  private mapKey(event: HookKeyEvent): string {
    if (event.keychar && event.keychar > 0) {
      return String.fromCharCode(event.keychar).toLowerCase();
    }
    return KEYCODE_MAP[event.keycode] ?? `key_${event.keycode}`;
  }

  private mapModifiers(event: HookMouseEvent | HookKeyEvent): ModifierKey[] {
    const mods: ModifierKey[] = [];
    if (event.ctrlKey) mods.push('ctrl');
    if (event.altKey) mods.push('alt');
    if (event.shiftKey) mods.push('shift');
    if (event.metaKey) mods.push('meta');
    return mods;
  }

  private getRelativeCoords(x: number, y: number) {
    const bounds = this.targetBounds;
    if (!bounds || bounds.width === 0 || bounds.height === 0) {
      return { rel_x: 0, rel_y: 0 };
    }
    return {
      rel_x: (x - bounds.x) / bounds.width,
      rel_y: (y - bounds.y) / bounds.height,
    };
  }

  private async attachImageContext(event: RecordedEvent, x: number, y: number, size: number) {
    try {
      const patch = await capturePatch(Math.round(x), Math.round(y), size);
      event.img_patch_b64 = patch.toString('base64');
      event.img_hash = computeSha256(patch);
      const dhash = await computeDHash(patch);
      event.metadata = { ...(event.metadata ?? {}), img_dhash: dhash };
    } catch (error) {
      event.metadata = { ...(event.metadata ?? {}), image_error: 'capture_failed' };
    }
  }
}
