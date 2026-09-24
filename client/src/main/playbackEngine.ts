import { EventEmitter } from 'events';
import { MatchResult, OcrItem, PlaybackConfig, PlaybackStatus, Profile, RecordedEvent, WindowBounds } from '../types';
import { ImageService } from '../services/imageService';
import { InputPlayer } from './inputPlayer';
import { WindowManager } from './windowManager';
import { capturePatch, captureRegion, captureScreen } from './screenCapture';
import { computeDHash } from './imageHash';
import { CoordinateNormalizer } from './coordinateNormalizer';

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
type SmartClickSource =
    | 'window'
    | 'region'
    | 'fullscreen'
    | 'anchor_fallback'
    | 'expected_fallback'
    | 'service_unavailable_fallback';
type SmartClickStage = 'target_window' | 'region' | 'fullscreen';
type AnchorRankingMode = 'strict' | 'relaxed';
type SmartClickCandidateSelection = {
    coords: { x: number; y: number };
    confidence: number;
    dhashDistance?: number;
    method?: string;
    scale?: number;
};
type SmartClickViableCandidate = {
    coords: { x: number; y: number };
    confidence: number;
    method: string;
    scale?: number;
    scaleRank: number;
    dhashDistance: number | null | undefined;
    anchorRank: number;
    expectedDistance: number;
    inPreferredBounds: boolean;
    passesHashGate: boolean | undefined;
    matchBounds?: { x: number; y: number; width: number; height: number };
};
type SmartClickAdaptationReason = 'bounds_change' | 'scale_shift_evidence' | 'failure_streak';

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
    private dispatchingAction = false;
    private readonly schedulerLookaheadMs = 2;
    private smartClickResults = new Map<
        number,
        { coords: { x: number; y: number }; ready: boolean; bounds: WindowBounds | null }
    >();
    private smartClickInFlight = new Set<number>();
    private smartClickPromises = new Map<number, Promise<{ x: number; y: number }>>();
    private smartClickTelemetry = new Map<number, { open: boolean }>();
    private static readonly SMART_CLICK_MAX_BUDGET_MS = 260;
    private static readonly SMART_CLICK_BOUNDS_WAIT_MS = 200;
    private static readonly SMART_CLICK_AWAIT_TIMEOUT_MS =
        PlaybackEngine.SMART_CLICK_BOUNDS_WAIT_MS + PlaybackEngine.SMART_CLICK_MAX_BUDGET_MS;
    private static readonly SMART_CLICK_MIN_SCALE = 0.7;
    private static readonly SMART_CLICK_MAX_SCALE = 1.4;
    private static readonly SMART_CLICK_ADAPTIVE_MIN_SCALE = 0.55;
    private static readonly SMART_CLICK_ADAPTIVE_MAX_SCALE = 1.9;
    private static readonly SMART_CLICK_SCALE_SMOOTHING_ALPHA = 0.6;
    private static readonly SMART_CLICK_ADAPTATION_CLICKS = 5;
    private static readonly SMART_CLICK_FAILURES_TO_ADAPT = 2;
    private static readonly SMART_CLICK_ENV_WIDTH_DELTA_PX = 80;
    private static readonly SMART_CLICK_ENV_AREA_RATIO_MIN = 0.85;
    private static readonly SMART_CLICK_ENV_AREA_RATIO_MAX = 1.15;
    private static readonly SMART_CLICK_MAX_REGION_CANDIDATES = 6;
    private static readonly SMART_CLICK_MAX_WINDOW_CANDIDATES = 8;
    private static readonly SMART_CLICK_MAX_FULLSCREEN_CANDIDATES = 10;
    private static readonly SMART_CLICK_MAX_HASH_EVALS = 8;
    private static readonly SMART_CLICK_DHASH_MAX_DISTANCE = 32;
    private static readonly SMART_CLICK_DHASH_WEAK_MAX_DISTANCE = 12;
    private static readonly SMART_CLICK_DHASH_SCALED_WEAK_MAX_DISTANCE = 20;
    private static readonly SMART_CLICK_STRONG_MATCH_CONFIDENCE = 0.92;
    private static readonly SMART_CLICK_COLLECTION_MIN_CONFIDENCE = 0.25;
    private static readonly SMART_CLICK_ADAPTIVE_COLLECTION_MIN_CONFIDENCE = 0.2;
    private static readonly SMART_CLICK_ANCHOR_MAX_ABS_OFFSET_PX = 520;
    private static readonly SMART_CLICK_ANCHOR_BIAS_MAX_SCALE_DELTA = 0.08;
    private static readonly SMART_CLICK_ANCHOR_MIN_TRUST = 1;
    private static readonly SMART_CLICK_ANCHOR_BIAS_MIN_TRUST = 2;
    private static readonly SMART_CLICK_SCALE_SHIFT_TRIGGER = 0.12;
    private static readonly SMART_CLICK_HASH_SKIP_SCALE_DELTA = 0.10;
    private static readonly SMART_CLICK_SCALE_EVIDENCE_MIN_CONFIDENCE = 0.58;
    private static readonly SMART_CLICK_CONFIRM_SCALE_DELTA = 0.08;
    private static readonly SMART_CLICK_CONFIRM_COORD_DELTA_PX = 28;
    private static readonly SMART_CLICK_CONFIRM_MIN_CONFIDENCE = 0.55;
    private static readonly SMART_CLICK_OCR_MIN_TEXT_LEN = 2;
    private static readonly SMART_CLICK_OCR_RESERVE_MS = 120;
    private static readonly SMART_CLICK_CONTEXT_RESERVE_MS = 80;
    private actions: PlaybackAction[] = [];
    private dispatchDeltaSamples: number[] = [];
    private smartClickAnchor: { dx: number; dy: number } | null = null;
    private smartClickAnchorTrust = 0;
    private smartClickRecordedScale: number | null = 1.0;
    private smartClickLastStableScale: number | null = 1.0;
    private smartClickScaleHint: number | null = 1.0;
    private smartClickAdaptationClicksLeft = 0;
    private smartClickLastTargetBounds: WindowBounds | null = null;
    private smartClickAttemptBounds: WindowBounds | null = null;
    private smartClickConsecutiveFailures = 0;
    private smartClickAdaptationReason: SmartClickAdaptationReason | null = null;
    private sharpLib: any | null = null;
    private readonly smartClickTraceEnabled = process.env.CLICKSMITH_SMARTCLICK_TRACE === '1';
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

    public getTakeoverAnchorMs(): number {
        const elapsed = this.getElapsedMs();
        if (!this.isPlaying) return elapsed;
        const current = this.actions[this.currentActionIndex];
        if (!current) return elapsed;
        if (!this.dispatchingAction) {
            return Math.min(elapsed, current.t_ms);
        }
        for (let i = this.currentActionIndex + 1; i < this.actions.length; i += 1) {
            if (this.actions[i].t_ms > current.t_ms) {
                return Math.min(elapsed, this.actions[i].t_ms);
            }
        }
        return current.t_ms + 1;
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
        this.smartClickAnchor = null;
        this.smartClickAnchorTrust = 0;
        this.initializeSmartClickScaleState(profile);
        this.smartClickAdaptationClicksLeft = 0;
        this.smartClickLastTargetBounds = null;
        this.smartClickAttemptBounds = null;
        this.smartClickConsecutiveFailures = 0;
        this.smartClickAdaptationReason = null;
        const normalizedTarget = (config.target || '').trim().toLowerCase();
        const namedTarget = normalizedTarget.length > 0 && normalizedTarget !== 'screen';
        this.targetBounds = this.windowManager.getTargetBounds(config.target);
        let boundsTimer: NodeJS.Timeout | null = null;
        const knownBounds = () => {
            const knownLookup = (this.windowManager as {
                getKnownTargetBounds?: (target: string) => WindowBounds | null;
            }).getKnownTargetBounds;
            return typeof knownLookup === 'function'
                ? knownLookup.call(this.windowManager, config.target)
                : null;
        };
        try {
            const asyncBounds = await Promise.race([
                this.windowManager.getTargetBoundsAsync(config.target),
                new Promise<WindowBounds | null>((resolve) => {
                    boundsTimer = this.clock.setTimeout(
                        () => resolve(null),
                        PlaybackEngine.SMART_CLICK_BOUNDS_WAIT_MS
                    );
                }),
            ]);
            if (asyncBounds) {
                this.targetBounds = asyncBounds;
            } else if (namedTarget) {
                this.targetBounds = knownBounds();
            }
        } catch {
            if (namedTarget) {
                this.targetBounds = knownBounds();
            }
        } finally {
            if (boundsTimer) this.clock.clearTimeout(boundsTimer);
        }
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
        this.smartClickAnchor = null;
        this.smartClickAnchorTrust = 0;
        this.smartClickRecordedScale = 1.0;
        this.smartClickLastStableScale = 1.0;
        this.smartClickScaleHint = 1.0;
        this.smartClickAdaptationClicksLeft = 0;
        this.smartClickLastTargetBounds = null;
        this.smartClickAttemptBounds = null;
        this.smartClickConsecutiveFailures = 0;
        this.smartClickAdaptationReason = null;
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

    private getSmartClickTargetBoundsSync(): WindowBounds | null {
        if (!this.config?.useImageMatching) return null;
        const normalizedTarget = (this.config.target || '').trim().toLowerCase();
        if (!normalizedTarget || normalizedTarget === 'screen') {
            return null;
        }
        const knownLookup = (this.windowManager as {
            getKnownTargetBounds?: (target: string) => WindowBounds | null;
        }).getKnownTargetBounds;
        if (typeof knownLookup === 'function') {
            return knownLookup.call(this.windowManager, this.config.target);
        }
        try {
            return this.windowManager.getTargetBounds(this.config.target);
        } catch {
            return null;
        }
    }

    private async getSmartClickTargetBoundsAsync(deadline?: number): Promise<WindowBounds | null> {
        if (!this.config?.useImageMatching) return null;
        const normalizedTarget = (this.config.target || '').trim().toLowerCase();
        if (!normalizedTarget || normalizedTarget === 'screen') {
            return null;
        }
        const lookupFn = this.windowManager.getTargetBoundsAsync;
        if (typeof lookupFn !== 'function') {
            return this.getSmartClickTargetBoundsSync();
        }
        const budgetLeft = deadline === undefined
            ? PlaybackEngine.SMART_CLICK_MAX_BUDGET_MS
            : Math.max(0, deadline - this.clock.now());
        const waitMs = Math.min(
            PlaybackEngine.SMART_CLICK_BOUNDS_WAIT_MS,
            budgetLeft
        );
        let timer: NodeJS.Timeout | null = null;
        try {
            const lookup = lookupFn.call(this.windowManager, this.config.target);
            const asyncBounds = await Promise.race([
                lookup,
                new Promise<WindowBounds | null>((resolve) => {
                    timer = this.clock.setTimeout(() => resolve(null), waitMs);
                }),
            ]);
            if (asyncBounds) return asyncBounds;
            return null;
        } catch {
            return this.getSmartClickTargetBoundsSync();
        } finally {
            if (timer) this.clock.clearTimeout(timer);
        }
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

            this.dispatchingAction = true;
            let shouldAdvanceIndex = true;
            let coords: { x: number; y: number } | null = null;
            try {
                coords =
                    action.type === 'mouseDown'
                        ? await this.getSmartClickCoords(index, action.event, this.resolveCoords(action.event))
                        : null;

                const actualAt = this.clock.now();
                if (!this.isPlaying) {
                    shouldAdvanceIndex = false;
                    break;
                }
                await this.executeAction(action, coords, index, scheduledAt, actualAt);
            } catch (error) {
                this.status = { ...this.status, lastError: 'playback_event_failed' };
                this.emit('error', error);
            } finally {
                this.dispatchingAction = false;
                const postedAt = this.clock.now();
                const smartClickWait = postedAt - scheduledAt;
                if (smartClickWait > tolerance && coords !== null) {
                    this.startedAt += smartClickWait;
                }
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
        const refreshedBounds = this.getSmartClickTargetBoundsSync();
        if (refreshedBounds) {
            this.targetBounds = refreshedBounds;
        }
        if (!Number.isFinite(event.rel_x) || !Number.isFinite(event.rel_y)) {
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
        const telemetry = { open: true };
        this.smartClickTelemetry.set(index, telemetry);
        const promise = this.resolveSmartClick(action.event, expected, true, telemetry)
            .then((coords: { x: number; y: number }) => {
                const bounds = this.smartClickAttemptBounds;
                this.smartClickResults.set(index, {
                    coords,
                    ready: true,
                    bounds: bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null,
                });
                return coords;
            })
            .finally(() => {
                this.smartClickInFlight.delete(index);
                this.smartClickPromises.delete(index);
                this.smartClickTelemetry.delete(index);
            });
        this.smartClickPromises.set(index, promise);
    }

    private sameWindowBounds(a: WindowBounds | null, b: WindowBounds | null): boolean {
        if (!a || !b) return a === b;
        return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
    }

    private knownWindowBounds(): WindowBounds | null | undefined {
        if (!this.config?.useImageMatching) return undefined;
        const normalizedTarget = (this.config.target || '').trim().toLowerCase();
        if (!normalizedTarget || normalizedTarget === 'screen') return null;
        const knownLookup = (this.windowManager as {
            getKnownTargetBounds?: (target: string) => WindowBounds | null;
        }).getKnownTargetBounds;
        if (typeof knownLookup !== 'function') return undefined;
        return knownLookup.call(this.windowManager, this.config.target);
    }

    private async getSmartClickCoords(index: number, event: RecordedEvent, expected: { x: number; y: number }) {
        const cached = this.smartClickResults.get(index);
        if (cached?.ready) {
            if (this.sameWindowBounds(cached.bounds, this.getSmartClickTargetBoundsSync())) {
                return cached.coords;
            }
            this.smartClickResults.delete(index);
        }

        const inflight = this.smartClickPromises.get(index);
        if (inflight) {
            const telemetry = this.smartClickTelemetry.get(index);
            const coords = await this.finishSmartClickWait(inflight, event, expected, telemetry);
            const live = this.knownWindowBounds();
            if (
                !telemetry?.open ||
                live === undefined ||
                this.sameWindowBounds(this.smartClickAttemptBounds, live)
            ) {
                return coords;
            }
            this.smartClickResults.delete(index);
        }

        const telemetry = { open: true };
        return this.finishSmartClickWait(
            this.resolveSmartClick(event, expected, true, telemetry),
            event,
            expected,
            telemetry
        );
    }

    private async finishSmartClickWait(
        work: Promise<{ x: number; y: number }>,
        event: RecordedEvent,
        expected: { x: number; y: number },
        telemetry?: { open: boolean }
    ): Promise<{ x: number; y: number }> {
        let timer: NodeJS.Timeout | null = null;
        try {
            const coords = await Promise.race([
                work,
                new Promise<null>((resolve) => {
                    timer = this.clock.setTimeout(
                        () => resolve(null),
                        PlaybackEngine.SMART_CLICK_AWAIT_TIMEOUT_MS
                    );
                }),
            ]);
            if (coords) return coords;
            if (telemetry) telemetry.open = false;
            this.status = { ...this.status, retries: this.status.retries + 1 };
            this.degradeSmartClickAnchor();
            return this.useSmartClickFallback(this.liveFallbackPoint(event, expected));
        } catch {
            this.degradeSmartClickAnchor();
            return this.useSmartClickFallback(this.liveFallbackPoint(event, expected));
        } finally {
            if (timer) this.clock.clearTimeout(timer);
        }
    }

    private liveFallbackPoint(
        event: RecordedEvent,
        expected: { x: number; y: number }
    ): { x: number; y: number } {
        return this.relativeFallbackPoint(event, this.smartClickAttemptBounds) ?? expected;
    }

    private useSmartClickFallback(expected: { x: number; y: number }): { x: number; y: number } {
        const fallback = this.applySmartClickAnchor(expected);
        const anchored = fallback.x !== expected.x || fallback.y !== expected.y;
        this.markSmartClickSource(anchored ? 'anchor_fallback' : 'expected_fallback');
        return fallback;
    }

    private relativeFallbackPoint(
        event: RecordedEvent,
        bounds: WindowBounds | null
    ): { x: number; y: number } | null {
        if (!bounds || !this.config?.useRelativeCoords) return null;
        if (!Number.isFinite(event.rel_x) || !Number.isFinite(event.rel_y)) return null;
        return {
            x: Math.round(bounds.x + bounds.width * event.rel_x),
            y: Math.round(bounds.y + bounds.height * event.rel_y),
        };
    }

    private applySmartClickAnchor(expected: { x: number; y: number }) {
        if (!this.smartClickAnchor) return expected;
        if (this.smartClickAnchorTrust < PlaybackEngine.SMART_CLICK_ANCHOR_MIN_TRUST) return expected;
        if (
            Math.abs(this.smartClickAnchor.dx) > PlaybackEngine.SMART_CLICK_ANCHOR_MAX_ABS_OFFSET_PX ||
            Math.abs(this.smartClickAnchor.dy) > PlaybackEngine.SMART_CLICK_ANCHOR_MAX_ABS_OFFSET_PX
        ) {
            return expected;
        }
        return {
            x: Math.round(expected.x + this.smartClickAnchor.dx),
            y: Math.round(expected.y + this.smartClickAnchor.dy),
        };
    }

    private degradeSmartClickAnchor() {
        if (!this.smartClickAnchor) {
            this.smartClickAnchorTrust = 0;
            return;
        }
        this.smartClickAnchorTrust = Math.max(0, this.smartClickAnchorTrust - 1);
        if (this.smartClickAnchorTrust === 0) {
            this.smartClickAnchor = null;
            this.status = {
                ...this.status,
                smartClickAnchorDx: undefined,
                smartClickAnchorDy: undefined,
                smartClickAnchorTrust: 0,
            };
            return;
        }
        this.status = {
            ...this.status,
            smartClickAnchorTrust: this.smartClickAnchorTrust,
        };
    }

    private shouldApplyAnchorBias(): boolean {
        if (!this.smartClickAnchor) return false;
        if (this.smartClickAdaptationClicksLeft > 0) return false;
        if (this.smartClickAnchorTrust < PlaybackEngine.SMART_CLICK_ANCHOR_BIAS_MIN_TRUST) return false;
        const hint = this.smartClickScaleHint ?? this.smartClickRecordedScale ?? 1.0;
        const baseline = this.smartClickRecordedScale ?? 1.0;
        return Math.abs(hint - baseline) <= PlaybackEngine.SMART_CLICK_ANCHOR_BIAS_MAX_SCALE_DELTA;
    }

    private getSmartClickScaleBaseline(): number {
        return this.smartClickLastStableScale ?? this.smartClickRecordedScale ?? 1.0;
    }

    private getSmartClickScaleReference(): number {
        return this.smartClickScaleHint ?? this.smartClickLastStableScale ?? this.smartClickRecordedScale ?? 1.0;
    }

    private hasMeaningfulScaleShift(scale?: number, reference = this.getSmartClickScaleBaseline()): boolean {
        if (!Number.isFinite(scale)) return false;
        return Math.abs(Number(scale) - reference) >= PlaybackEngine.SMART_CLICK_SCALE_SHIFT_TRIGGER;
    }

    private clearSmartClickAnchor() {
        this.smartClickAnchor = null;
        this.smartClickAnchorTrust = 0;
        this.status = {
            ...this.status,
            smartClickAnchorDx: undefined,
            smartClickAnchorDy: undefined,
            smartClickAnchorTrust: 0,
        };
    }

    private getRecordedMatchScale(event?: RecordedEvent): number {
        const metadata = event?.metadata as Record<string, unknown> | undefined;
        const raw = metadata?.recorded_match_scale;
        const parsed = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0) return 1.0;
        return parsed;
    }

    private initializeSmartClickScaleState(profile?: Profile) {
        let recordedScale = 1.0;
        for (const event of profile?.events ?? []) {
            const scale = this.getRecordedMatchScale(event);
            if (Number.isFinite(scale) && scale > 0) {
                recordedScale = scale;
                break;
            }
        }
        this.smartClickRecordedScale = recordedScale;
        this.smartClickLastStableScale = recordedScale;
        this.smartClickScaleHint = recordedScale;
    }

    private isSmartClickScaleInWindow(scale: number | undefined, adaptationMode: boolean): boolean {
        if (scale === undefined || !Number.isFinite(scale)) return true;
        const scaleWindow = this.getSmartClickScaleWindow(adaptationMode);
        const slack = 0.05;
        return scale >= scaleWindow.minScale - slack && scale <= scaleWindow.maxScale + slack;
    }

    private isReportableSmartClickScale(scale: number): boolean {
        const slack = 0.05;
        return (
            scale >= PlaybackEngine.SMART_CLICK_ADAPTIVE_MIN_SCALE - slack &&
            scale <= PlaybackEngine.SMART_CLICK_ADAPTIVE_MAX_SCALE + slack
        );
    }

    private getSmartClickScaleWindow(adaptationMode: boolean): { minScale: number; maxScale: number } {
        if (adaptationMode) {
            return {
                minScale: PlaybackEngine.SMART_CLICK_ADAPTIVE_MIN_SCALE,
                maxScale: PlaybackEngine.SMART_CLICK_ADAPTIVE_MAX_SCALE,
            };
        }
        return {
            minScale: PlaybackEngine.SMART_CLICK_MIN_SCALE,
            maxScale: PlaybackEngine.SMART_CLICK_MAX_SCALE,
        };
    }

    private recordSmartClickStableScale(scale?: number) {
        if (!Number.isFinite(scale)) return;
        this.smartClickLastStableScale = Number(scale);
        this.status = {
            ...this.status,
            smartClickLastStableScale: this.smartClickLastStableScale,
        };
    }

    private setSmartClickAdaptationReason(reason: SmartClickAdaptationReason | null) {
        this.smartClickAdaptationReason = reason;
        this.status = {
            ...this.status,
            smartClickAdaptationReason: reason ?? undefined,
        };
    }

    private normalizeOcrText(value: string): string {
        return value
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private computeOcrSimilarity(a: string, b: string): number {
        if (!a || !b) return 0;
        if (a === b) return 1;
        if (a.includes(b) || b.includes(a)) {
            return Math.min(a.length, b.length) / Math.max(a.length, b.length);
        }
        const aTokens = new Set(a.split(' ').filter(Boolean));
        const bTokens = new Set(b.split(' ').filter(Boolean));
        if (aTokens.size === 0 || bTokens.size === 0) return 0;
        let overlap = 0;
        for (const token of aTokens) {
            if (bTokens.has(token)) overlap += 1;
        }
        return overlap / Math.max(aTokens.size, bTokens.size);
    }

    private ocrTokenMatches(pageWord: string, token: string): boolean {
        if (pageWord === token) return true;
        if (pageWord.length < 6 || token.length < 6) return false;
        if (Math.abs(pageWord.length - token.length) > 1) return false;
        return this.ocrEditDistance(pageWord, token) <= 1;
    }

    private ocrEditDistance(a: string, b: string): number {
        const prev = new Array<number>(b.length + 1);
        const next = new Array<number>(b.length + 1);
        for (let j = 0; j <= b.length; j += 1) prev[j] = j;
        for (let i = 1; i <= a.length; i += 1) {
            next[0] = i;
            let rowMin = next[0];
            for (let j = 1; j <= b.length; j += 1) {
                const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
                next[j] = Math.min(prev[j] + 1, next[j - 1] + 1, prev[j - 1] + cost);
                if (next[j] < rowMin) rowMin = next[j];
            }
            if (rowMin > 1) return 2;
            for (let j = 0; j <= b.length; j += 1) prev[j] = next[j];
        }
        return prev[b.length];
    }

    private recordedOcrQuery(event: RecordedEvent): string {
        const metadata = event.metadata as Record<string, unknown> | undefined;
        if (typeof metadata?.ocr_primary_text_normalized === 'string') {
            return metadata.ocr_primary_text_normalized;
        }
        if (typeof metadata?.ocr_primary_text === 'string') {
            return this.normalizeOcrText(metadata.ocr_primary_text);
        }
        return '';
    }

    private async readOcrItems(
        image: Buffer,
        timeoutMs: number,
        regions = false,
        focus?: { x: number; y: number },
        query?: string
    ): Promise<OcrItem[]> {
        const response = await this.imageService.ocrImage({
            image: image.toString('base64'),
            timeoutMs,
            regions,
            focusX: focus?.x,
            focusY: focus?.y,
            query,
        });
        if (!response.success || !response.items?.length) return [];
        return response.items;
    }

    private async tryOcrSmartClickFallback(
        event: RecordedEvent,
        stageRegion: WindowBounds,
        expected: { x: number; y: number },
        threshold: number,
        timeoutMs: number,
        capturedImage?: Buffer
    ): Promise<SmartClickCandidateSelection | null> {
        const metadata = event.metadata as Record<string, unknown> | undefined;
        const rawText = this.recordedOcrQuery(event);
        if (!rawText || rawText.length < PlaybackEngine.SMART_CLICK_OCR_MIN_TEXT_LEN) {
            return null;
        }
        const offsetNormX = typeof metadata?.ocr_anchor_norm_x === 'number' ? metadata.ocr_anchor_norm_x : 0;
        const offsetNormY = typeof metadata?.ocr_anchor_norm_y === 'number' ? metadata.ocr_anchor_norm_y : 0;
        const image = capturedImage ?? await captureRegion(stageRegion);
        const wideWindow = !capturedImage && Math.max(stageRegion.width, stageRegion.height) > 960;
        const items = wideWindow
            ? await this.readOcrItems(
                  image,
                  Math.max(timeoutMs, 300),
                  true,
                  {
                      x: expected.x - stageRegion.x,
                      y: expected.y - stageRegion.y,
                  },
                  rawText
              )
            : await this.readOcrItems(image, timeoutMs);
        if (!items.length) return null;
        const phraseTokens = rawText
            .split(' ')
            .filter(token => token.length >= PlaybackEngine.SMART_CLICK_OCR_MIN_TEXT_LEN);
        const pageWords: Array<{ text: string; item: OcrItem }> = [];
        for (const item of items) {
            const candidateText = this.normalizeOcrText(item.text);
            if (!candidateText || candidateText.includes(' ') || candidateText === rawText) continue;
            if (candidateText.length < PlaybackEngine.SMART_CLICK_OCR_MIN_TEXT_LEN) continue;
            pageWords.push({ text: candidateText, item });
        }
        const tokenCounts = new Map<string, number>();
        for (const token of phraseTokens) {
            let count = 0;
            for (const choice of pageWords) {
                if (this.ocrTokenMatches(choice.text, token)) count += 1;
            }
            tokenCounts.set(token, count);
        }
        const wordChoices = pageWords.filter(choice =>
            phraseTokens.some(token => this.ocrTokenMatches(choice.text, token))
        );
        const singleToken = phraseTokens.length === 1 && phraseTokens[0] === rawText;
        let bestWord: SmartClickCandidateSelection | null = null;
        let bestWordRank: [number, number, number] | null = null;
        for (const choice of wordChoices) {
            const confidence = Math.min(1, (Number(choice.item.confidence) || 0) / 100);
            if (confidence < Math.max(0.55, threshold - 0.05)) continue;
            const anchorX = singleToken ? offsetNormX * choice.item.bounds.width : 0;
            const anchorY = singleToken ? offsetNormY * choice.item.bounds.height : 0;
            const coords = {
                x: Math.round(stageRegion.x + choice.item.bounds.x + choice.item.bounds.width / 2 + anchorX),
                y: Math.round(stageRegion.y + choice.item.bounds.y + choice.item.bounds.height / 2 + anchorY),
            };
            let rarity = Number.POSITIVE_INFINITY;
            for (const token of phraseTokens) {
                if (!this.ocrTokenMatches(choice.text, token)) continue;
                const count = tokenCounts.get(token) ?? 1;
                if (count < rarity) rarity = count;
            }
            const rank: [number, number, number] = [
                Number.isFinite(rarity) ? rarity : 1,
                -choice.text.length,
                Math.hypot(coords.x - expected.x, coords.y - expected.y),
            ];
            if (
                bestWordRank &&
                (rank[0] > bestWordRank[0] ||
                    (rank[0] === bestWordRank[0] && rank[1] > bestWordRank[1]) ||
                    (rank[0] === bestWordRank[0] && rank[1] === bestWordRank[1] && rank[2] >= bestWordRank[2]))
            ) {
                continue;
            }
            bestWordRank = rank;
            bestWord = {
                coords,
                confidence,
                method: 'ocr',
            };
        }
        if (bestWord) {
            this.traceSmartClick('stage_ocr_window', {
                text: rawText,
                confidence: Number(bestWord.confidence.toFixed(3)),
                x: bestWord.coords.x,
                y: bestWord.coords.y,
            });
            return bestWord;
        }
        let best: SmartClickCandidateSelection | null = null;
        let bestScore = 0;
        for (const item of items) {
            const candidateText = this.normalizeOcrText(item.text);
            if (!candidateText) continue;
            const similarity = this.computeOcrSimilarity(rawText, candidateText);
            if (similarity < 0.75) continue;
            const confidence = Math.max(
                similarity,
                Math.min(1, (Number(item.confidence) || 0) / 100)
            );
            if (confidence < Math.max(0.55, threshold - 0.05)) continue;
            const coords = {
                x: Math.round(stageRegion.x + item.bounds.x + item.bounds.width / 2 + offsetNormX * item.bounds.width),
                y: Math.round(stageRegion.y + item.bounds.y + item.bounds.height / 2 + offsetNormY * item.bounds.height),
            };
            const distancePenalty = Math.min(0.2, Math.hypot(coords.x - expected.x, coords.y - expected.y) / 2000);
            const score = confidence - distancePenalty;
            if (score <= bestScore) continue;
            bestScore = score;
            best = {
                coords,
                confidence,
                method: 'ocr',
            };
        }
        if (best) {
            this.traceSmartClick('stage_ocr_window', {
                text: rawText,
                confidence: Number(best.confidence.toFixed(3)),
                x: best.coords.x,
                y: best.coords.y,
            });
            return best;
        }
        return null;
    }

    private getScaleShiftEvidence(
        candidates: MatchResult[],
        baseThreshold: number
    ): { detected: boolean; suggestedScale?: number } {
        const reference = this.getSmartClickScaleReference();
        const confidenceFloor = Math.max(
            PlaybackEngine.SMART_CLICK_SCALE_EVIDENCE_MIN_CONFIDENCE,
            baseThreshold - 0.08
        );
        const topScaled: MatchResult[] = [];
        for (const candidate of candidates) {
            if (!Number.isFinite(candidate.scale) || candidate.confidence < confidenceFloor) continue;
            if (!this.isReportableSmartClickScale(Number(candidate.scale))) continue;
            let insertAt = topScaled.length;
            while (insertAt > 0 && topScaled[insertAt - 1].confidence < candidate.confidence) {
                insertAt -= 1;
            }
            topScaled.splice(insertAt, 0, candidate);
            if (topScaled.length > 3) {
                topScaled.pop();
            }
        }
        if (topScaled.length === 0) return { detected: false };

        const lead = topScaled[0];
        const leadScale = Number(lead.scale);
        if (!this.hasMeaningfulScaleShift(leadScale, reference)) {
            return { detected: false };
        }

        const support = topScaled.filter(candidate => Math.abs(Number(candidate.scale) - leadScale) <= 0.08);
        if (lead.confidence >= Math.max(baseThreshold, 0.68) || support.length >= 2) {
            return { detected: true, suggestedScale: leadScale };
        }

        return { detected: false };
    }

    private maybeAdaptToScaleEvidence(
        stage: SmartClickStage,
        candidates: MatchResult[],
        baseThreshold: number,
        allowRestart: boolean
    ): number | null {
        if (!allowRestart || this.smartClickAdaptationClicksLeft > 0) return null;
        const evidence = this.getScaleShiftEvidence(candidates, baseThreshold);
        if (!evidence.detected) return null;
        this.traceSmartClick('scale_shift_detected', {
            stage,
            suggestedScale: evidence.suggestedScale,
            scaleHint: this.smartClickScaleHint ?? 1.0,
            recordedScale: this.smartClickRecordedScale ?? 1.0,
        });
        if (this.smartClickAnchor) {
            this.clearSmartClickAnchor();
        }
        this.enterSmartClickAdaptationMode(evidence.suggestedScale, 'scale_shift_evidence');
        return evidence.suggestedScale ?? null;
    }

    private updateSmartClickScaleHint(scale?: number) {
        if (!Number.isFinite(scale)) return;
        const minScale =
            this.smartClickAdaptationClicksLeft > 0
                ? PlaybackEngine.SMART_CLICK_ADAPTIVE_MIN_SCALE
                : PlaybackEngine.SMART_CLICK_MIN_SCALE;
        const maxScale =
            this.smartClickAdaptationClicksLeft > 0
                ? PlaybackEngine.SMART_CLICK_ADAPTIVE_MAX_SCALE
                : PlaybackEngine.SMART_CLICK_MAX_SCALE;
        const clampedScale = Math.max(minScale, Math.min(maxScale, Number(scale)));
        const current = this.smartClickScaleHint ?? this.smartClickLastStableScale ?? this.smartClickRecordedScale ?? 1.0;
        const alpha = PlaybackEngine.SMART_CLICK_SCALE_SMOOTHING_ALPHA;
        this.smartClickScaleHint = Math.max(
            minScale,
            Math.min(maxScale, current * (1 - alpha) + clampedScale * alpha)
        );
        this.status = {
            ...this.status,
            smartClickRecordedScale: this.smartClickRecordedScale ?? undefined,
            smartClickLastStableScale: this.smartClickLastStableScale ?? undefined,
            smartClickScaleHint: this.smartClickScaleHint,
        };
    }

    private hasSignificantTargetBoundsChange(nextBounds: WindowBounds): boolean {
        const prev = this.smartClickLastTargetBounds;
        if (!prev) return false;
        const widthDelta = Math.abs(nextBounds.width - prev.width);
        const prevArea = Math.max(1, prev.width * prev.height);
        const nextArea = Math.max(1, nextBounds.width * nextBounds.height);
        const areaRatio = nextArea / prevArea;
        return (
            widthDelta > PlaybackEngine.SMART_CLICK_ENV_WIDTH_DELTA_PX ||
            areaRatio < PlaybackEngine.SMART_CLICK_ENV_AREA_RATIO_MIN ||
            areaRatio > PlaybackEngine.SMART_CLICK_ENV_AREA_RATIO_MAX
        );
    }

    private enterSmartClickAdaptationMode(
        nextScaleHint?: number,
        reason: SmartClickAdaptationReason = 'failure_streak'
    ) {
        this.clearSmartClickAnchor();
        this.smartClickLastStableScale = this.smartClickRecordedScale ?? 1.0;
        const minScale = PlaybackEngine.SMART_CLICK_ADAPTIVE_MIN_SCALE;
        const maxScale = PlaybackEngine.SMART_CLICK_ADAPTIVE_MAX_SCALE;
        const seedScale =
            Number.isFinite(nextScaleHint)
                ? Math.max(minScale, Math.min(maxScale, Number(nextScaleHint)))
                : (this.smartClickRecordedScale ?? 1.0);
        this.smartClickScaleHint = seedScale;
        this.smartClickAdaptationClicksLeft = PlaybackEngine.SMART_CLICK_ADAPTATION_CLICKS;
        this.smartClickAdaptationReason = reason;
        this.status = {
            ...this.status,
            smartClickRecordedScale: this.smartClickRecordedScale ?? undefined,
            smartClickLastStableScale: this.smartClickLastStableScale ?? undefined,
            smartClickScaleHint: this.smartClickScaleHint,
            smartClickAdaptationClicksLeft: this.smartClickAdaptationClicksLeft,
            smartClickAdaptationReason: this.smartClickAdaptationReason,
        };
    }

    private getWeakDHashMaxDistance(scale?: number): number {
        if (
            Number.isFinite(scale) &&
            Math.abs(Number(scale) - this.getSmartClickScaleBaseline()) >=
                PlaybackEngine.SMART_CLICK_HASH_SKIP_SCALE_DELTA
        ) {
            return PlaybackEngine.SMART_CLICK_DHASH_SCALED_WEAK_MAX_DISTANCE;
        }
        return PlaybackEngine.SMART_CLICK_DHASH_WEAK_MAX_DISTANCE;
    }

    private getAdaptiveDHashMaxDistance(scale?: number): number {
        if (!Number.isFinite(scale)) {
            return PlaybackEngine.SMART_CLICK_DHASH_MAX_DISTANCE;
        }
        const scaleDelta = Math.abs(Number(scale) - this.getSmartClickScaleBaseline());
        return PlaybackEngine.SMART_CLICK_DHASH_MAX_DISTANCE + Math.round(scaleDelta * 40);
    }

    private registerSmartClickFailure() {
        this.smartClickConsecutiveFailures += 1;
        this.degradeSmartClickAnchor();
        if (this.smartClickConsecutiveFailures >= PlaybackEngine.SMART_CLICK_FAILURES_TO_ADAPT) {
            this.enterSmartClickAdaptationMode(undefined, 'failure_streak');
        }
    }

    private shouldConfirmScaledPick(
        adaptationMode: boolean,
        picked: SmartClickCandidateSelection | null | undefined,
        stage: SmartClickStage
    ): boolean {
        if (!adaptationMode || !picked) return false;
        if (stage === 'region') return false;
        if (!this.hasMeaningfulScaleShift(picked.scale)) return false;
        return picked.confidence < 0.82;
    }

    private async confirmScaledPick(
        stage: SmartClickStage,
        event: RecordedEvent,
        expected: { x: number; y: number },
        picked: SmartClickCandidateSelection,
        stageRegion: WindowBounds,
        preferredBounds: WindowBounds | null,
        adaptationMode: boolean,
        baseThreshold: number,
        requestTimeoutMs: number,
        budgetMs: number
    ): Promise<boolean> {
        const referenceScale = Number.isFinite(picked.scale) ? Number(picked.scale) : this.getSmartClickScaleReference();
        const minScale = Math.max(
            PlaybackEngine.SMART_CLICK_ADAPTIVE_MIN_SCALE,
            referenceScale - PlaybackEngine.SMART_CLICK_CONFIRM_SCALE_DELTA
        );
        const maxScale = Math.min(
            PlaybackEngine.SMART_CLICK_ADAPTIVE_MAX_SCALE,
            referenceScale + PlaybackEngine.SMART_CLICK_CONFIRM_SCALE_DELTA
        );
        const stageImage =
            stage === 'fullscreen'
                ? await captureScreen()
                : await captureRegion(stageRegion);
        const response = await this.imageService.matchImage({
            template: event.img_patch_b64!,
            templateHash: event.img_hash,
            searchArea: stageImage.toString('base64'),
            threshold: Math.max(baseThreshold - 0.05, PlaybackEngine.SMART_CLICK_CONFIRM_MIN_CONFIDENCE),
            method: 'hybrid',
            findAll: true,
            maxMatches: 4,
            timeoutMs: Math.min(180, Math.max(0, requestTimeoutMs)),
            minScale,
            maxScale,
            scaleHint: referenceScale,
            maxBudgetMs: Math.min(90, Math.max(0, budgetMs)),
        });
        const candidates = this.getMatchCandidates(response);
        const confirmed = await this.pickBestSmartClickCandidate(
            stage,
            'relaxed',
            event,
            expected,
            candidates,
            Math.max(baseThreshold - 0.05, PlaybackEngine.SMART_CLICK_CONFIRM_MIN_CONFIDENCE),
            { x: stageRegion.x, y: stageRegion.y },
            4,
            preferredBounds,
            { image: stageImage, offsetX: stageRegion.x, offsetY: stageRegion.y },
            { adaptationMode, maxFeatureJumpPx: Math.max(900, stageRegion.width) }
        );
        if (!confirmed) {
            this.traceSmartClick('scale_confirm_reject', {
                stage,
                reason: 'no_confirmed_candidate',
                pickedScale: picked.scale,
            });
            return false;
        }
        const coordDelta = Math.hypot(
            confirmed.coords.x - picked.coords.x,
            confirmed.coords.y - picked.coords.y
        );
        const confirmScale = Number.isFinite(confirmed.scale) ? Number(confirmed.scale) : referenceScale;
        const scaleDelta = Math.abs(confirmScale - referenceScale);
        const accepted =
            coordDelta <= PlaybackEngine.SMART_CLICK_CONFIRM_COORD_DELTA_PX &&
            scaleDelta <= PlaybackEngine.SMART_CLICK_CONFIRM_SCALE_DELTA;
        this.traceSmartClick('scale_confirm', {
            stage,
            accepted,
            coordDelta: Number(coordDelta.toFixed(2)),
            scaleDelta: Number(scaleDelta.toFixed(3)),
            pickedScale: picked.scale,
            confirmScale: confirmed.scale,
        });
        return accepted;
    }

    private markSmartClickSource(
        source: SmartClickSource,
        method?: string,
        confidence?: number,
        dhashDistance?: number,
        scale?: number
    ) {
        this.status = {
            ...this.status,
            smartClickLastSource: source,
            smartClickLastMethod: method,
            smartClickLastConfidence: confidence,
            smartClickLastDHashDistance: dhashDistance,
            smartClickLastScale: typeof scale === 'number' && Number.isFinite(scale) ? Number(scale) : undefined,
            smartClickRecordedScale: this.smartClickRecordedScale ?? undefined,
            smartClickLastStableScale: this.smartClickLastStableScale ?? undefined,
            smartClickScaleHint: this.smartClickScaleHint ?? undefined,
            smartClickAdaptationReason: this.smartClickAdaptationReason ?? undefined,
            smartClickAnchorTrust: this.smartClickAnchorTrust,
        };
    }

    private markServiceUnavailableFallback() {
        this.status = {
            ...this.status,
            failedMatches: this.status.failedMatches + 1,
            lastError: 'image_service_unavailable',
            smartClickLastSource: 'service_unavailable_fallback',
        };
    }

    private traceSmartClick(event: string, details?: Record<string, unknown>) {
        if (!this.smartClickTraceEnabled) return;
        if (!details) {
            console.log(`[SmartClickTrace] ${event}`);
            return;
        }
        try {
            console.log(`[SmartClickTrace] ${event} ${JSON.stringify(details)}`);
        } catch {
            console.log(`[SmartClickTrace] ${event}`);
        }
    }

    private isServiceUnavailableErrorText(text: string): boolean {
        const lower = text.toLowerCase();
        return (
            lower.includes('econnrefused') ||
            lower.includes('fetch failed') ||
            lower.includes('econnreset')
        );
    }

    private isTimeoutErrorText(text: string): boolean {
        const lower = text.toLowerCase();
        return lower.includes('timeout') || lower.includes('timed out') || lower.includes('abort');
    }

    private hammingDistanceHex(a: string, b: string): number {
        const len = Math.min(a.length, b.length);
        let distance = 0;
        for (let i = 0; i < len; i += 1) {
            const ai = Number.parseInt(a[i], 16);
            const bi = Number.parseInt(b[i], 16);
            if (!Number.isFinite(ai) || !Number.isFinite(bi)) continue;
            let v = ai ^ bi;
            while (v > 0) {
                distance += v & 1;
                v >>= 1;
            }
        }
        return distance + Math.abs(a.length - b.length) * 4;
    }

    private getSharp() {
        if (!this.sharpLib) {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            this.sharpLib = require('sharp');
        }
        return this.sharpLib;
    }

    private async extractPatchFromBuffer(image: Buffer, centerX: number, centerY: number, size: number): Promise<Buffer> {
        const sharp = this.getSharp();
        const metadata = await sharp(image).metadata();
        const width = metadata.width ?? size;
        const height = metadata.height ?? size;
        if (width <= 0 || height <= 0) {
            throw new Error('invalid_image_dimensions');
        }

        const safeSize = Math.max(8, Math.min(size, width, height));
        const half = Math.floor(safeSize / 2);
        const left = Math.max(0, Math.min(Math.round(centerX) - half, width - safeSize));
        const top = Math.max(0, Math.min(Math.round(centerY) - half, height - safeSize));
        return sharp(image)
            .extract({ left, top, width: safeSize, height: safeSize })
            .png()
            .toBuffer();
    }

    private async extractRectFromBuffer(
        image: Buffer,
        left: number,
        top: number,
        width: number,
        height: number
    ): Promise<Buffer> {
        const sharp = this.getSharp();
        const metadata = await sharp(image).metadata();
        const imageWidth = metadata.width ?? 0;
        const imageHeight = metadata.height ?? 0;
        if (imageWidth <= 0 || imageHeight <= 0) {
            throw new Error('invalid_image_dimensions');
        }
        const safeWidth = Math.max(1, Math.min(Math.round(width), imageWidth));
        const safeHeight = Math.max(1, Math.min(Math.round(height), imageHeight));
        const safeLeft = Math.max(0, Math.min(Math.round(left), imageWidth - safeWidth));
        const safeTop = Math.max(0, Math.min(Math.round(top), imageHeight - safeHeight));
        return sharp(image)
            .extract({ left: safeLeft, top: safeTop, width: safeWidth, height: safeHeight })
            .png()
            .toBuffer();
    }

    private async recordedTemplateSize(
        event: RecordedEvent
    ): Promise<{ width: number; height: number } | null> {
        const encoded = event.img_patch_b64;
        if (!encoded) return null;
        try {
            const metadata = await this.getSharp()(Buffer.from(encoded, 'base64')).metadata();
            const width = metadata.width ?? 0;
            const height = metadata.height ?? 0;
            if (width < 8 || height < 8) return null;
            return { width, height };
        } catch {
            return null;
        }
    }

    private async recordedPatchSize(event: RecordedEvent): Promise<number> {
        const encoded = event.img_patch_b64;
        if (!encoded) return 128;
        try {
            const metadata = await this.getSharp()(Buffer.from(encoded, 'base64')).metadata();
            const width = metadata.width ?? 0;
            const height = metadata.height ?? 0;
            const edge = Math.min(width, height);
            if (!Number.isFinite(edge) || edge < 8) return 128;
            return Math.round(edge);
        } catch {
            return 128;
        }
    }

    private async getDHashDistance(
        event: RecordedEvent,
        x: number,
        y: number,
        hashSource?: { image: Buffer; offsetX: number; offsetY: number },
        patchSize = 128,
        matchedBounds?: { x: number; y: number; width: number; height: number }
    ): Promise<number | null> {
        const recordedHash = (event.metadata as Record<string, unknown> | undefined)?.img_dhash;
        if (typeof recordedHash !== 'string' || !recordedHash) {
            return null;
        }
        const size = Math.max(8, Math.round(patchSize));
        try {
            let patch: Buffer;
            const recorded = matchedBounds ? await this.recordedTemplateSize(event) : null;
            if (
                hashSource &&
                matchedBounds &&
                matchedBounds.width >= 8 &&
                matchedBounds.height >= 8
            ) {
                patch = await this.extractRectFromBuffer(
                    hashSource.image,
                    matchedBounds.x,
                    matchedBounds.y,
                    matchedBounds.width,
                    matchedBounds.height
                );
                if (
                    recorded &&
                    (Math.round(matchedBounds.width) !== recorded.width ||
                        Math.round(matchedBounds.height) !== recorded.height)
                ) {
                    patch = await this.getSharp()(patch)
                        .resize(recorded.width, recorded.height, { fit: 'fill' })
                        .png()
                        .toBuffer();
                }
            } else {
                patch = hashSource
                    ? await this.extractPatchFromBuffer(
                          hashSource.image,
                          Math.round(x - hashSource.offsetX),
                          Math.round(y - hashSource.offsetY),
                          size
                      )
                    : await capturePatch(Math.round(x), Math.round(y), size);
            }
            const currentHash = await computeDHash(patch);
            return this.hammingDistanceHex(recordedHash, currentHash);
        } catch {
            return null;
        }
    }

    private getMatchCandidates(match: { matches?: MatchResult[]; bestMatch?: MatchResult }): MatchResult[] {
        const sourceCandidates =
            match.matches?.length
                ? match.matches
                : match.bestMatch
                  ? [match.bestMatch]
                  : [];
        const candidates: MatchResult[] = [];
        for (const candidate of sourceCandidates) {
            let insertAt = candidates.length;
            while (insertAt > 0 && candidates[insertAt - 1].confidence < candidate.confidence) {
                insertAt -= 1;
            }
            candidates.splice(insertAt, 0, candidate);
        }
        return candidates;
    }

    private compareSmartClickCandidateBase(
        a: SmartClickViableCandidate,
        b: SmartClickViableCandidate,
        preferredBounds: WindowBounds | null
    ): number {
        if (preferredBounds && a.inPreferredBounds !== b.inPreferredBounds) {
            return a.inPreferredBounds ? -1 : 1;
        }
        if (Math.abs(a.confidence - b.confidence) > 0.05) {
            return b.confidence - a.confidence;
        }
        const allowAnchorBias = this.shouldApplyAnchorBias();
        const allowCandidateAnchorBias =
            allowAnchorBias &&
            !this.hasMeaningfulScaleShift(a.scale) &&
            !this.hasMeaningfulScaleShift(b.scale);
        if (allowCandidateAnchorBias && a.anchorRank !== b.anchorRank) {
            return a.anchorRank - b.anchorRank;
        }
        const allowScaleTiebreak =
            !this.hasMeaningfulScaleShift(a.scale) &&
            !this.hasMeaningfulScaleShift(b.scale);
        if (allowScaleTiebreak && Math.abs(a.confidence - b.confidence) <= 0.03 && a.scaleRank !== b.scaleRank) {
            return a.scaleRank - b.scaleRank;
        }
        if (
            allowScaleTiebreak &&
            a.anchorRank === b.anchorRank &&
            Math.abs(a.confidence - b.confidence) <= 0.05 &&
            a.expectedDistance !== b.expectedDistance
        ) {
            return a.expectedDistance - b.expectedDistance;
        }
        return b.confidence - a.confidence;
    }

    private compareSmartClickCandidateFinal(
        a: SmartClickViableCandidate,
        b: SmartClickViableCandidate,
        preferredBounds: WindowBounds | null
    ): number {
        if (preferredBounds && a.inPreferredBounds !== b.inPreferredBounds) {
            return a.inPreferredBounds ? -1 : 1;
        }
        if (a.passesHashGate !== undefined || b.passesHashGate !== undefined) {
            const aPass = a.passesHashGate ?? true;
            const bPass = b.passesHashGate ?? true;
            if (aPass !== bPass) return aPass ? -1 : 1;
        }
        if (Math.abs(a.confidence - b.confidence) > 0.05) {
            return b.confidence - a.confidence;
        }
        if (a.dhashDistance !== undefined && b.dhashDistance !== undefined) {
            const aDist = a.dhashDistance ?? Number.MAX_SAFE_INTEGER;
            const bDist = b.dhashDistance ?? Number.MAX_SAFE_INTEGER;
            if (aDist !== bDist) return aDist - bDist;
        }
        return this.compareSmartClickCandidateBase(a, b, preferredBounds);
    }

    private rankSmartClickCandidates(
        candidates: SmartClickViableCandidate[],
        comparator: (a: SmartClickViableCandidate, b: SmartClickViableCandidate) => number
    ): SmartClickViableCandidate[] {
        const ranked: SmartClickViableCandidate[] = [];
        for (const candidate of candidates) {
            let insertAt = ranked.length;
            while (insertAt > 0 && comparator(candidate, ranked[insertAt - 1]) < 0) {
                insertAt -= 1;
            }
            ranked.splice(insertAt, 0, candidate);
        }
        return ranked;
    }

    private async pickBestSmartClickCandidate(
        stage: SmartClickStage,
        anchorMode: AnchorRankingMode,
        event: RecordedEvent,
        expected: { x: number; y: number },
        candidates: MatchResult[],
        baseThreshold: number,
        offset: { x: number; y: number },
        maxCandidates: number,
        preferredBounds: WindowBounds | null,
        hashSource?: { image: Buffer; offsetX: number; offsetY: number },
        options?: { adaptationMode?: boolean; maxFeatureJumpPx?: number }
    ): Promise<SmartClickCandidateSelection | null> {
        const considered = candidates.slice(0, Math.max(1, maxCandidates));
        const adaptationMode = options?.adaptationMode ?? false;
        const collectionFloor = adaptationMode
            ? Math.min(baseThreshold, PlaybackEngine.SMART_CLICK_ADAPTIVE_COLLECTION_MIN_CONFIDENCE)
            : Math.min(baseThreshold, PlaybackEngine.SMART_CLICK_COLLECTION_MIN_CONFIDENCE);
        const maxFeatureJumpPx = options?.maxFeatureJumpPx ?? 320;
        const viable: SmartClickViableCandidate[] = [];

        for (const candidate of considered) {
            if (candidate.confidence < collectionFloor) continue;
            const coords = {
                x: Math.round(offset.x + candidate.x),
                y: Math.round(offset.y + candidate.y),
            };
            const method = (candidate.method ?? 'template').toLowerCase();
            const scale = Number.isFinite(candidate.scale) ? Number(candidate.scale) : undefined;
            if (!this.isSmartClickScaleInWindow(scale, adaptationMode)) {
                continue;
            }
            const currentScaleHint = this.getSmartClickScaleReference();
            const scaleRank = scale === undefined ? 0 : Math.abs(scale - currentScaleHint);
            const jumpFromExpected = Math.hypot(coords.x - expected.x, coords.y - expected.y);
            const anyCandidate = candidate as unknown as { inliers?: number; homography_ok?: boolean };
            const featureInliers = typeof anyCandidate.inliers === 'number' ? anyCandidate.inliers : undefined;
            const featureHomography = anyCandidate.homography_ok === true;
            const featureReliable =
                method !== 'feature' ||
                featureHomography ||
                (featureInliers !== undefined && featureInliers >= (adaptationMode ? 6 : 8));
            if (!featureReliable) {
                continue;
            }
            if (
                method === 'feature' &&
                adaptationMode &&
                jumpFromExpected > maxFeatureJumpPx &&
                candidate.confidence < 0.62 &&
                !featureHomography
            ) {
                continue;
            }
            const anchorError = this.smartClickAnchor
                ? Math.hypot(
                      coords.x - expected.x - this.smartClickAnchor.dx,
                      coords.y - expected.y - this.smartClickAnchor.dy
                  )
                : 0;
            const anchorRank =
                anchorMode === 'strict'
                    ? anchorError
                    : Math.min(anchorError, 320) / 4;
            const inPreferredBounds = preferredBounds
                ? coords.x >= preferredBounds.x &&
                  coords.x <= preferredBounds.x + preferredBounds.width &&
                  coords.y >= preferredBounds.y &&
                  coords.y <= preferredBounds.y + preferredBounds.height
                : false;

            const bounds = candidate.bounds;
            viable.push({
                coords,
                confidence: candidate.confidence,
                method,
                scale,
                scaleRank,
                dhashDistance: undefined,
                anchorRank,
                expectedDistance: jumpFromExpected,
                inPreferredBounds,
                passesHashGate: undefined,
                matchBounds:
                    method !== 'feature' &&
                    bounds &&
                    bounds.width >= 8 &&
                    bounds.height >= 8
                        ? {
                              x: bounds.x,
                              y: bounds.y,
                              width: bounds.width,
                              height: bounds.height,
                          }
                        : undefined,
            });
        }

        if (viable.length === 0) return null;

        const preHashRanked = this.rankSmartClickCandidates(
            viable,
            (a, b) => this.compareSmartClickCandidateBase(a, b, preferredBounds)
        );

        const hashEvalCount = Math.min(PlaybackEngine.SMART_CLICK_MAX_HASH_EVALS, viable.length);
        const recordedHash = (event.metadata as Record<string, unknown> | undefined)?.img_dhash;
        const patchSize =
            typeof recordedHash === 'string' && recordedHash
                ? await this.recordedPatchSize(event)
                : 128;
        for (let i = 0; i < hashEvalCount; i += 1) {
            const candidate = preHashRanked[i];
            if (adaptationMode && candidate.method === 'feature') {
                candidate.passesHashGate = true;
                continue;
            }
            if (
                candidate.scale !== undefined &&
                Math.abs(candidate.scale - this.getSmartClickScaleBaseline()) >= PlaybackEngine.SMART_CLICK_HASH_SKIP_SCALE_DELTA &&
                candidate.confidence >= PlaybackEngine.SMART_CLICK_STRONG_MATCH_CONFIDENCE
            ) {
                candidate.passesHashGate = true;
                continue;
            }
            const distance = await this.getDHashDistance(
                event,
                candidate.coords.x,
                candidate.coords.y,
                hashSource,
                patchSize,
                candidate.matchBounds
            );
            candidate.dhashDistance = distance;
            const maxDistance = this.getAdaptiveDHashMaxDistance(candidate.scale);
            candidate.passesHashGate =
                distance === null || distance <= maxDistance;
        }

        const ranked = this.rankSmartClickCandidates(
            viable,
            (a, b) => this.compareSmartClickCandidateFinal(a, b, preferredBounds)
        );
        for (const best of ranked) {
            if (best.confidence < baseThreshold) continue;
            if (
                best.method !== 'feature' &&
                best.confidence < PlaybackEngine.SMART_CLICK_STRONG_MATCH_CONFIDENCE &&
                typeof best.dhashDistance === 'number' &&
                best.dhashDistance > this.getWeakDHashMaxDistance(best.scale)
            ) {
                continue;
            }
            return {
                coords: best.coords,
                confidence: best.confidence,
                dhashDistance: best.dhashDistance ?? undefined,
                method: best.method,
                scale: best.scale,
            };
        }
        return null;
    }

    private setSmartClickAnchor(expected: { x: number; y: number }, actual: { x: number; y: number }) {
        this.smartClickAnchor = {
            dx: actual.x - expected.x,
            dy: actual.y - expected.y,
        };
        const maxOffset = Math.max(Math.abs(this.smartClickAnchor.dx), Math.abs(this.smartClickAnchor.dy));
        this.smartClickAnchorTrust =
            maxOffset > 260
                ? 2
                : maxOffset > 140
                  ? 3
                  : 4;
        this.status = {
            ...this.status,
            smartClickAnchorDx: this.smartClickAnchor.dx,
            smartClickAnchorDy: this.smartClickAnchor.dy,
            smartClickAnchorTrust: this.smartClickAnchorTrust,
        };
    }

    private async resolveSmartClick(
        event: RecordedEvent,
        expected: { x: number; y: number },
        allowRestart = true,
        telemetry: { open: boolean } = { open: true },
        deadline?: number,
        attempt = 0,
    ): Promise<{ x: number; y: number }> {
        const config = this.config;
        if (!config?.useImageMatching || !event.img_patch_b64) {
            return expected;
        }

        const isBootstrap = this.smartClickAnchor === null;
        const templateForMatch = event.img_patch_b64;
        const templateHash = event.img_hash;
        const threshold = Math.max(0, Math.min(1, config.imageMatchThreshold));
        const strictThresholdBase = threshold;
        const fullscreenThresholdBase = threshold;
        const desktopBounds = CoordinateNormalizer.getVirtualLogicalBounds();
        const desktopRight = desktopBounds.x + desktopBounds.width;
        const desktopBottom = desktopBounds.y + desktopBounds.height;
        const clipNeighborhood = (center: { x: number; y: number }, radius: number): WindowBounds => {
            const rawRegion = {
                x: center.x - radius,
                y: center.y - radius,
                width: radius * 2,
                height: radius * 2,
            };
            return {
                x: Math.max(desktopBounds.x, rawRegion.x),
                y: Math.max(desktopBounds.y, rawRegion.y),
                width: Math.max(
                    1,
                    Math.min(desktopRight, rawRegion.x + rawRegion.width) - Math.max(desktopBounds.x, rawRegion.x)
                ),
                height: Math.max(
                    1,
                    Math.min(desktopBottom, rawRegion.y + rawRegion.height) - Math.max(desktopBounds.y, rawRegion.y)
                ),
            };
        };
        let nearbyCapture: { image: Buffer; region: WindowBounds } | null = null;
        if (attempt === 0) {
            this.smartClickAttemptBounds = await this.getSmartClickTargetBoundsAsync(
                this.clock.now() + PlaybackEngine.SMART_CLICK_BOUNDS_WAIT_MS
            );
        }
        const preferredBounds = this.smartClickAttemptBounds;
        expected = this.relativeFallbackPoint(event, preferredBounds) ?? expected;
        let budgetDeadline = deadline ?? this.clock.now() + PlaybackEngine.SMART_CLICK_MAX_BUDGET_MS;
        let startedAt = budgetDeadline - PlaybackEngine.SMART_CLICK_MAX_BUDGET_MS;
        const captureForMatch = async <T>(work: () => Promise<T>): Promise<T> => {
            const captureStarted = this.clock.now();
            try {
                return await work();
            } finally {
                const captureMs = Math.max(0, this.clock.now() - captureStarted);
                budgetDeadline += captureMs;
                startedAt += captureMs;
            }
        };
        if (preferredBounds) {
            if (this.hasSignificantTargetBoundsChange(preferredBounds)) {
                this.enterSmartClickAdaptationMode(undefined, 'bounds_change');
            }
            this.smartClickLastTargetBounds = preferredBounds;
        }
        const adaptationMode = this.smartClickAdaptationClicksLeft > 0;
        const strictThreshold = adaptationMode
            ? Math.max(0.52, strictThresholdBase - 0.10)
            : strictThresholdBase;
        const fullscreenThreshold = adaptationMode
            ? Math.max(0.48, fullscreenThresholdBase - 0.08)
            : fullscreenThresholdBase;
        const searchRadius = adaptationMode
            ? Math.min(640, Math.max(384, config.imageSearchRadius ?? 320))
            : (config.imageSearchRadius ?? 320);
        const scaleWindow = this.getSmartClickScaleWindow(adaptationMode);
        const requestTimeoutMs = adaptationMode ? 260 : (this.smartClickAnchor ? 220 : 320);
        const timedOut = () => this.clock.now() - startedAt >= PlaybackEngine.SMART_CLICK_MAX_BUDGET_MS;
        const budgetLeftMs = () => Math.max(0, budgetDeadline - this.clock.now());
        const remainingBudgetMs = () =>
            Math.max(20, PlaybackEngine.SMART_CLICK_MAX_BUDGET_MS - (this.clock.now() - startedAt));
        const stageBudgetMs = (stage: SmartClickStage) => {
            const preferred =
                stage === 'target_window'
                    ? remainingBudgetMs()
                    : stage === 'region'
                      ? adaptationMode
                          ? 70
                          : (isBootstrap ? 45 : 45)
                      : Math.min(160, remainingBudgetMs());
            return Math.max(20, Math.min(preferred, remainingBudgetMs()));
        };
        const ocrReserveMs =
            this.recordedOcrQuery(event).length >= PlaybackEngine.SMART_CLICK_OCR_MIN_TEXT_LEN
                ? PlaybackEngine.SMART_CLICK_OCR_RESERVE_MS
                : 0;
        const imageBudgetLeftMs = () => Math.max(0, budgetLeftMs() - ocrReserveMs);
        const imageStageOpen = () => !timedOut() && imageBudgetLeftMs() >= 20;
        const relativeFallback = this.relativeFallbackPoint(event, preferredBounds);
        const anchorBase = relativeFallback ?? expected;
        const anchored = this.applySmartClickAnchor(anchorBase);
        const anchorHolds =
            !adaptationMode && (anchored.x !== anchorBase.x || anchored.y !== anchorBase.y);
        const fallbackCoords = anchorHolds ? anchored : anchorBase;
        const collectionMinConfidence = adaptationMode
            ? PlaybackEngine.SMART_CLICK_ADAPTIVE_COLLECTION_MIN_CONFIDENCE
            : PlaybackEngine.SMART_CLICK_COLLECTION_MIN_CONFIDENCE;
        this.traceSmartClick('begin', {
            adaptationMode,
            expectedX: Math.round(expected.x),
            expectedY: Math.round(expected.y),
            threshold: Number(threshold.toFixed(3)),
            strictThreshold: Number(strictThreshold.toFixed(3)),
            fullscreenThreshold: Number(fullscreenThreshold.toFixed(3)),
            scaleHint: this.smartClickScaleHint ?? 1.0,
            adaptationReason: this.smartClickAdaptationReason ?? undefined,
            searchRadius,
            hasPreferredBounds: !!preferredBounds,
        });

        try {
            if (preferredBounds && imageStageOpen()) {
                const targetRegion = {
                    x: Math.max(desktopBounds.x, preferredBounds.x),
                    y: Math.max(desktopBounds.y, preferredBounds.y),
                    width: Math.max(1, Math.min(desktopRight, preferredBounds.x + preferredBounds.width) - Math.max(desktopBounds.x, preferredBounds.x)),
                    height: Math.max(1, Math.min(desktopBottom, preferredBounds.y + preferredBounds.height) - Math.max(desktopBounds.y, preferredBounds.y)),
                };
                const targetArea = await captureForMatch(() => captureRegion(targetRegion));
                const targetBudget = Math.min(stageBudgetMs('target_window'), imageBudgetLeftMs());
                const targetTimeoutMs = Math.max(20, Math.min(requestTimeoutMs, targetBudget));
                const targetResponse = await this.imageService.matchImage({
                    template: templateForMatch,
                    templateHash,
                    searchArea: targetArea.toString('base64'),
                    threshold: Math.min(fullscreenThreshold, collectionMinConfidence),
                    method: 'hybrid',
                    findAll: true,
                    maxMatches: PlaybackEngine.SMART_CLICK_MAX_WINDOW_CANDIDATES,
                    timeoutMs: targetTimeoutMs,
                    minScale: scaleWindow.minScale,
                    maxScale: scaleWindow.maxScale,
                    scaleHint: this.smartClickScaleHint ?? 1.0,
                    maxBudgetMs: targetBudget,
                });
                const targetError = String(targetResponse.error ?? '');
                if (this.isServiceUnavailableErrorText(targetError)) {
                    this.markServiceUnavailableFallback();
                    return fallbackCoords;
                }
                const targetCandidates = this.getMatchCandidates(targetResponse);
                const pickedWindow = await this.pickBestSmartClickCandidate(
                    'target_window',
                    'relaxed',
                    event,
                    expected,
                    targetCandidates,
                    fullscreenThreshold,
                    { x: targetRegion.x, y: targetRegion.y },
                    PlaybackEngine.SMART_CLICK_MAX_WINDOW_CANDIDATES,
                    preferredBounds,
                    { image: targetArea, offsetX: targetRegion.x, offsetY: targetRegion.y },
                    {
                        adaptationMode,
                        maxFeatureJumpPx: adaptationMode ? Math.max(900, searchRadius * 2) : Math.max(280, searchRadius),
                    }
                );
                this.traceSmartClick('stage_target_window', {
                    candidates: targetCandidates.length,
                    picked: !!pickedWindow,
                    pickedMethod: pickedWindow?.method,
                    pickedConf: pickedWindow ? Number(pickedWindow.confidence.toFixed(3)) : undefined,
                    pickedScale: pickedWindow?.scale,
                    bestConf:
                        targetCandidates.length > 0
                            ? Number(targetCandidates[0].confidence.toFixed(3))
                            : undefined,
                    bestMethod: targetCandidates[0]?.method,
                });
                if (!pickedWindow) {
                    const suggestedScale = this.maybeAdaptToScaleEvidence(
                        'target_window',
                        targetCandidates,
                        fullscreenThreshold,
                        allowRestart
                    );
                    if (suggestedScale !== null) {
                        return this.resolveSmartClick(event, expected, false, telemetry, budgetDeadline, attempt);
                    }
                }
                if (pickedWindow) {
                    if (!telemetry.open) return pickedWindow.coords;
                    const confirmed = this.shouldConfirmScaledPick(adaptationMode, pickedWindow, 'target_window')
                        ? await this.confirmScaledPick(
                              'target_window',
                              event,
                              expected,
                              pickedWindow,
                              targetRegion,
                              preferredBounds,
                              adaptationMode,
                              fullscreenThreshold,
                              targetTimeoutMs,
                              targetBudget
                          )
                        : true;
                    if (!confirmed) {
                        this.registerSmartClickFailure();
                        return fallbackCoords;
                    }
                    if (
                        (!adaptationMode || pickedWindow.confidence >= 0.80) &&
                        !this.hasMeaningfulScaleShift(pickedWindow.scale)
                    ) {
                        this.setSmartClickAnchor(relativeFallback ?? expected, pickedWindow.coords);
                    } else if (this.smartClickAnchor) {
                        this.clearSmartClickAnchor();
                    }
                    this.recordSmartClickStableScale(pickedWindow.scale);
                    this.updateSmartClickScaleHint(pickedWindow.scale);
                    this.smartClickConsecutiveFailures = 0;
                    if (this.smartClickAdaptationClicksLeft > 0) {
                        this.smartClickAdaptationClicksLeft = Math.max(0, this.smartClickAdaptationClicksLeft - 1);
                    }
                    this.status = {
                        ...this.status,
                        successfulMatches: this.status.successfulMatches + 1,
                        lastError: this.status.lastError === 'image_service_unavailable' ? undefined : this.status.lastError,
                        smartClickAdaptationClicksLeft: this.smartClickAdaptationClicksLeft,
                    };
                    this.markSmartClickSource(
                        'window',
                        pickedWindow.method,
                        pickedWindow.confidence,
                        pickedWindow.dhashDistance,
                        pickedWindow.scale
                    );
                    return pickedWindow.coords;
                }
            }

            if (imageStageOpen()) {
                const searchCenter = fallbackCoords;
                const region = clipNeighborhood(searchCenter, searchRadius);
                const searchArea = await captureForMatch(() => captureRegion(region));
                nearbyCapture = { image: searchArea, region };
                const regionBudget = preferredBounds
                    ? Math.min(stageBudgetMs('region'), imageBudgetLeftMs())
                    : Math.max(
                          20,
                          imageBudgetLeftMs() -
                              (event.img_context_b64 ? PlaybackEngine.SMART_CLICK_CONTEXT_RESERVE_MS : 0)
                      );
                const regionResponse = await this.imageService.matchImage({
                    template: templateForMatch,
                    templateHash,
                    searchArea: searchArea.toString('base64'),
                    threshold: Math.min(strictThreshold, collectionMinConfidence),
                    method: 'hybrid',
                    findAll: true,
                    maxMatches: PlaybackEngine.SMART_CLICK_MAX_REGION_CANDIDATES,
                    timeoutMs: Math.max(20, Math.min(requestTimeoutMs, regionBudget)),
                    minScale: scaleWindow.minScale,
                    maxScale: scaleWindow.maxScale,
                    scaleHint: this.smartClickScaleHint ?? 1.0,
                    maxBudgetMs: regionBudget,
                });
                const regionError = String(regionResponse.error ?? '');
                if (this.isServiceUnavailableErrorText(regionError)) {
                    this.markServiceUnavailableFallback();
                    return fallbackCoords;
                }
                const regionCandidates = this.getMatchCandidates(regionResponse);
                const pickedRegion = await this.pickBestSmartClickCandidate(
                    'region',
                    'strict',
                    event,
                    expected,
                    regionCandidates,
                    strictThreshold,
                    { x: region.x, y: region.y },
                    PlaybackEngine.SMART_CLICK_MAX_REGION_CANDIDATES,
                    preferredBounds,
                    { image: searchArea, offsetX: region.x, offsetY: region.y },
                    {
                        adaptationMode,
                        maxFeatureJumpPx: adaptationMode ? Math.max(900, searchRadius * 2) : Math.max(280, searchRadius),
                    }
                );
                this.traceSmartClick('stage_region', {
                    candidates: regionCandidates.length,
                    picked: !!pickedRegion,
                    pickedMethod: pickedRegion?.method,
                    pickedConf: pickedRegion ? Number(pickedRegion.confidence.toFixed(3)) : undefined,
                    pickedScale: pickedRegion?.scale,
                    bestConf:
                        regionCandidates.length > 0
                            ? Number(regionCandidates[0].confidence.toFixed(3))
                            : undefined,
                    bestMethod: regionCandidates[0]?.method,
                });
                if (!pickedRegion) {
                    const suggestedScale = this.maybeAdaptToScaleEvidence(
                        'region',
                        regionCandidates,
                        strictThreshold,
                        allowRestart
                    );
                    if (suggestedScale !== null) {
                        return this.resolveSmartClick(event, expected, false, telemetry, budgetDeadline, attempt);
                    }
                }
                if (pickedRegion) {
                    if (!telemetry.open) return pickedRegion.coords;
                    if (
                        (!adaptationMode || pickedRegion.confidence >= 0.80) &&
                        !this.hasMeaningfulScaleShift(pickedRegion.scale)
                    ) {
                        this.setSmartClickAnchor(relativeFallback ?? expected, pickedRegion.coords);
                    } else if (this.smartClickAnchor) {
                        this.clearSmartClickAnchor();
                    }
                    this.recordSmartClickStableScale(pickedRegion.scale);
                    this.updateSmartClickScaleHint(pickedRegion.scale);
                    this.smartClickConsecutiveFailures = 0;
                    if (this.smartClickAdaptationClicksLeft > 0) {
                        this.smartClickAdaptationClicksLeft = Math.max(0, this.smartClickAdaptationClicksLeft - 1);
                    }
                    this.status = {
                        ...this.status,
                        successfulMatches: this.status.successfulMatches + 1,
                        lastError: this.status.lastError === 'image_service_unavailable' ? undefined : this.status.lastError,
                        smartClickAdaptationClicksLeft: this.smartClickAdaptationClicksLeft,
                    };
                    this.markSmartClickSource(
                        'region',
                        pickedRegion.method,
                        pickedRegion.confidence,
                        pickedRegion.dhashDistance,
                        pickedRegion.scale
                    );
                    return pickedRegion.coords;
                }
            }

            if (imageStageOpen() && event.img_context_b64 && (preferredBounds || nearbyCapture)) {
                const contextRegion = preferredBounds
                    ? {
                          x: Math.max(desktopBounds.x, preferredBounds.x),
                          y: Math.max(desktopBounds.y, preferredBounds.y),
                          width: Math.max(
                              1,
                              Math.min(desktopRight, preferredBounds.x + preferredBounds.width) -
                                  Math.max(desktopBounds.x, preferredBounds.x)
                          ),
                          height: Math.max(
                              1,
                              Math.min(desktopBottom, preferredBounds.y + preferredBounds.height) -
                                  Math.max(desktopBounds.y, preferredBounds.y)
                          ),
                      }
                    : nearbyCapture!.region;
                const contextArea = preferredBounds
                    ? await captureForMatch(() => captureRegion(contextRegion))
                    : nearbyCapture!.image;
                const contextBudget = Math.min(
                    Math.max(0, budgetLeftMs() - ocrReserveMs),
                    adaptationMode ? 140 : 100
                );
                const contextResponse = await this.imageService.matchImage({
                    template: event.img_context_b64,
                    templateHash: typeof event.metadata?.img_context_hash === 'string' ? event.metadata.img_context_hash : undefined,
                    searchArea: contextArea.toString('base64'),
                    threshold: adaptationMode ? Math.max(0.48, threshold - 0.1) : threshold,
                    method: 'feature',
                    findAll: true,
                    maxMatches: PlaybackEngine.SMART_CLICK_MAX_WINDOW_CANDIDATES,
                    timeoutMs: contextBudget,
                    minScale: scaleWindow.minScale,
                    maxScale: scaleWindow.maxScale,
                    scaleHint: this.smartClickScaleHint ?? 1.0,
                    maxBudgetMs: contextBudget,
                });
                const contextError = String(contextResponse.error ?? '');
                if (this.isServiceUnavailableErrorText(contextError)) {
                    this.markServiceUnavailableFallback();
                    return fallbackCoords;
                }
                const contextCandidates = this.getMatchCandidates(contextResponse);
                const pickedContext = await this.pickBestSmartClickCandidate(
                    'target_window',
                    'relaxed',
                    event,
                    expected,
                    contextCandidates,
                    adaptationMode ? Math.max(0.48, threshold - 0.08) : threshold,
                    { x: contextRegion.x, y: contextRegion.y },
                    PlaybackEngine.SMART_CLICK_MAX_WINDOW_CANDIDATES,
                    preferredBounds,
                    { image: contextArea, offsetX: contextRegion.x, offsetY: contextRegion.y },
                    {
                        adaptationMode,
                        maxFeatureJumpPx: adaptationMode
                            ? Math.max(900, searchRadius * 2)
                            : Math.max(560, Math.floor(searchRadius * 1.5)),
                    }
                );
                this.traceSmartClick('stage_context_feature', {
                    candidates: contextCandidates.length,
                    picked: !!pickedContext,
                    pickedMethod: pickedContext?.method,
                    pickedConf: pickedContext ? Number(pickedContext.confidence.toFixed(3)) : undefined,
                    pickedScale: pickedContext?.scale,
                    bestConf:
                        contextCandidates.length > 0
                            ? Number(contextCandidates[0].confidence.toFixed(3))
                            : undefined,
                    bestMethod: contextCandidates[0]?.method,
                });
                if (pickedContext) {
                    if (!telemetry.open) return pickedContext.coords;
                    if (pickedContext.confidence >= 0.82 && !this.hasMeaningfulScaleShift(pickedContext.scale)) {
                        this.setSmartClickAnchor(relativeFallback ?? expected, pickedContext.coords);
                    } else if (this.smartClickAnchor) {
                        this.clearSmartClickAnchor();
                    }
                    this.recordSmartClickStableScale(pickedContext.scale);
                    this.updateSmartClickScaleHint(pickedContext.scale);
                    this.smartClickConsecutiveFailures = 0;
                    if (this.smartClickAdaptationClicksLeft > 0) {
                        this.smartClickAdaptationClicksLeft = Math.max(0, this.smartClickAdaptationClicksLeft - 1);
                    }
                    this.status = {
                        ...this.status,
                        successfulMatches: this.status.successfulMatches + 1,
                        lastError: this.status.lastError === 'image_service_unavailable' ? undefined : this.status.lastError,
                        smartClickAdaptationClicksLeft: this.smartClickAdaptationClicksLeft,
                    };
                    this.markSmartClickSource(
                        preferredBounds ? 'window' : 'region',
                        pickedContext.method,
                        pickedContext.confidence,
                        pickedContext.dhashDistance,
                        pickedContext.scale
                    );
                    return pickedContext.coords;
                }
            }

            const hasRecordedText =
                this.recordedOcrQuery(event).length >= PlaybackEngine.SMART_CLICK_OCR_MIN_TEXT_LEN;
            if (!timedOut() && (preferredBounds || hasRecordedText)) {
                const windowRegion = preferredBounds
                    ? {
                          x: Math.max(desktopBounds.x, preferredBounds.x),
                          y: Math.max(desktopBounds.y, preferredBounds.y),
                          width: Math.max(
                              1,
                              Math.min(desktopRight, preferredBounds.x + preferredBounds.width) -
                                  Math.max(desktopBounds.x, preferredBounds.x)
                          ),
                          height: Math.max(
                              1,
                              Math.min(desktopBottom, preferredBounds.y + preferredBounds.height) -
                                  Math.max(desktopBounds.y, preferredBounds.y)
                          ),
                      }
                    : null;
                const ocrRegion = windowRegion ?? nearbyCapture?.region ?? clipNeighborhood(fallbackCoords, searchRadius);
                const ocrTimeoutMs = Math.max(budgetLeftMs(), ocrReserveMs);
                const pickedOcr = ocrTimeoutMs > 0
                    ? await this.tryOcrSmartClickFallback(
                          event,
                          ocrRegion,
                          expected,
                          adaptationMode ? 0.52 : fullscreenThreshold,
                          ocrTimeoutMs,
                          windowRegion ? undefined : nearbyCapture?.image
                      )
                    : null;
                if (pickedOcr) {
                    if (!telemetry.open) return pickedOcr.coords;
                    if (
                        (!adaptationMode || pickedOcr.confidence >= 0.80) &&
                        !this.hasMeaningfulScaleShift(pickedOcr.scale)
                    ) {
                        this.setSmartClickAnchor(relativeFallback ?? expected, pickedOcr.coords);
                    } else if (this.smartClickAnchor) {
                        this.clearSmartClickAnchor();
                    }
                    this.recordSmartClickStableScale(this.smartClickScaleHint ?? undefined);
                    this.smartClickConsecutiveFailures = 0;
                    if (this.smartClickAdaptationClicksLeft > 0) {
                        this.smartClickAdaptationClicksLeft = Math.max(0, this.smartClickAdaptationClicksLeft - 1);
                    }
                    this.status = {
                        ...this.status,
                        successfulMatches: this.status.successfulMatches + 1,
                        lastError: this.status.lastError === 'image_service_unavailable' ? undefined : this.status.lastError,
                        smartClickAdaptationClicksLeft: this.smartClickAdaptationClicksLeft,
                    };
                    this.markSmartClickSource(
                        preferredBounds ? 'window' : 'region',
                        pickedOcr.method,
                        pickedOcr.confidence,
                        pickedOcr.dhashDistance,
                        pickedOcr.scale
                    );
                    return pickedOcr.coords;
                }
            }

            if (imageStageOpen()) {
                const fullScreen = await captureForMatch(() => captureScreen());
                const fullscreenBudget = Math.min(stageBudgetMs('fullscreen'), imageBudgetLeftMs());
                const fullscreenTimeoutMs = Math.max(20, Math.min(requestTimeoutMs, fullscreenBudget));
                const fullResponse = await this.imageService.matchImage({
                    template: templateForMatch,
                    templateHash,
                    searchArea: fullScreen.toString('base64'),
                    threshold: Math.min(fullscreenThreshold, collectionMinConfidence),
                    method: 'hybrid',
                    findAll: true,
                    maxMatches: PlaybackEngine.SMART_CLICK_MAX_FULLSCREEN_CANDIDATES,
                    timeoutMs: fullscreenTimeoutMs,
                    minScale: scaleWindow.minScale,
                    maxScale: scaleWindow.maxScale,
                    scaleHint: this.smartClickScaleHint ?? 1.0,
                    maxBudgetMs: fullscreenBudget,
                });
                const fullError = String(fullResponse.error ?? '');
                if (this.isServiceUnavailableErrorText(fullError)) {
                    this.markServiceUnavailableFallback();
                    return fallbackCoords;
                }
                const fullCandidates = this.getMatchCandidates(fullResponse);
                const pickedFullscreen = await this.pickBestSmartClickCandidate(
                    'fullscreen',
                    'relaxed',
                    event,
                    expected,
                    fullCandidates,
                    fullscreenThreshold,
                    { x: desktopBounds.x, y: desktopBounds.y },
                    PlaybackEngine.SMART_CLICK_MAX_FULLSCREEN_CANDIDATES,
                    preferredBounds,
                    { image: fullScreen, offsetX: desktopBounds.x, offsetY: desktopBounds.y },
                    {
                        adaptationMode,
                        maxFeatureJumpPx: adaptationMode ? Math.max(900, searchRadius * 2) : Math.max(280, searchRadius),
                    }
                );
                this.traceSmartClick('stage_fullscreen', {
                    candidates: fullCandidates.length,
                    picked: !!pickedFullscreen,
                    pickedMethod: pickedFullscreen?.method,
                    pickedConf: pickedFullscreen ? Number(pickedFullscreen.confidence.toFixed(3)) : undefined,
                    pickedScale: pickedFullscreen?.scale,
                    bestConf:
                        fullCandidates.length > 0
                            ? Number(fullCandidates[0].confidence.toFixed(3))
                            : undefined,
                    bestMethod: fullCandidates[0]?.method,
                });
                if (!pickedFullscreen) {
                    const suggestedScale = this.maybeAdaptToScaleEvidence(
                        'fullscreen',
                        fullCandidates,
                        fullscreenThreshold,
                        allowRestart
                    );
                    if (suggestedScale !== null) {
                        return this.resolveSmartClick(event, expected, false, telemetry, budgetDeadline, attempt);
                    }
                }
                if (pickedFullscreen) {
                    if (!telemetry.open) return pickedFullscreen.coords;
                    const fullscreenRegion = {
                        x: desktopBounds.x,
                        y: desktopBounds.y,
                        width: desktopBounds.width,
                        height: desktopBounds.height,
                    };
                    const confirmed = this.shouldConfirmScaledPick(adaptationMode, pickedFullscreen, 'fullscreen')
                        ? await this.confirmScaledPick(
                              'fullscreen',
                              event,
                              expected,
                              pickedFullscreen,
                              fullscreenRegion,
                              preferredBounds,
                              adaptationMode,
                              fullscreenThreshold,
                              fullscreenTimeoutMs,
                              fullscreenBudget
                          )
                        : true;
                    if (!confirmed) {
                        this.registerSmartClickFailure();
                        return fallbackCoords;
                    }
                    if (
                        (!adaptationMode || pickedFullscreen.confidence >= 0.80) &&
                        !this.hasMeaningfulScaleShift(pickedFullscreen.scale)
                    ) {
                        this.setSmartClickAnchor(relativeFallback ?? expected, pickedFullscreen.coords);
                    } else if (this.smartClickAnchor) {
                        this.clearSmartClickAnchor();
                    }
                    this.recordSmartClickStableScale(pickedFullscreen.scale);
                    this.updateSmartClickScaleHint(pickedFullscreen.scale);
                    this.smartClickConsecutiveFailures = 0;
                    if (this.smartClickAdaptationClicksLeft > 0) {
                        this.smartClickAdaptationClicksLeft = Math.max(0, this.smartClickAdaptationClicksLeft - 1);
                    }
                    this.status = {
                        ...this.status,
                        successfulMatches: this.status.successfulMatches + 1,
                        lastError: this.status.lastError === 'image_service_unavailable' ? undefined : this.status.lastError,
                        smartClickAdaptationClicksLeft: this.smartClickAdaptationClicksLeft,
                    };
                    this.markSmartClickSource(
                        'fullscreen',
                        pickedFullscreen.method,
                        pickedFullscreen.confidence,
                        pickedFullscreen.dhashDistance,
                        pickedFullscreen.scale
                    );
                    return pickedFullscreen.coords;
                }
            }

        } catch (error: any) {
            if (!telemetry.open) {
                return fallbackCoords;
            }
            const text = String(error?.message ?? '');
            if (this.isServiceUnavailableErrorText(text)) {
                this.markServiceUnavailableFallback();
                return fallbackCoords;
            }
            if (this.isTimeoutErrorText(text)) {
                this.status = { ...this.status, retries: this.status.retries + 1 };
                this.degradeSmartClickAnchor();
            }
            this.status = { ...this.status, lastError: 'image_match_failed' };
        }

        if (!telemetry.open) {
            return fallbackCoords;
        }
        const retriesAllowed = Math.max(0, Math.floor(config.retryCount ?? 0));
        if (attempt < retriesAllowed && this.clock.now() < budgetDeadline) {
            this.status = { ...this.status, retries: this.status.retries + 1 };
            return this.resolveSmartClick(event, expected, true, telemetry, budgetDeadline, attempt + 1);
        }
        this.registerSmartClickFailure();
        this.traceSmartClick('fallback', {
            source: this.smartClickAnchor ? 'anchor_fallback' : 'expected_fallback',
            adaptationLeft: this.smartClickAdaptationClicksLeft,
            failures: this.smartClickConsecutiveFailures,
            scaleHint: this.smartClickScaleHint ?? 1.0,
        });
        this.status = {
            ...this.status,
            failedMatches: this.status.failedMatches + 1,
            lastError: this.status.lastError === 'image_service_unavailable' ? undefined : this.status.lastError,
            smartClickAdaptationClicksLeft: this.smartClickAdaptationClicksLeft,
        };
        this.markSmartClickSource(this.smartClickAnchor ? 'anchor_fallback' : 'expected_fallback');
        return fallbackCoords;
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
            reliabilityScore: 100,
            smartClickRecordedScale: this.smartClickRecordedScale ?? 1.0,
            smartClickLastStableScale: this.smartClickLastStableScale ?? 1.0,
            smartClickScaleHint: this.smartClickScaleHint ?? 1.0,
            smartClickAdaptationReason: this.smartClickAdaptationReason ?? undefined,
            smartClickAnchorTrust: this.smartClickAnchorTrust,
            smartClickRegionMinConfidence: Math.max(0, Math.min(1, this.config?.imageMatchThreshold ?? 0.6)),
            smartClickFullscreenMinConfidence: Math.max(0, Math.min(1, this.config?.imageMatchThreshold ?? 0.6)),
            smartClickAdaptationClicksLeft: this.smartClickAdaptationClicksLeft,
        };
    }

    private computeReliabilityScore(status: PlaybackStatus, driftMs: number): number {
        const attempts = status.successfulMatches + status.failedMatches;
        const matchQuality = attempts > 0 ? status.successfulMatches / attempts : 1;
        const retryPenalty = Math.min(1, status.retries * 0.08);
        const tolerance = Math.max(8, this.config?.timingTolerance ?? 20);
        const driftPenalty = Math.min(0.65, Math.abs(driftMs) / (tolerance * 6));
        const weighted =
            matchQuality * 0.65 +
            (1 - retryPenalty) * 0.2 +
            (1 - driftPenalty) * 0.15;
        return Math.max(0, Math.min(100, Math.round(weighted * 100)));
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
        const isSmartClickDispatch =
            action.type === 'mouseDown' && !!this.config?.useImageMatching && !!action.event.img_patch_b64;
        const driftExceeded = Math.abs(drift) > (this.config?.timingTolerance ?? 20);
        const driftError =
            driftExceeded && !isSmartClickDispatch
                ? 'timing_drift_exceeded'
                : status.lastError === 'timing_drift_exceeded'
                  ? undefined
                  : status.lastError;
        return {
            ...status,
            currentEventIndex: eventIndex,
            totalEvents: this.actions.length,
            elapsedMs: elapsed,
            timingDrift: drift,
            reliabilityScore: this.computeReliabilityScore(status, drift),
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
