import { EventEmitter } from 'events';
import { ModifierKey, RecordingConfig, RecordedEvent, WindowBounds } from '../types';
import { GAMEPAD_AXIS_DEADZONE, mapHookKey, mapPointerButton, pointerMovedEnough, wheelDeltas } from '../types/input';
import { capturePatch } from './screenCapture';
import { computeDHash, computeSha256 } from './imageHash';
import { GamepadSample, GamepadSource } from './gamepadSource';
import { createDefaultInputHook, HookEvent, InputHook, HookKeyEvent, HookMouseEvent, HookWheelEvent } from './inputHooks';
import { WindowManager } from './windowManager';

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
    private inputHook: InputHook;
    private windowManager: WindowManager;
    private targetBounds: WindowBounds | null = null;
    private pendingMouseDown = new Map<string, PendingInput>();
    private pendingKeyDown = new Map<number, PendingInput>();
    private pendingPadDown = new Map<string, PendingInput>();
    private lastPadAxis = new Map<string, number>();
    private lastMousePosition = { x: 0, y: 0 };
    private lastMoveSample: { x: number; y: number; t_ms: number } | null = null;
    private gamepadSource: GamepadSource | null;
    private gamepadTimer: NodeJS.Timeout | null = null;
    private gamepadActive = false;
    private takeoverActive = false;
    private hookTimeBase: number | null = null;
    private hookTimeOffsetMs = 0;
    private recordingStartHrNs: bigint = process.hrtime.bigint();
    private hookTimeCalibrator = new HookTimeCalibrator();

    constructor(options?: { inputHook?: InputHook; windowManager?: WindowManager; gamepadSource?: GamepadSource }) {
        super();
        this.inputHook = options?.inputHook ?? createDefaultInputHook();
        this.windowManager = options?.windowManager ?? new WindowManager();
        this.gamepadSource = options?.gamepadSource ?? null;
    }

    public get recording(): boolean {
        return this.isRecording;
    }

    public dispose() {
        this.stopGamepadPoll();
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
        this.hookTimeBase = null;
        this.hookTimeOffsetMs = 0;
        this.recordingStartHrNs = process.hrtime.bigint();
        this.hookTimeCalibrator.reset();
        this.pendingMouseDown.clear();
        this.pendingKeyDown.clear();
        this.pendingPadDown.clear();
        this.lastPadAxis.clear();
        this.lastMoveSample = null;
        this.targetBounds = this.windowManager.getTargetBounds(config.target);
        this.attachListeners();
        this.inputHook.start();
        this.startGamepadPoll();
        this.emit('status', { state: 'recording' });

        return { success: true };
    }

    public async stop(): Promise<{ success: boolean; profile?: any }> {
        if (!this.isRecording) {
            return { success: false };
        }

        this.pollGamepad();
        this.isRecording = false;
        this.takeoverActive = false;
        this.stopGamepadPoll();
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
        const button = mapPointerButton(event.button);
        if (!button || this.pendingMouseDown.has(button)) return;
        const hrNow = process.hrtime.bigint();
        const t_ms = this.getEventTimeMs(event, hrNow);

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
        this.inputHook.on('mousemove', (event: HookEvent) => this.handleMouseMove(event as HookMouseEvent));
        this.inputHook.on('mousedown', (event: HookEvent) => this.handleMouseDown(event as HookMouseEvent));
        this.inputHook.on('mouseup', (event: HookEvent) => void this.handleMouseUp(event as HookMouseEvent));
        this.inputHook.on('wheel', (event: HookEvent) => this.handleWheel(event as HookWheelEvent));
        this.inputHook.on('keydown', (event: HookEvent) => this.handleKeyDown(event as HookKeyEvent));
        this.inputHook.on('keyup', (event: HookEvent) => void this.handleKeyUp(event as HookKeyEvent));
    }

    private handleMouseMove(event: HookMouseEvent) {
        this.lastMousePosition = { x: event.x, y: event.y };
        const hrNow = process.hrtime.bigint();
        const t_ms = this.getEventTimeMs(event, hrNow);
        if (!this.isRecording || !this.config || this.config.recordMotion === false) return;
        const point = { x: event.x, y: event.y };
        if (!pointerMovedEnough(this.lastMoveSample, point, t_ms - (this.lastMoveSample?.t_ms ?? t_ms), this.config.minEventInterval)) {
            if (!this.lastMoveSample) this.lastMoveSample = { ...point, t_ms };
            return;
        }
        this.lastMoveSample = { ...point, t_ms };
        const { rel_x, rel_y } = this.getRelativeCoords(event.x, event.y);
        const recordedEvent: RecordedEvent = {
            t_ms,
            type: 'move',
            x: event.x,
            y: event.y,
            rel_x,
            rel_y,
            duration_ms: 0,
            human_override: this.takeoverActive,
            modifiers: this.mapModifiers(event),
            metadata: { source: 'mouse', action: 'move' },
        };
        this.events.push(recordedEvent);
        this.emit('event', recordedEvent);
    }

    private handleWheel(event: HookWheelEvent) {
        if (!this.isRecording || !this.config || this.config.recordWheel === false) return;
        const deltas = wheelDeltas(event.direction, event.rotation);
        if (!deltas) return;
        const t_ms = this.getEventTimeMs(event);
        this.lastMousePosition = { x: event.x, y: event.y };
        const { rel_x, rel_y } = this.getRelativeCoords(event.x, event.y);
        const recordedEvent: RecordedEvent = {
            t_ms,
            type: 'wheel',
            x: event.x,
            y: event.y,
            rel_x,
            rel_y,
            duration_ms: 0,
            wheel_dx: deltas.dx,
            wheel_dy: deltas.dy,
            human_override: this.takeoverActive,
            modifiers: this.mapModifiers(event),
            metadata: { source: 'mouse', action: 'wheel' },
        };
        this.events.push(recordedEvent);
        this.emit('event', recordedEvent);
    }

    private handleMouseDown(event: HookMouseEvent) {
        if (!this.isRecording || !this.config?.recordMouse) return;
        const button = mapPointerButton(event.button);
        if (!button || this.pendingMouseDown.has(button)) return;
        const hrNow = process.hrtime.bigint();
        const t_ms = this.getEventTimeMs(event, hrNow);

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
        const button = mapPointerButton(event.button);
        if (!button) return;
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
        if (this.pendingKeyDown.has(event.keycode)) return;
        const key = mapHookKey(event);
        const hrNow = process.hrtime.bigint();
        const t_ms = this.getEventTimeMs(event, hrNow);

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
        const key = mapHookKey(event);

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
        for (const pending of this.pendingPadDown.values()) {
            pending.event.duration_ms = Math.max(0, Number(hrNow - pending.hrTimeNs) / 1_000_000);
            pending.event.metadata = {
                ...(pending.event.metadata ?? {}),
                release_t_ms: nowMs,
            };
        }
        this.pendingPadDown.clear();
    }

    private startGamepadPoll() {
        if (!this.gamepadSource || !this.config || this.config.recordGamepad === false) return;
        this.gamepadSource.start();
        this.gamepadActive = true;
        this.pollGamepad();
        this.gamepadTimer = setInterval(() => this.pollGamepad(), 16);
    }

    private stopGamepadPoll() {
        if (this.gamepadTimer) {
            clearInterval(this.gamepadTimer);
            this.gamepadTimer = null;
        }
        if (!this.gamepadActive) return;
        this.gamepadActive = false;
        this.gamepadSource?.stop();
    }

    private pollGamepad() {
        if (!this.isRecording || !this.gamepadSource || this.config?.recordGamepad === false) return;
        for (const sample of this.gamepadSource.poll()) {
            this.recordGamepadSample(sample);
        }
    }

    private recordGamepadSample(sample: GamepadSample) {
        if (!this.isRecording || !this.config) return;
        const hrNow = process.hrtime.bigint();
        const t_ms = Number(hrNow - this.recordingStartHrNs) / 1_000_000;
        const key = `${sample.pad}:${sample.index}`;
        if (sample.kind === 'axis') {
            const prev = this.lastPadAxis.get(key) ?? 0;
            const next = Math.abs(sample.value) < GAMEPAD_AXIS_DEADZONE ? 0 : sample.value;
            if (Math.abs(next - prev) < 0.04) return;
            this.lastPadAxis.set(key, next);
            const { rel_x, rel_y } = this.getRelativeCoords(this.lastMousePosition.x, this.lastMousePosition.y);
            const recordedEvent: RecordedEvent = {
                t_ms,
                type: 'gamepad',
                pad: sample.pad,
                control: sample.index,
                value: next,
                x: this.lastMousePosition.x,
                y: this.lastMousePosition.y,
                rel_x,
                rel_y,
                duration_ms: 0,
                human_override: this.takeoverActive,
                metadata: { source: 'gamepad', action: 'axis', axis: true },
            };
            this.events.push(recordedEvent);
            this.emit('event', recordedEvent);
            return;
        }

        if (sample.value >= 0.5) {
            if (this.pendingPadDown.has(key)) return;
            const { rel_x, rel_y } = this.getRelativeCoords(this.lastMousePosition.x, this.lastMousePosition.y);
            const recordedEvent: RecordedEvent = {
                t_ms,
                type: 'gamepad',
                pad: sample.pad,
                control: sample.index,
                value: 1,
                x: this.lastMousePosition.x,
                y: this.lastMousePosition.y,
                rel_x,
                rel_y,
                duration_ms: 0,
                human_override: this.takeoverActive,
                metadata: { source: 'gamepad', action: 'down', axis: false },
            };
            this.events.push(recordedEvent);
            this.emit('event', recordedEvent);
            this.pendingPadDown.set(key, { t_ms, hrTimeNs: hrNow, event: recordedEvent });
            return;
        }

        const pending = this.pendingPadDown.get(key);
        if (!pending) return;
        pending.event.duration_ms = Math.max(0, Number(hrNow - pending.hrTimeNs) / 1_000_000);
        pending.event.metadata = {
            ...(pending.event.metadata ?? {}),
            release_t_ms: t_ms,
        };
        this.pendingPadDown.delete(key);
    }

    private mapModifiers(event: HookMouseEvent | HookKeyEvent | HookWheelEvent): ModifierKey[] {
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
