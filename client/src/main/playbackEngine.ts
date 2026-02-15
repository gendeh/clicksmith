import { EventEmitter } from 'events';
import { PlaybackConfig, PlaybackStatus, Profile, RecordedEvent, WindowBounds } from '../types';
import { ImageService } from '../services/imageService';
import { InputPlayer } from './inputPlayer';
import { WindowManager } from './windowManager';
import { captureRegion, captureScreen } from './screenCapture';

type Clock = {
    now: () => number;
    setTimeout: (handler: () => void, timeout: number) => NodeJS.Timeout;
    clearTimeout: (handle: NodeJS.Timeout) => void;
};

type PlaybackActionType = 'mouseDown' | 'mouseUp' | 'keyDown' | 'keyUp';

type PlaybackAction = {
    t_ms: number;
    type: PlaybackActionType;
    event: RecordedEvent;
};

type OverduePolicy = 'skip' | 'late-dispatch' | 'resync';

export class PlaybackEngine extends EventEmitter {
    private isPlaying = false;
    private config: PlaybackConfig | null = null;
    private profile: Profile | null = null;
    private currentActionIndex = 0;
    private playbackTimer: NodeJS.Timeout | null = null;
    private status: PlaybackStatus;
    private inputPlayer: InputPlayer;
    private imageService: ImageService;
    private windowManager: WindowManager;
    private clock: Clock;
    private targetBounds: WindowBounds | null = null;
    private startedAt = 0;
    private pauseStartedAt: number | null = null;
    private pausedDurationMs = 0;
    private readonly schedulerLookaheadMs = 2;
    private smartClickResults = new Map<number, { coords: { x: number; y: number }; ready: boolean }>();
    private smartClickInFlight = new Set<number>();
    private smartClickPromises = new Map<number, Promise<{ x: number; y: number }>>();
    private static readonly SMART_CLICK_AWAIT_TIMEOUT_MS = 200;
    private actions: PlaybackAction[] = [];
    private dispatchDeltaSamples: number[] = [];
    private readonly overduePolicyByAction: Record<PlaybackActionType, OverduePolicy> = {
        mouseDown: 'late-dispatch',
        mouseUp: 'late-dispatch',
        keyDown: 'late-dispatch',
        keyUp: 'late-dispatch',
    };

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

    public getElapsedMs(): number {
        if (!this.startedAt) return 0;
        const now = this.pauseStartedAt ?? this.clock.now();
        return Math.max(0, now - this.startedAt - this.pausedDurationMs);
    }

    public async start(config: PlaybackConfig, profile: Profile): Promise<{ success: boolean; error?: string }> {
        if (this.isPlaying) {
            return { success: false, error: 'Already playing' };
        }

        this.config = config;
        this.profile = profile;
        this.isPlaying = true;
        this.actions = this.buildPlaybackActions(profile);
        this.currentActionIndex = 0;
        this.startedAt = this.clock.now();
        this.pauseStartedAt = null;
        this.pausedDurationMs = 0;
        this.smartClickResults.clear();
        this.smartClickInFlight.clear();
        this.dispatchDeltaSamples = [];
        this.targetBounds = this.windowManager.getTargetBounds(config.target);
        this.status = this.createStatus('playing');
        this.emit('status', this.status);

        this.scheduleNextTick();
        return { success: true };
    }

    public async stop() {
        this.isPlaying = false;
        if (this.playbackTimer) {
            this.clock.clearTimeout(this.playbackTimer);
            this.playbackTimer = null;
        }
        this.pauseStartedAt = null;
        this.pausedDurationMs = 0;
        this.smartClickResults.clear();
        this.smartClickInFlight.clear();
        this.actions = [];
        this.currentActionIndex = 0;
        this.status = this.createStatus('idle');
        this.emit('status', this.status);
        return { success: true };
    }

    public pause() {
        if (!this.isPlaying) return;
        this.isPlaying = false;
        this.pauseStartedAt = this.clock.now();
        if (this.playbackTimer) {
            this.clock.clearTimeout(this.playbackTimer);
            this.playbackTimer = null;
        }
        this.status = { ...this.status, state: 'paused' };
        this.emit('status', this.status);
    }

    public resume() {
        if (!this.config || !this.profile || this.isPlaying) return;
        if (this.pauseStartedAt !== null) {
            this.pausedDurationMs += Math.max(0, this.clock.now() - this.pauseStartedAt);
        }
        this.pauseStartedAt = null;
        this.isPlaying = true;
        this.status = { ...this.status, state: 'playing' };
        this.emit('status', this.status);
        this.scheduleNextTick();
    }

