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

const HOOK_CALIBRATION_MIN_SAMPLES = 8;

class HookTimeCalibrator {
    private baseHookTime: number | null = null;
    private baseHrNs: bigint | null = null;
    private sumXX = 0;
    private sumXY = 0;
    private sampleCount = 0;

    public reset() {
        this.baseHookTime = null;
        this.baseHrNs = null;
        this.sumXX = 0;
        this.sumXY = 0;
        this.sampleCount = 0;
    }

    public record(hookTime: number, hrNowNs: bigint) {
        if (this.baseHookTime === null || this.baseHrNs === null) {
            this.baseHookTime = hookTime;
            this.baseHrNs = hrNowNs;
            return;
        }
        const hookDelta = hookTime - this.baseHookTime;
        if (hookDelta <= 0) return;
        const hrDeltaNs = Number(hrNowNs - this.baseHrNs);
        if (hrDeltaNs <= 0) return;
        this.sumXX += hookDelta * hookDelta;
        this.sumXY += hookDelta * hrDeltaNs;
        this.sampleCount += 1;
    }

    public getNsPerUnit(minSamples = HOOK_CALIBRATION_MIN_SAMPLES): number | null {
        if (this.sampleCount < minSamples || this.sumXX <= 0) return null;
        return this.sumXY / this.sumXX;
    }
}

type PendingInput = {
    t_ms: number;
    hrTimeNs: bigint;
    event: RecordedEvent;
};

export class RecordingEngine extends EventEmitter {
    private isRecording = false;
    private config: RecordingConfig | null = null;
    private events: RecordedEvent[] = [];
    private lastEventTime = 0;
    private inputHook: InputHook;
    private windowManager: WindowManager;
    private targetBounds: WindowBounds | null = null;
    private pendingMouseDown = new Map<MouseButton, PendingInput>();
    private pendingKeyDown = new Map<number, PendingInput>();
    private lastMousePosition = { x: 0, y: 0 };
    private takeoverActive = false;
    private hookTimeBase: number | null = null;
    private hookTimeOffsetMs = 0;
    private recordingStartHrNs: bigint = process.hrtime.bigint();
    private hookTimeCalibrator = new HookTimeCalibrator();

    constructor(options?: { inputHook?: InputHook; windowManager?: WindowManager }) {
        super();
        this.inputHook = options?.inputHook ?? createDefaultInputHook();
        this.windowManager = options?.windowManager ?? new WindowManager();
    }

    public get recording(): boolean {
        return this.isRecording;
    }

    public dispose() {
        if (this.isRecording) {
            this.isRecording = false;
            this.inputHook.stop();
        }
        this.inputHook.removeAllListeners();
        this.removeAllListeners();
    }

    public setTakeoverActive(active: boolean) {
        this.takeoverActive = active;
    }