    public async takeover() {
        this.status = { ...this.status, state: 'takeover' };
        this.emit('status', this.status);
        this.pause();
        this.emit('takeover');
        return { success: true };
    }

    private scheduleNextTick() {
        if (!this.isPlaying || !this.config || !this.profile) return;

        if (this.currentActionIndex >= this.actions.length) {
            this.finishPlayback();
            return;
        }

        const index = this.currentActionIndex;
        const action = this.actions[index];
        const speed = this.config.speedMultiplier ?? 1;

        if (action.type === 'mouseDown') {
            const expected = this.resolveCoords(action.event);
            if (!this.isRapidSequence(index, speed)) {
                this.prefetchSmartClick(index, action, expected);
            }
        }

        const now = this.clock.now();
        const dueAt = this.getActionDeadlineMs(action);
        const delay = Math.max(0, dueAt - now - this.schedulerLookaheadMs);
        if (this.playbackTimer) {
            this.clock.clearTimeout(this.playbackTimer);
            this.playbackTimer = null;
        }

        this.playbackTimer = this.clock.setTimeout(() => {
            void this.dispatchDueActions();
        }, delay);
    }

    private getActionDeadlineMs(action: PlaybackAction): number {
        const speed = this.config?.speedMultiplier ?? 1;
        return this.startedAt + this.pausedDurationMs + action.t_ms / speed;
    }

    private async dispatchDueActions() {
        if (!this.isPlaying || !this.config || !this.profile) return;

        if (this.playbackTimer) {
            this.clock.clearTimeout(this.playbackTimer);
            this.playbackTimer = null;
        }

        const tolerance = this.config.timingTolerance ?? 20;
        while (this.isPlaying && this.currentActionIndex < this.actions.length) {
            const index = this.currentActionIndex;
            const action = this.actions[index];
            const scheduledAt = this.getActionDeadlineMs(action);
            const now = this.clock.now();
            const leadMs = scheduledAt - now;
            if (leadMs > this.schedulerLookaheadMs) {
                break;
            }

            const overdueMs = now - scheduledAt;
            const overduePolicy = this.overduePolicyByAction[action.type];

            if (overduePolicy === 'skip' && overdueMs > tolerance) {
                this.status = {
                    ...this.status,
                    state: 'playing',
                    currentEventIndex: index,
                    totalEvents: this.actions.length,
                    elapsedMs: this.getElapsedMs(),
                    timingDrift: overdueMs,
                    lastError: 'playback_event_skipped',
                };
                this.emit('status', this.status);
                this.smartClickResults.delete(index);
                this.currentActionIndex = index + 1;
                continue;
            }

            if (overduePolicy === 'resync' && overdueMs > tolerance) {
                this.startedAt += overdueMs;
            }

            const coords =
                action.type === 'mouseDown'
                    ? await this.getSmartClickCoords(index, this.resolveCoords(action.event))
                    : null;

            // Capture actualAt AFTER the SmartClick await so the image match
            // wait time does not inflate the timing drift measurement.
            const actualAt = this.clock.now();

            // Resync the timeline so that SmartClick wait time doesn't
            // cascade drift to every subsequent event.
            const smartClickWait = actualAt - scheduledAt;
            if (smartClickWait > tolerance && coords !== null) {
                this.startedAt += smartClickWait;
            }

            let shouldAdvanceIndex = true;
            try {
                // Playback state may change while awaiting SmartClick matching.
                if (!this.isPlaying) {
                    shouldAdvanceIndex = false;
                    break;
                }
                await this.executeAction(action, coords, index, scheduledAt, actualAt);
            } catch (error) {
                this.status = { ...this.status, lastError: 'playback_event_failed' };
                this.emit('error', error);
            } finally {
                this.smartClickResults.delete(index);
                if (shouldAdvanceIndex) {
                    this.currentActionIndex = index + 1;
                }
            }
        }

        if (!this.isPlaying) return;

        if (this.currentActionIndex >= this.actions.length) {
            this.finishPlayback();
            return;
        }

        this.scheduleNextTick();
    }

    private isRapidSequence(index: number, speed: number): boolean {
        const next = this.actions[index + 1];
        if (!next) return false;
        const gapMs = (next.t_ms - this.actions[index].t_ms) / speed;
        const threshold = Math.max(30, (this.config?.timingTolerance ?? 20) * 1.5);
        return gapMs > 0 && gapMs <= threshold;
    }

    private async executeAction(
        action: PlaybackAction,
        coords: { x: number; y: number } | null,
        eventIndex: number,
        scheduledAtMs: number,
        actualAtMs: number
    ) {
        if (!this.config) return;
        this.emit('dispatch', {
            actionType: action.type,
            eventIndex,
            scheduledAtMs,
            actualAtMs,
        });

        if (action.type === 'mouseDown') {
            const button = action.event.btn ?? 'left';
            if (coords) {
                this.inputPlayer.moveMouse(coords.x, coords.y);
            }
            this.inputPlayer.mouseDown(button);
        } else if (action.type === 'mouseUp') {
            const button = action.event.btn ?? 'left';
            this.inputPlayer.mouseUp(button);
        } else if (action.type === 'keyDown') {
            this.playKeyDown(action.event);
        } else if (action.type === 'keyUp') {
            this.playKeyUp(action.event);
        }

        this.status = this.updateStatus(this.status, action, eventIndex, scheduledAtMs, actualAtMs);
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

    private prefetchSmartClick(index: number, action: PlaybackAction, expected: { x: number; y: number }) {
        const config = this.config;
        if (action.type !== 'mouseDown' || !config?.useImageMatching || !action.event.img_patch_b64) {
            return;
        }
        if (this.smartClickInFlight.has(index) || this.smartClickResults.has(index)) return;
        this.smartClickInFlight.add(index);
        const promise = this.resolveSmartClick(action.event, expected)
            .then(coords => {
                this.smartClickResults.set(index, { coords, ready: true });
                return coords;
            })
            .finally(() => {
                this.smartClickInFlight.delete(index);
                this.smartClickPromises.delete(index);
            });
        this.smartClickPromises.set(index, promise);
    }

    private async getSmartClickCoords(index: number, expected: { x: number; y: number }) {
        const cached = this.smartClickResults.get(index);
        if (cached?.ready) {
            return cached.coords;
        }

        const inflight = this.smartClickPromises.get(index);
        if (inflight) {
            try {
                const coords = await Promise.race([
                    inflight,
                    new Promise<null>((resolve) =>
                        setTimeout(() => resolve(null), PlaybackEngine.SMART_CLICK_AWAIT_TIMEOUT_MS)
                    ),
                ]);
                if (coords) return coords;
            } catch {
                // resolve failed; fall back to expected
            }
        }

        return expected;
    }

    private async resolveSmartClick(event: RecordedEvent, expected: { x: number; y: number }) {
        const config = this.config;
        if (!config?.useImageMatching || !event.img_patch_b64) {
            return expected;
        }

        const searchRadius = config.imageSearchRadius ?? 160;
        const region = {
            x: Math.max(0, expected.x - searchRadius),
            y: Math.max(0, expected.y - searchRadius),
            width: searchRadius * 2,
            height: searchRadius * 2,
        };

        for (let attempt = 0; attempt <= config.retryCount; attempt += 1) {
            try {
                const searchArea = await captureRegion(region);
                const response = await this.imageService.matchImage({
                    template: event.img_patch_b64,
                    searchArea: searchArea.toString('base64'),
                    threshold: config.imageMatchThreshold,
                    method: 'hybrid',
                    findAll: false,
                    maxMatches: 1,
                });

                if (response.success && response.bestMatch && response.bestMatch.confidence >= config.imageMatchThreshold) {
                    this.status = {
                        ...this.status,
                        successfulMatches: this.status.successfulMatches + 1,
                    };
                    return {
                        x: region.x + response.bestMatch.x,
                        y: region.y + response.bestMatch.y,
                    };
                }

                if (!response.success && response.error) {
                    const errorText = response.error.toLowerCase();
                    if (errorText.includes('econnrefused') || errorText.includes('fetch failed')) {
                        this.status = { ...this.status };
                        return expected;
                    }
                }
            } catch (error: any) {
                const text = String(error?.message ?? '').toLowerCase();
                if (text.includes('econnrefused') || text.includes('fetch failed')) {
                    return expected;
                }
                this.status = { ...this.status, lastError: 'image_match_failed' };
            }

            if (attempt < config.retryCount) {
                this.status = { ...this.status, retries: this.status.retries + 1 };
                await new Promise(resolve => setTimeout(resolve, config.retryDelay));
            }
        }

        // Fallback to full-screen matching when local window-relative prediction is far off.
        try {
            const fullScreen = await captureScreen();
            const response = await this.imageService.matchImage({
                template: event.img_patch_b64,
                searchArea: fullScreen.toString('base64'),
                threshold: config.imageMatchThreshold,
                method: 'hybrid',
                findAll: false,
                maxMatches: 1,
            });
            if (response.success && response.bestMatch && response.bestMatch.confidence >= config.imageMatchThreshold) {
                this.status = {
                    ...this.status,
                    successfulMatches: this.status.successfulMatches + 1,
                };
                return {
                    x: response.bestMatch.x,
                    y: response.bestMatch.y,
                };
            }
        } catch {
            this.status = { ...this.status, lastError: 'image_match_failed' };
        }

        this.status = { ...this.status, failedMatches: this.status.failedMatches + 1 };
        return expected;
    }

    private playKeyDown(event: RecordedEvent) {
        const key = event.key ?? (event.keyCode ? `key_${event.keyCode}` : '');
        if (!key) return;
        const modifiers = event.modifiers ?? [];
        modifiers.forEach(mod => this.inputPlayer.keyDown(mod));
        this.inputPlayer.keyDown(key);
    }

    private playKeyUp(event: RecordedEvent) {
        const key = event.key ?? (event.keyCode ? `key_${event.keyCode}` : '');
        if (!key) return;
        this.inputPlayer.keyUp(key);
        const modifiers = event.modifiers ?? [];
        modifiers.forEach(mod => this.inputPlayer.keyUp(mod));
    }

    private buildPlaybackActions(profile: Profile): PlaybackAction[] {
        const adjustments = profile.metadata?.custom?.timing_adjustments as number[] | undefined;
        const snapHz = this.config?.snapToHz ?? 0;
        const snapMs = snapHz > 0 ? 1000 / snapHz : null;
        const snapMode = this.config?.snapMode ?? 'nearest';
        const snapPhaseRaw = this.config?.snapPhaseMs ?? 0;
        const phaseOffset =
            snapMs && snapMs > 0 ? ((snapPhaseRaw % snapMs) + snapMs) % snapMs : 0;
        const snapTime = (timeMs: number) => {
            if (!snapMs) return timeMs;
            const shifted = timeMs - phaseOffset;
            if (snapMode === 'floor') {
                return phaseOffset + Math.floor(shifted / snapMs) * snapMs;
            }
            return phaseOffset + Math.round(shifted / snapMs) * snapMs;
        };
        const actions: PlaybackAction[] = [];

        profile.events.forEach((event, index) => {
            const metadata = event.metadata as Record<string, unknown> | undefined;
            if (metadata?.takeover_marker) return;
            const jitter = adjustments?.[index] ?? 0;

            if (event.type === 'mouse') {
                const { pressTime, releaseTime } = this.getPressReleaseTimes(event);
                if (releaseTime !== null) {
                    const rawPress = Math.max(0, pressTime + jitter);
                    const rawRelease = Math.max(rawPress, releaseTime + jitter);
                    let pressAt = rawPress;
                    let releaseAt = rawRelease;

                    if (snapMs && snapMode === 'duration-lock' && rawRelease > rawPress) {
                        const pressTick = Math.round((rawPress - phaseOffset) / snapMs);
                        const durationTicks = Math.max(1, Math.round((rawRelease - rawPress) / snapMs));
                        pressAt = phaseOffset + pressTick * snapMs;
                        releaseAt = pressAt + durationTicks * snapMs;
                    } else {
                        pressAt = snapTime(rawPress);
                        releaseAt = snapTime(rawRelease);
                        if (releaseAt < pressAt) {
                            releaseAt = pressAt;
                        }
                        if (snapMs && releaseAt === pressAt && rawRelease > rawPress) {
                            releaseAt = pressAt + snapMs;
                        }
                    }
                    actions.push({ t_ms: pressAt, type: 'mouseDown', event });
                    actions.push({ t_ms: releaseAt, type: 'mouseUp', event });
                } else {
                    const time = snapTime(Math.max(0, event.t_ms + jitter));
                    actions.push({ t_ms: time, type: 'mouseDown', event });
                    actions.push({ t_ms: time, type: 'mouseUp', event });
                }
            } else if (event.type === 'keyboard') {
                const { pressTime, releaseTime } = this.getPressReleaseTimes(event);
                if (releaseTime !== null) {
                    const rawPress = Math.max(0, pressTime + jitter);
                    const rawRelease = Math.max(rawPress, releaseTime + jitter);
                    let pressAt = rawPress;
                    let releaseAt = rawRelease;

                    if (snapMs && snapMode === 'duration-lock' && rawRelease > rawPress) {
                        const pressTick = Math.round((rawPress - phaseOffset) / snapMs);
                        const durationTicks = Math.max(1, Math.round((rawRelease - rawPress) / snapMs));
                        pressAt = phaseOffset + pressTick * snapMs;
                        releaseAt = pressAt + durationTicks * snapMs;
                    } else {
                        pressAt = snapTime(rawPress);
                        releaseAt = snapTime(rawRelease);
                        if (releaseAt < pressAt) {
                            releaseAt = pressAt;
                        }
                        if (snapMs && releaseAt === pressAt && rawRelease > rawPress) {
                            releaseAt = pressAt + snapMs;
                        }
                    }
                    actions.push({ t_ms: pressAt, type: 'keyDown', event });
                    actions.push({ t_ms: releaseAt, type: 'keyUp', event });
                } else {
                    const time = snapTime(Math.max(0, event.t_ms + jitter));
                    actions.push({ t_ms: time, type: 'keyDown', event });
                    actions.push({ t_ms: time, type: 'keyUp', event });
                }
            }
        });

        return actions.sort((a, b) => {
            if (a.t_ms !== b.t_ms) return a.t_ms - b.t_ms;
            return this.actionOrder(a.type) - this.actionOrder(b.type);
        });
    }

    private getPressReleaseTimes(event: RecordedEvent): { pressTime: number; releaseTime: number | null } {
        const metadata = event.metadata as Record<string, unknown> | undefined;
        const action = typeof metadata?.action === 'string' ? metadata?.action : undefined;
        const releaseTime =
            typeof metadata?.release_t_ms === 'number' ? (metadata?.release_t_ms as number) : undefined;
        const duration = event.duration_ms;

        if (duration > 0 || releaseTime !== undefined) {
            if (action === 'down') {
                return {
                    pressTime: event.t_ms,
                    releaseTime: releaseTime ?? event.t_ms + duration,
                };
            }
            if (action === 'up') {
                return {
                    pressTime: Math.max(0, event.t_ms - duration),
                    releaseTime: event.t_ms,
                };
            }

            if (releaseTime !== undefined) {
                return {
                    pressTime: Math.max(0, releaseTime - duration),
                    releaseTime,
                };
            }

            return {
                pressTime: Math.max(0, event.t_ms - duration),
                releaseTime: event.t_ms,
            };
        }

        return { pressTime: event.t_ms, releaseTime: null };
    }

    private actionOrder(type: PlaybackActionType): number {
        switch (type) {
            case 'mouseDown':
                return 0;
            case 'keyDown':
                return 1;
            case 'mouseUp':
                return 2;
            case 'keyUp':
                return 3;
            default:
                return 4;
        }
    }

    private finishPlayback() {
        this.isPlaying = false;
        this.pauseStartedAt = null;
        this.status = { ...this.status, state: 'idle' };
        this.emit('status', this.status);
        this.emit('metrics', this.getMetricsSummary());
        this.emit('complete', this.status);
    }

    private createStatus(state: PlaybackStatus['state']): PlaybackStatus {
        return {
            state,
            currentEventIndex: this.currentActionIndex,
            totalEvents: this.actions.length,
            elapsedMs: 0,
            successfulMatches: 0,
            failedMatches: 0,
            retries: 0,
            timingDrift: 0,
        };
    }

    private updateStatus(
        status: PlaybackStatus,
        action: PlaybackAction,
        eventIndex: number,
        scheduledAtMs: number,
        actualAtMs: number
    ): PlaybackStatus {
        const elapsed = this.getElapsedMs();
        const drift = actualAtMs - scheduledAtMs;
        this.dispatchDeltaSamples.push(Math.abs(drift));
        const driftError =
            Math.abs(drift) > (this.config?.timingTolerance ?? 20) ? 'timing_drift_exceeded' : status.lastError;
        return {
            ...status,
            currentEventIndex: eventIndex,
            totalEvents: this.actions.length,
            elapsedMs: elapsed,
            timingDrift: drift,
            lastError: driftError,
        };
    }

    private getMetricsSummary() {
        if (this.dispatchDeltaSamples.length === 0) {
            return { count: 0, p50: 0, p95: 0, p99: 0 };
        }
        const sorted = [...this.dispatchDeltaSamples].sort((a, b) => a - b);
        const percentile = (p: number) => {
            const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
            return sorted[idx];
        };
        return {
            count: sorted.length,
            p50: percentile(0.5),
            p95: percentile(0.95),
            p99: percentile(0.99),
        };
    }
}