    public recordTakeoverMarker() {
        if (!this.isRecording || !this.config) return;
        const t_ms = Number(process.hrtime.bigint() - this.recordingStartHrNs) / 1_000_000;
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
        this.lastEventTime = Number.NEGATIVE_INFINITY;
        this.hookTimeBase = null;
        this.hookTimeOffsetMs = 0;
        this.recordingStartHrNs = process.hrtime.bigint();
        this.hookTimeCalibrator.reset();
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
        this.finalizePendingInputs();
        this.applyHookTiming();
        this.inputHook.stop();
        this.inputHook.removeAllListeners();
        this.emit('status', { state: 'idle' });

        return {
            success: true,
            profile: {
                events: this.events,
                duration: Number(process.hrtime.bigint() - this.recordingStartHrNs) / 1_000_000,
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

    public injectMouseDown(event: HookMouseEvent) {
        if (!this.isRecording || !this.config?.recordMouse) return;
        const button = this.mapMouseButton(event.button);
        const hrNow = process.hrtime.bigint();
        const t_ms = this.getEventTimeMs(event, hrNow);
        if (t_ms - this.lastEventTime < this.config.minEventInterval) return;
        this.lastEventTime = t_ms;

        this.lastMousePosition = { x: event.x, y: event.y };
        const metadata: Record<string, unknown> = { source: 'mouse', action: 'down', injected: true };
        if (event.time !== undefined) {
            metadata.hook_time = event.time;
        }

        const { rel_x, rel_y } = this.getRelativeCoords(event.x, event.y);
        const recordedEvent: RecordedEvent = {
            t_ms,
            type: 'mouse',
            btn: button,
            x: event.x,
            y: event.y,
            rel_x,
            rel_y,
            duration_ms: 0,
            human_override: this.takeoverActive,
            modifiers: this.mapModifiers(event),
            metadata,
        };

        this.events.push(recordedEvent);
        this.emit('event', recordedEvent);
        this.pendingMouseDown.set(button, {
            t_ms,
            hrTimeNs: hrNow,
            event: recordedEvent,
        });

        if (this.config.captureImages) {
            void this.attachImageContext(recordedEvent, event.x, event.y, this.config.imagePatchSize);
        }
    }

    private attachListeners() {
        this.inputHook.on('mousemove', (event: HookEvent) => {
            const mouse = event as HookMouseEvent;
            this.lastMousePosition = { x: mouse.x, y: mouse.y };
            this.getEventTimeMs(mouse, process.hrtime.bigint());
        });

        this.inputHook.on('mousedown', (event: HookEvent) => this.handleMouseDown(event as HookMouseEvent));
        this.inputHook.on('mouseup', (event: HookEvent) => void this.handleMouseUp(event as HookMouseEvent));
        this.inputHook.on('keydown', (event: HookEvent) => this.handleKeyDown(event as HookKeyEvent));
        this.inputHook.on('keyup', (event: HookEvent) => void this.handleKeyUp(event as HookKeyEvent));
    }

    private handleMouseDown(event: HookMouseEvent) {
        if (!this.isRecording || !this.config?.recordMouse) return;
        const button = this.mapMouseButton(event.button);
        const hrNow = process.hrtime.bigint();
        const t_ms = this.getEventTimeMs(event, hrNow);
        if (t_ms - this.lastEventTime < this.config.minEventInterval) return;
        this.lastEventTime = t_ms;

        const metadata: Record<string, unknown> = { source: 'mouse', action: 'down' };
        if (event.time !== undefined) {
            metadata.hook_time = event.time;
        }

        const { rel_x, rel_y } = this.getRelativeCoords(event.x, event.y);
        const recordedEvent: RecordedEvent = {
            t_ms,
            type: 'mouse',
            btn: button,
            x: event.x,
            y: event.y,
            rel_x,
            rel_y,
            duration_ms: 0,
            human_override: this.takeoverActive,
            modifiers: this.mapModifiers(event),
            metadata,
        };

        this.events.push(recordedEvent);
        this.emit('event', recordedEvent);
        this.pendingMouseDown.set(button, {
            t_ms,
            hrTimeNs: hrNow,
            event: recordedEvent,
        });

        if (this.config.captureImages) {
            void this.attachImageContext(recordedEvent, event.x, event.y, this.config.imagePatchSize);
        }
    }

    private async handleMouseUp(event: HookMouseEvent) {
        if (!this.isRecording || !this.config?.recordMouse) return;
        const button = this.mapMouseButton(event.button);
        const pending = this.pendingMouseDown.get(button);
        if (pending) {
            const hrNow = process.hrtime.bigint();
            const releaseTimeMs = this.getEventTimeMs(event, hrNow);
            const durationMs = Math.max(0, Number(hrNow - pending.hrTimeNs) / 1_000_000);
            pending.event.duration_ms = durationMs;
            const metadata = { ...(pending.event.metadata ?? {}) };
            metadata.release_t_ms = releaseTimeMs;
            if (event.time !== undefined) {
                metadata.release_hook_time = event.time;
            }
            pending.event.metadata = metadata;
            this.pendingMouseDown.delete(button);
            return;
        }

        const t_ms = this.getEventTimeMs(event);
        if (t_ms - this.lastEventTime < this.config.minEventInterval) return;
        this.lastEventTime = t_ms;

        const metadata: Record<string, unknown> = { source: 'mouse', action: 'up' };
        if (event.time !== undefined) {
            metadata.hook_time = event.time;
        }

        const { rel_x, rel_y } = this.getRelativeCoords(event.x, event.y);
        const recordedEvent: RecordedEvent = {
            t_ms,
            type: 'mouse',
            btn: button,
            x: event.x,
            y: event.y,
            rel_x,
            rel_y,
            duration_ms: 0,
            human_override: this.takeoverActive,
            modifiers: this.mapModifiers(event),
            metadata,
        };

        this.events.push(recordedEvent);
        this.emit('event', recordedEvent);
    }

    private handleKeyDown(event: HookKeyEvent) {
        if (!this.isRecording || !this.config?.recordKeyboard) return;
        const key = this.mapKey(event);
        const hrNow = process.hrtime.bigint();
        const t_ms = this.getEventTimeMs(event, hrNow);
        if (t_ms - this.lastEventTime < this.config.minEventInterval) return;
        this.lastEventTime = t_ms;

        const metadata: Record<string, unknown> = { source: 'keyboard', action: 'down' };
        if (event.time !== undefined) {
            metadata.hook_time = event.time;
        }

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
            duration_ms: 0,
            human_override: this.takeoverActive,
            modifiers: this.mapModifiers(event),
            metadata,
        };

        this.events.push(recordedEvent);
        this.emit('event', recordedEvent);
        this.pendingKeyDown.set(event.keycode, {
            t_ms,
            hrTimeNs: hrNow,
            event: recordedEvent,
        });
    }

    private async handleKeyUp(event: HookKeyEvent) {
        if (!this.isRecording || !this.config?.recordKeyboard) return;
        const pending = this.pendingKeyDown.get(event.keycode);
        if (pending) {
            const hrNow = process.hrtime.bigint();
            const releaseTimeMs = this.getEventTimeMs(event, hrNow);
            const durationMs = Math.max(0, Number(hrNow - pending.hrTimeNs) / 1_000_000);
            pending.event.duration_ms = durationMs;
            const metadata = { ...(pending.event.metadata ?? {}) };
            metadata.release_t_ms = releaseTimeMs;
            if (event.time !== undefined) {
                metadata.release_hook_time = event.time;
            }
            pending.event.metadata = metadata;
            this.pendingKeyDown.delete(event.keycode);
            return;
        }

        const t_ms = this.getEventTimeMs(event);
        if (t_ms - this.lastEventTime < this.config.minEventInterval) return;
        this.lastEventTime = t_ms;
        const key = this.mapKey(event);

        const metadata: Record<string, unknown> = { source: 'keyboard', action: 'up' };
        if (event.time !== undefined) {
            metadata.hook_time = event.time;
        }

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
            duration_ms: 0,
            human_override: this.takeoverActive,
            modifiers: this.mapModifiers(event),
            metadata,
        };

        this.events.push(recordedEvent);
        this.emit('event', recordedEvent);
    }

    private finalizePendingInputs() {
        const hrNow = process.hrtime.bigint();
        const nowMs = Number(hrNow - this.recordingStartHrNs) / 1_000_000;
        for (const pending of this.pendingMouseDown.values()) {
            pending.event.duration_ms = Math.max(0, Number(hrNow - pending.hrTimeNs) / 1_000_000);
            pending.event.metadata = {
                ...(pending.event.metadata ?? {}),
                release_t_ms: nowMs,
            };
        }
        for (const pending of this.pendingKeyDown.values()) {
            pending.event.duration_ms = Math.max(0, Number(hrNow - pending.hrTimeNs) / 1_000_000);
            pending.event.metadata = {
                ...(pending.event.metadata ?? {}),
                release_t_ms: nowMs,
            };
        }
        this.pendingMouseDown.clear();
        this.pendingKeyDown.clear();
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

    private recordHookSample(hookTime: number, hrNowNs: bigint) {
        if (this.hookTimeBase === null) {
            this.hookTimeBase = hookTime;
            this.hookTimeOffsetMs = Number(hrNowNs - this.recordingStartHrNs) / 1_000_000;
        }
        this.hookTimeCalibrator.record(hookTime, hrNowNs);
    }

    private getHookTimeMs(hookTime: number): number | null {
        if (this.hookTimeBase === null) return null;
        const nsPerUnit = this.hookTimeCalibrator.getNsPerUnit();
        if (!nsPerUnit || !Number.isFinite(nsPerUnit) || nsPerUnit <= 0) return null;
        const hookDelta = hookTime - this.hookTimeBase;
        if (hookDelta < 0) return null;
        return this.hookTimeOffsetMs + (hookDelta * nsPerUnit) / 1_000_000;
    }

    private getEventTimeMs(event?: { time?: number }, hrNow?: bigint): number {
        const hrNowNs = hrNow ?? process.hrtime.bigint();
        const fallbackMs = Number(hrNowNs - this.recordingStartHrNs) / 1_000_000;
        const hookTime = event?.time;
        if (hookTime === undefined || hookTime === null) {
            return fallbackMs;
        }
        this.recordHookSample(hookTime, hrNowNs);
        const hookMs = this.getHookTimeMs(hookTime);
        return hookMs ?? fallbackMs;
    }

    private applyHookTiming() {
        const nsPerUnit = this.hookTimeCalibrator.getNsPerUnit();
        const hookTimeBase = this.hookTimeBase;
        if (!nsPerUnit || hookTimeBase === null) return;

        const offsetMs = this.hookTimeOffsetMs;
        let updated = false;

        this.events.forEach(event => {
            const metadata = event.metadata as Record<string, unknown> | undefined;
            if (!metadata) return;
            const hookTime = typeof metadata.hook_time === 'number' ? metadata.hook_time : undefined;
            if (hookTime === undefined) return;
            const tMs = offsetMs + ((hookTime - hookTimeBase) * nsPerUnit) / 1_000_000;
            if (!Number.isFinite(tMs)) return;
            event.t_ms = Math.max(0, tMs);
            updated = true;

            const releaseHookTime =
                typeof metadata.release_hook_time === 'number' ? metadata.release_hook_time : undefined;
            if (releaseHookTime !== undefined) {
                const releaseMs = offsetMs + ((releaseHookTime - hookTimeBase) * nsPerUnit) / 1_000_000;
                if (Number.isFinite(releaseMs)) {
                    const safeRelease = Math.max(event.t_ms, releaseMs);
                    event.duration_ms = Math.max(0, safeRelease - event.t_ms);
                    event.metadata = { ...metadata, release_t_ms: safeRelease };
                }
            }
        });

        if (updated) {
            this.events.sort((a, b) => a.t_ms - b.t_ms);
        }
    }
}
