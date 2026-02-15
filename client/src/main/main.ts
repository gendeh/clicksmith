import { app, BrowserWindow, dialog, ipcMain, globalShortcut, screen, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import {
  DEFAULT_HOTKEYS,
  IPC_CHANNELS,
  PlaybackConfig,
  PlaybackStatus,
  Profile,
  RecordingConfig,
  RecordedEvent,
  SuccessMetric,
  UserPreferences,
} from '../types';
import { RecordingEngine } from './recordingEngine';
import { PlaybackEngine } from './playbackEngine';
import { ProfileStore } from './profileStore';
import { SettingsStore } from './settingsStore';
import { runAutoTune } from './autoTune';
import { WindowManager } from './windowManager';
import { syncProfileDeleteToCloud, syncProfileToCloud } from './cloudSync';
import { ModManager } from './modManager';
import { createDefaultInputHook, HookEvent, HookMouseEvent, InputHook } from './inputHooks';
import { RunLifecycleEventType, RunLifecycleManager } from './runLifecycle';
import { RunTraceLogger } from './runTrace';
import { mergeTakeoverEvents } from './takeoverMerge';
import { isReplayLive, isReplaySignalActive, ModStatusResponse, validateModStatusPayload } from './modProtocol';

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
const isDev = process.env.NODE_ENV === 'development';

const settingsStore = new SettingsStore();
const profileStore = new ProfileStore();
const windowManager = new WindowManager();
const recordingEngine = new RecordingEngine({ windowManager });
const playbackEngine = new PlaybackEngine({ windowManager });
const modManager = new ModManager();
const MOD_ADAPTER_ID = 'geode-geometry-dash';
const runLifecycle = new RunLifecycleManager();
const runTrace = new RunTraceLogger();

let lastProfileId: string | null = null;
let currentRecordingTarget: string | null = null;
let lastPlaybackProfile: Profile | null = null;
let lastPlaybackTarget: string | null = null;
let lastPlaybackLeadInMs = 0;
let lastDraftProfile: Profile | null = null;
let draftQuickReplayPending = false;
let recordingViaMod = false;
let playbackViaMod = false;
let activeModBaseUrl: string | null = null;
let pendingTakeoverProfile: Profile | null = null;
let pendingTakeoverStartMs: number | null = null;
let modTakeoverArmed = false;
let modPlaybackAutoIdleTimer: NodeJS.Timeout | null = null;
let modStatePollTimer: NodeJS.Timeout | null = null;
let modAutoFinalizeRecording = false;
let modTakeoverArmInFlight = false;
let modTakeoverLastArmAttemptMs = 0;
let modExpectTakeoverRecording = false;
let modTakeoverRearmBlockedUntilMs = 0;
let modReplaySignalLastSeenMs = 0;
let modReplayLastUnpauseMs = 0;
let modTakeoverResumeGuardActive = false;
let modTakeoverResumeGuardReplayIndex = -1;
let modStatusPollMisses = 0;
let autoTakeoverHookActive = false;
let autoTakeoverHookTriggered = false;
let autoTakeoverSuppressUntilMs = 0;
let lastModReplayPaused = false;
let lastRecordingEngineState: string = 'idle';
let lastPlaybackEngineState: string = 'idle';
let lastLoggedDispatchRunId: string | null = null;
let lastLoggedDispatchAttempt = -1;
let lastLoggedDispatchIndex = -1;
let activeModPlaybackEvents: ModMacroEvent[] = [];
const autoTakeoverHook: InputHook = createDefaultInputHook();
const AUTO_TAKEOVER_SUPPRESS_WINDOW_MS = 90;

function resolvePreloadPath(): string {
  const candidates = [
    path.join(__dirname, 'main', 'preload.js'),
    path.join(__dirname, 'preload.js'),
    path.join(__dirname, '..', 'main', 'preload.js'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

function broadcastStatus(channel: string, data: any) {
  mainWindow?.webContents.send(channel, data);
  overlayWindow?.webContents.send(channel, data);
}

function clearPendingDraftState() {
  profileStore.discardDraft();
  lastDraftProfile = null;
  draftQuickReplayPending = false;
}

function applyLifecycle(type: RunLifecycleEventType, note?: string) {
  const transition = runLifecycle.apply({ type, atMs: Date.now(), note });
  if (transition.changed) {
    runTrace.logTransition(transition);
  }
  return transition.next;
}

function createMainWindow() {
  const preloadPath = resolvePreloadPath();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath,
    },
    title: 'Clicksmith Profile Manager',
    icon: path.join(__dirname, '../../public/icon.ico'),
    show: false,
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.close();
    }
  });
}

function createOverlayWindow() {
  const preloadPath = resolvePreloadPath();
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width } = primaryDisplay.workAreaSize;
  const overlayWidth = 360;
  const overlayHeight = 72;

  overlayWindow = new BrowserWindow({
    width: overlayWidth,
    height: overlayHeight,
    x: Math.max(12, width - overlayWidth - 20),
    y: 96,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    focusable: true,
    hasShadow: false,
    roundedCorners: false,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath,
    },
    title: 'Clicksmith Overlay',
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

  if (isDev) {
    overlayWindow.loadURL('http://localhost:5173/#/overlay');
  } else {
    overlayWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'overlay' });
  }

  overlayWindow.setIgnoreMouseEvents(false);

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

function buildRecordingConfig(config: Partial<RecordingConfig>): RecordingConfig {
  const preferences = settingsStore.getPreferences();
  return {
    target: config.target ?? 'screen',
    captureImages: config.captureImages ?? preferences.defaultRecordingConfig.captureImages ?? true,
    imagePatchSize: config.imagePatchSize ?? preferences.defaultRecordingConfig.imagePatchSize ?? 128,
    minEventInterval: config.minEventInterval ?? preferences.defaultRecordingConfig.minEventInterval ?? 8,
    recordKeyboard: config.recordKeyboard ?? preferences.defaultRecordingConfig.recordKeyboard ?? true,
    recordMouse: config.recordMouse ?? preferences.defaultRecordingConfig.recordMouse ?? true,
    stopHotkey: config.stopHotkey ?? preferences.hotkeys.toggleRecording,
    takeoverHotkey: config.takeoverHotkey ?? preferences.hotkeys.takeover,
  };
}

function buildPlaybackConfig(config: Partial<PlaybackConfig>): PlaybackConfig {
  const preferences = settingsStore.getPreferences();
  return {
    profileId: config.profileId ?? '',
    target: config.target ?? 'screen',
    useImageMatching: config.useImageMatching ?? preferences.defaultPlaybackConfig.useImageMatching ?? true,
    imageMatchThreshold:
      config.imageMatchThreshold ?? preferences.defaultPlaybackConfig.imageMatchThreshold ?? 0.6,
    timingTolerance: config.timingTolerance ?? preferences.defaultPlaybackConfig.timingTolerance ?? 20,
    retryCount: config.retryCount ?? preferences.defaultPlaybackConfig.retryCount ?? 2,
    retryDelay: config.retryDelay ?? preferences.defaultPlaybackConfig.retryDelay ?? 80,
    takeoverHotkey: config.takeoverHotkey ?? preferences.hotkeys.takeover,
    speedMultiplier: config.speedMultiplier ?? preferences.defaultPlaybackConfig.speedMultiplier ?? 1,
    useRelativeCoords: config.useRelativeCoords ?? preferences.defaultPlaybackConfig.useRelativeCoords ?? true,
    imageSearchRadius: config.imageSearchRadius ?? preferences.defaultPlaybackConfig.imageSearchRadius ?? 160,
    snapToHz: config.snapToHz ?? preferences.defaultPlaybackConfig.snapToHz ?? 240,
    snapMode: config.snapMode ?? preferences.defaultPlaybackConfig.snapMode ?? 'duration-lock',
    snapPhaseMs: config.snapPhaseMs ?? preferences.defaultPlaybackConfig.snapPhaseMs ?? 0,
  };
}

function buildSuccessMetric(): SuccessMetric {
  return { furthest_frame: 0, score: 0 };
}

function computeProfileDuration(events: RecordedEvent[]): number {
  return events.reduce((max, event) => {
    const duration = Math.max(0, event.duration_ms ?? 0);
    return Math.max(max, event.t_ms + duration);
  }, 0);
}

function getEventPressAnchorMs(event: RecordedEvent): number | null {
  const metadata = event.metadata as Record<string, unknown> | undefined;
  const action = typeof metadata?.action === 'string' ? metadata.action : undefined;
  const releaseAt = typeof metadata?.release_t_ms === 'number' ? metadata.release_t_ms : undefined;
  const duration = Math.max(0, event.duration_ms ?? 0);

  if (action === 'up') {
    if (duration > 0) return Math.max(0, event.t_ms - duration);
    return null;
  }

  if (action === 'down') {
    return Math.max(0, event.t_ms);
  }

  if (typeof releaseAt === 'number' && duration > 0) {
    return Math.max(0, releaseAt - duration);
  }

  return Math.max(0, event.t_ms);
}

function buildRuntimePlaybackProfile(profile: Profile): { profile: Profile; leadInMs: number } {
  if (!profile.events.length) {
    return { profile, leadInMs: 0 };
  }

  const firstEventMs = profile.events.reduce((min, event) => {
    const anchor = getEventPressAnchorMs(event);
    if (anchor === null) return min;
    return Math.min(min, anchor);
  }, Number.POSITIVE_INFINITY);

  const leadInMs = Number.isFinite(firstEventMs) ? Math.max(0, firstEventMs) : 0;

  if (leadInMs <= 0) {
    return { profile, leadInMs: 0 };
  }

  return {
    leadInMs,
    profile: {
      ...profile,
      events: profile.events.map(event => {
        const metadata = event.metadata as Record<string, unknown> | undefined;
        const adjustedMetadata =
          metadata && typeof metadata.release_t_ms === 'number'
            ? {
                ...metadata,
                release_t_ms: Math.max(0, metadata.release_t_ms - leadInMs),
              }
            : metadata;

        return {
          ...event,
          t_ms: Math.max(0, event.t_ms - leadInMs),
          metadata: adjustedMetadata,
        };
      }),
    },
  };
}

function clearModPlaybackAutoIdleTimer() {
  if (!modPlaybackAutoIdleTimer) return;
  clearTimeout(modPlaybackAutoIdleTimer);
  modPlaybackAutoIdleTimer = null;
}

function clearModStatePollTimer() {
  if (!modStatePollTimer) return;
  clearInterval(modStatePollTimer);
  modStatePollTimer = null;
}

function clearStaleModRecordingState() {
  recordingViaMod = false;
  modTakeoverArmed = false;
  modExpectTakeoverRecording = false;
  modAutoFinalizeRecording = false;
  modTakeoverArmInFlight = false;
  modTakeoverLastArmAttemptMs = 0;
  modTakeoverRearmBlockedUntilMs = 0;
  modTakeoverResumeGuardActive = false;
  modTakeoverResumeGuardReplayIndex = -1;
  lastModReplayPaused = false;
  activeModBaseUrl = null;
  broadcastStatus(IPC_CHANNELS.RECORDING_STATUS, { state: 'idle' });
}

function settleModPlaybackIdle(totalEvents = 0) {
  clearModPlaybackAutoIdleTimer();
  clearModStatePollTimer();
  playbackViaMod = false;
  recordingViaMod = false;
  modTakeoverArmed = false;
  modExpectTakeoverRecording = false;
  modAutoFinalizeRecording = false;
  modTakeoverArmInFlight = false;
  modTakeoverLastArmAttemptMs = 0;
  modTakeoverRearmBlockedUntilMs = 0;
  modReplaySignalLastSeenMs = 0;
  modReplayLastUnpauseMs = 0;
  modTakeoverResumeGuardActive = false;
  modTakeoverResumeGuardReplayIndex = -1;
  lastModReplayPaused = false;
  activeModBaseUrl = null;
  pendingTakeoverProfile = null;
  pendingTakeoverStartMs = null;
  lastPlaybackLeadInMs = 0;
  activeModPlaybackEvents = [];
  disarmAutoTakeoverHook();
  broadcastStatus(IPC_CHANNELS.PLAYBACK_STATUS, buildModPlaybackStatus('idle', totalEvents));
}

function scheduleModPlaybackAutoIdle(modEvents: ModMacroEvent[]) {
  clearModPlaybackAutoIdleTimer();
  const maxEventMs = modEvents.reduce((max, event) => Math.max(max, event.t_ms), 0);
  const autoIdleDelayMs = Math.max(250, Math.ceil(maxEventMs + 200));
  modPlaybackAutoIdleTimer = setTimeout(() => {
    if (!playbackViaMod) return;
    settleModPlaybackIdle(modEvents.length);
  }, autoIdleDelayMs);
}

function startModStatePolling(baseUrl: string, totalEvents = 0) {
  clearModStatePollTimer();
  modStatePollTimer = setInterval(() => {
    void (async () => {
      const status = await modGetStatus(baseUrl);
      if (!status?.ok) {
        modStatusPollMisses += 1;
        if (modStatusPollMisses >= 5 && (playbackViaMod || recordingViaMod)) {
          const errorText = 'mod_status_contract_invalid';
          broadcastStatus(IPC_CHANNELS.PLAYBACK_STATUS, buildModPlaybackStatus('idle', totalEvents, errorText));
          broadcastStatus(IPC_CHANNELS.RECORDING_STATUS, { state: 'idle', error: errorText });
          settleModPlaybackIdle(totalEvents);
          clearStaleModRecordingState();
        }
        return;
      }
      modStatusPollMisses = 0;

      const replayState = status.replay_state;
      const recordState = status.record_state;
      const replaySignal = isReplaySignalActive(status);
      const recordActiveSignal = recordState === 'live';
      const recordArmedSignal = recordState === 'armed';

      if (recordingViaMod) {
        if (recordActiveSignal) {
          if (runLifecycle.getSnapshot().state === 'record_armed') {
            applyLifecycle('attempt_boundary', 'adapter_record_active');
          }
          broadcastStatus(IPC_CHANNELS.RECORDING_STATUS, { state: 'recording' });
        } else if (recordArmedSignal) {
          if (runLifecycle.getSnapshot().state === 'idle') {
            applyLifecycle('arm_record', 'adapter_record_armed');
          }
          broadcastStatus(IPC_CHANNELS.RECORDING_STATUS, { state: 'armed' });
        }
      }
      modTakeoverArmed = Boolean(status.takeover_armed);
      if (playbackViaMod && (replaySignal || status.paused)) {
        modReplaySignalLastSeenMs = Date.now();
      }
      // Treat adapter paused flag as authoritative even if replay_state
      // transiently reports "live" during menu/pause transitions.
      const replayPaused = Boolean(status.paused && (replaySignal || playbackViaMod)) || replayState === 'paused';
      if (playbackViaMod && (replaySignal || replayPaused)) {
        if (replayPaused) {
          if (!lastModReplayPaused) {
            applyLifecycle('pause', 'adapter_replay_paused');
            modTakeoverRearmBlockedUntilMs = Date.now() + 1200;
            modTakeoverResumeGuardActive = true;
            modTakeoverResumeGuardReplayIndex = (status.replay_index ?? 0) + 1;
            modExpectTakeoverRecording = false;
          }
          broadcastStatus(
            IPC_CHANNELS.PLAYBACK_STATUS,
            buildModPlaybackStatus('paused', totalEvents, undefined, status.replay_index ?? 0, status.game_tick)
          );
        } else {
          if (lastModReplayPaused) {
            applyLifecycle('unpause', 'adapter_replay_unpaused');
            modReplayLastUnpauseMs = Date.now();
            modTakeoverRearmBlockedUntilMs = Math.max(modTakeoverRearmBlockedUntilMs, Date.now() + 900);
            modExpectTakeoverRecording = false;
          }
          if (modTakeoverResumeGuardActive) {
            const replayIndex = status.replay_index ?? 0;
            if (replayIndex >= modTakeoverResumeGuardReplayIndex) {
              modTakeoverResumeGuardActive = false;
              modTakeoverResumeGuardReplayIndex = -1;
            }
          }
          logModDispatchProgress(status);
          broadcastStatus(
            IPC_CHANNELS.PLAYBACK_STATUS,
            buildModPlaybackStatus('playing', totalEvents, undefined, status.replay_index ?? 0, status.game_tick)
          );
        }
      } else if (lastModReplayPaused) {
        applyLifecycle('unpause', 'adapter_replay_left_paused');
        modReplayLastUnpauseMs = Date.now();
        modTakeoverRearmBlockedUntilMs = Math.max(modTakeoverRearmBlockedUntilMs, Date.now() + 900);
        modExpectTakeoverRecording = false;
      }
      lastModReplayPaused = replayPaused;
      if (playbackViaMod && isReplayLive(status) && runLifecycle.getSnapshot().state === 'replay_armed') {
        applyLifecycle('attempt_boundary', 'adapter_replay_active');
      }

      const finalizeFromCompletion = !!status.record_complete;
      const finalizeFromIdle = recordingViaMod && !recordActiveSignal && !recordArmedSignal;

      if (recordActiveSignal && status.paused && !recordingViaMod) {
        await modRequest<ModStatusResponse>(baseUrl, '/record/stop').catch(() => null);
        modExpectTakeoverRecording = false;
        broadcastStatus(IPC_CHANNELS.RECORDING_STATUS, { state: 'idle' });
        return;
      }

      if (finalizeFromCompletion || finalizeFromIdle) {
        if (modAutoFinalizeRecording) return;
        modAutoFinalizeRecording = true;
        try {
          if (!recordingViaMod) {
            recordingViaMod = true;
          }
          await stopModRecordingAndDraft();
        } finally {
          modAutoFinalizeRecording = false;
        }
        return;
      }

      const adapterBusy = Boolean(
        recordActiveSignal ||
          recordArmedSignal ||
          status.record_complete ||
          replaySignal ||
          status.takeover_armed
      );

      if (!playbackViaMod && !recordingViaMod && !modTakeoverArmed && !pendingTakeoverProfile && !adapterBusy) {
        modTakeoverResumeGuardActive = false;
        modTakeoverResumeGuardReplayIndex = -1;
        clearModStatePollTimer();
        return;
      }

      if (playbackViaMod && recordActiveSignal) {
        const explicitTakeoverTransition = modExpectTakeoverRecording || status.takeover_armed || modTakeoverArmed;
        if (!explicitTakeoverTransition) {
          // Ignore transient adapter states while replay is still active or paused.
          if (replaySignal || status.paused) {
            return;
          }
          await modRequest<ModStatusResponse>(baseUrl, '/record/stop').catch(() => null);
          recordingViaMod = false;
          broadcastStatus(IPC_CHANNELS.RECORDING_STATUS, { state: 'idle' });
          if (!status.paused) {
            applyLifecycle('stop_replay', 'adapter_unexpected_record_active');
            settleModPlaybackIdle(totalEvents);
          }
          return;
        }
        clearModPlaybackAutoIdleTimer();
        applyLifecycle('takeover_click', 'adapter_takeover_record_active');
        playbackViaMod = false;
        recordingViaMod = true;
        modTakeoverArmed = true;
        modExpectTakeoverRecording = false;
        disarmAutoTakeoverHook();
        broadcastStatus(IPC_CHANNELS.PLAYBACK_STATUS, buildModPlaybackStatus('idle', totalEvents));
        broadcastStatus(IPC_CHANNELS.RECORDING_STATUS, { state: 'recording' });
        return;
      }

      if (
        playbackViaMod &&
        shouldAutoTakeover() &&
        !modTakeoverResumeGuardActive &&
        !status.takeover_armed &&
        !status.paused &&
        isReplayLive(status) &&
        !!lastPlaybackProfile
      ) {
        const now = Date.now();
        if (!modTakeoverArmInFlight && now - modTakeoverLastArmAttemptMs >= 400 && now >= modTakeoverRearmBlockedUntilMs) {
          modTakeoverArmInFlight = true;
          modTakeoverLastArmAttemptMs = now;
          void armModTakeover(lastPlaybackProfile).finally(() => {
            modTakeoverArmInFlight = false;
          });
        }
      }

      if (
        playbackViaMod &&
        !replaySignal &&
        !recordActiveSignal &&
        !status.paused
      ) {
        // Pause/menu transitions can produce a brief "all false" window.
        // Only settle idle after the adapter has been replay-silent long enough.
        const replaySilentMs = Date.now() - modReplaySignalLastSeenMs;
        if (replaySilentMs < 1200) {
          return;
        }
        applyLifecycle('stop_replay', 'adapter_replay_idle');
        settleModPlaybackIdle(totalEvents);
      }
    })();
  }, 120);
}

type ModMacroEvent = {
  t_ms: number;
  button: string;
  down: boolean;
  player2?: boolean;
};

type ModRecordResponse = {
  ok: boolean;
  events?: ModMacroEvent[];
  duration_ms?: number;
  start_ms?: number;
  tick_hz?: number;
  error?: string;
};

const MOD_STATUS_TIMEOUT_MS = 900;
const MOD_REQUEST_TIMEOUT_MS = 1600;

async function fetchJsonWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveModBaseUrl(): Promise<string | null> {
  const status = await modManager.probeAdapter(MOD_ADAPTER_ID);
  if (!status || status.connection !== 'connected') return null;
  const protocol = status.adapter.protocol;
  if (protocol?.baseUrl) return protocol.baseUrl;
  if (protocol?.statusUrl) {
    return protocol.statusUrl.replace(/\/status\/?$/, '');
  }
  return null;
}

async function modRequest<T>(baseUrl: string, path: string, body?: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetchJsonWithTimeout(
      `${baseUrl}${path}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      },
      MOD_REQUEST_TIMEOUT_MS
    );
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error('mod_request_timeout');
    }
    throw error;
  }
  const data = (await response.json()) as T;
  if (!response.ok) {
    throw new Error((data as any)?.error ?? `Mod request failed (${response.status})`);
  }
  return data;
}

async function modGetStatus(baseUrl: string): Promise<ModStatusResponse | null> {
  try {
    const response = await fetchJsonWithTimeout(`${baseUrl}/status`, { method: 'GET' }, MOD_STATUS_TIMEOUT_MS);
    if (!response.ok) return null;
    const payload = await response.json();
    const validation = validateModStatusPayload(payload);
    if (!validation.ok) {
      return null;
    }
    return validation.status;
  } catch {
    return null;
  }
}

function isModRecordingLifecycleActive(status: ModStatusResponse): boolean {
  return Boolean(status.record_active || status.record_armed || status.record_complete || status.takeover_armed);
}

function logModDispatchProgress(status: ModStatusResponse) {
  const adapterIndex =
    typeof status.replay_index === 'number' && Number.isFinite(status.replay_index)
      ? Math.max(0, Math.floor(status.replay_index))
      : -1;
  if (adapterIndex < 0) return;

  const snapshot = runLifecycle.getSnapshot();
  const runChanged = lastLoggedDispatchRunId !== snapshot.runId || lastLoggedDispatchAttempt !== snapshot.attemptId;
  if (runChanged) {
    lastLoggedDispatchRunId = snapshot.runId;
    lastLoggedDispatchAttempt = snapshot.attemptId;
    lastLoggedDispatchIndex = -1;
  }
  if (adapterIndex <= lastLoggedDispatchIndex) return;

  const eventIndex = Math.max(0, adapterIndex - 1);
  const tickMs = 1000 / 240;
  const scheduledMs = activeModPlaybackEvents[eventIndex]?.t_ms ?? eventIndex * tickMs;
  const actualMs =
    typeof status.game_tick === 'number' && Number.isFinite(status.game_tick)
      ? Math.max(0, status.game_tick * tickMs)
      : scheduledMs;

  runTrace.logDispatch({
    runId: snapshot.runId,
    attemptId: snapshot.attemptId,
    eventIndex,
    scheduledMs,
    actualMs,
    deltaMs: actualMs - scheduledMs,
    action: 'mod_playback_event',
  });
  lastLoggedDispatchIndex = adapterIndex;
}

async function resolveModRecordingState(): Promise<{ baseUrl: string; status: ModStatusResponse } | null> {
  const baseUrl = activeModBaseUrl ?? (await resolveModBaseUrl());
  if (!baseUrl) return null;
  const status = await modGetStatus(baseUrl);
  if (!status?.ok) return null;
  return { baseUrl, status };
}

async function isModAdapterReachable(): Promise<boolean> {
  return (await resolveModBaseUrl()) !== null;
}

function modButtonToKey(button: string): string {
  switch (button) {
    case 'left':
      return 'left';
    case 'right':
      return 'right';
    default:
      return 'space';
  }
}

function convertModEventsToRecordedEvents(events: ModMacroEvent[]): RecordedEvent[] {
  const sorted = [...events].sort((a, b) => {
    if (a.t_ms !== b.t_ms) return a.t_ms - b.t_ms;
    if (a.down === b.down) return 0;
    return a.down ? -1 : 1;
  });

  const pending = new Map<string, ModMacroEvent>();
  const result: RecordedEvent[] = [];

  for (const event of sorted) {
    const key = `${event.button}:${event.player2 ? '2' : '1'}`;
    if (event.down) {
      pending.set(key, event);
      continue;
    }
    const start = pending.get(key);
    if (start) {
      pending.delete(key);
      const duration = Math.max(0, event.t_ms - start.t_ms);
      result.push({
        t_ms: start.t_ms,
        type: 'keyboard',
        key: modButtonToKey(start.button),
        keyCode: undefined,
        x: 0,
        y: 0,
        rel_x: 0,
        rel_y: 0,
        duration_ms: duration,
        human_override: false,
        metadata: {
          source: 'geode',
          button: start.button,
          player2: start.player2 ?? false,
          action: 'down',
          release_t_ms: event.t_ms,
        },
      });
    } else {
      result.push({
        t_ms: event.t_ms,
        type: 'keyboard',
        key: modButtonToKey(event.button),
        keyCode: undefined,
        x: 0,
        y: 0,
        rel_x: 0,
        rel_y: 0,
        duration_ms: 0,
        human_override: false,
        metadata: {
          source: 'geode',
          button: event.button,
          player2: event.player2 ?? false,
          action: 'up',
        },
      });
    }
  }

  for (const event of pending.values()) {
    result.push({
      t_ms: event.t_ms,
      type: 'keyboard',
      key: modButtonToKey(event.button),
      keyCode: undefined,
      x: 0,
      y: 0,
      rel_x: 0,
      rel_y: 0,
      duration_ms: 0,
      human_override: false,
      metadata: {
        source: 'geode',
        button: event.button,
        player2: event.player2 ?? false,
        action: 'down',
      },
    });
  }

  return result.sort((a, b) => a.t_ms - b.t_ms);
}

function convertRecordedEventsToModEvents(events: RecordedEvent[]): ModMacroEvent[] {
  const tickMs = 1000 / 240;
  const snapToTick = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.round(value / tickMs) * tickMs;
  };
  const rawEvents: ModMacroEvent[] = [];
  events.forEach(event => {
    const metadata = event.metadata as Record<string, unknown> | undefined;
    if (metadata?.takeover_marker === true) {
      return;
    }

    const source = typeof metadata?.source === 'string' ? metadata.source : '';
    const action = typeof metadata?.action === 'string' ? metadata.action : '';
    let button: 'jump' | 'left' | 'right' | null = null;

    if (typeof metadata?.button === 'string') {
      const rawButton = metadata.button.toLowerCase();
      if (rawButton === 'left' || rawButton === 'right' || rawButton === 'jump' || rawButton === 'space') {
        button = rawButton === 'space' ? 'jump' : (rawButton as 'jump' | 'left' | 'right');
      }
    } else if (event.type === 'mouse') {
      // For non-Geode recordings, only left mouse button maps to jump.
      if ((event.btn ?? 'left') === 'left') {
        button = 'jump';
      }
    } else if (event.type === 'keyboard') {
      const key = (event.key ?? '').toLowerCase();
      if (key === 'left') button = 'left';
      if (key === 'right') button = 'right';
      if (key === 'space') button = 'jump';
    }

    if (!button) {
      return;
    }

    const player2 = Boolean(metadata?.player2);
    const durationMs = Math.max(0, event.duration_ms ?? 0);
    const releaseAt =
      typeof metadata?.release_t_ms === 'number' && Number.isFinite(metadata.release_t_ms)
        ? metadata.release_t_ms
        : undefined;

    // Preserve raw Geode edge events without creating synthetic jumps.
    if (source === 'geode' && action === 'up' && durationMs <= 0) {
      rawEvents.push({ t_ms: snapToTick(event.t_ms), button, down: false, player2 });
      return;
    }

    rawEvents.push({ t_ms: snapToTick(event.t_ms), button, down: true, player2 });

    if (source === 'geode' && action === 'down') {
      if (typeof releaseAt === 'number' && releaseAt >= event.t_ms) {
        rawEvents.push({ t_ms: snapToTick(releaseAt), button, down: false, player2 });
      } else if (durationMs > 0) {
        rawEvents.push({ t_ms: snapToTick(event.t_ms + durationMs), button, down: false, player2 });
      }
      return;
    }

    if (durationMs > 0) {
      rawEvents.push({ t_ms: snapToTick(event.t_ms + durationMs), button, down: false, player2 });
    } else {
      rawEvents.push({ t_ms: snapToTick(event.t_ms), button, down: false, player2 });
    }
  });

  const sorted = rawEvents.sort((a, b) => {
    if (a.t_ms !== b.t_ms) return a.t_ms - b.t_ms;
    if (a.down === b.down) return 0;
    return a.down ? -1 : 1;
  });

  const deduped: ModMacroEvent[] = [];
  const buttonState = new Map<string, boolean>();

  for (const event of sorted) {
    const key = `${event.button}:${event.player2 ? '2' : '1'}`;
    const state = buttonState.get(key) ?? false;
    if (event.down) {
      if (state) continue;
      buttonState.set(key, true);
      deduped.push(event);
      continue;
    }
    if (!state) continue;
    buttonState.set(key, false);
    deduped.push(event);
  }

  return deduped;
}

function buildModPlaybackStatus(
  state: PlaybackStatus['state'],
  totalEvents = 0,
  lastError?: string,
  currentEventIndex = 0,
  gameTick?: number
): PlaybackStatus {
  const tickMs = 1000 / 240;
  return {
    state,
    currentEventIndex,
    totalEvents,
    elapsedMs: typeof gameTick === 'number' ? Math.max(0, gameTick * tickMs) : 0,
    successfulMatches: 0,
    failedMatches: 0,
    retries: 0,
    timingDrift: 0,
    lastError,
  };
}

function buildDraftPlaybackProfile(): Profile | null {
  const draft = profileStore.getDraft();
  if (!draft) return null;
  const createdAt = draft.created_at ?? new Date().toISOString();
  const durationMs = draft.metadata?.total_duration_ms ?? computeProfileDuration(draft.events);
  return {
    id: 'draft',
    name: 'Unsaved Run',
    target_app: draft.target_app,
    created_at: createdAt,
    events: draft.events,
    success_metric: draft.success_metric,
    version: draft.version ?? 1,
    notes: draft.notes ?? '',
    auto_tune: draft.auto_tune,
    metadata: {
      created_at: draft.metadata?.created_at ?? createdAt,
      updated_at: new Date().toISOString(),
      version: draft.version ?? 1,
      total_duration_ms: durationMs,
      event_count: draft.events.length,
      override_count: draft.events.filter(event => event.human_override).length,
      tags: draft.metadata?.tags ?? [],
      custom: draft.metadata?.custom,
    },
  };
}

function shouldAutoTakeover(): boolean {
  const preferences = settingsStore.getPreferences();
  return preferences.autoTakeoverOnInput ?? true;
}

function isGeometryDashTarget(target: string | null | undefined): boolean {
  if (!target) return false;
  return target.toLowerCase().includes('geometry dash');
}

function disarmAutoTakeoverHook() {
  if (!autoTakeoverHookActive) return;
  autoTakeoverHookActive = false;
  autoTakeoverHookTriggered = false;
  autoTakeoverSuppressUntilMs = 0;
  autoTakeoverHook.stop();
  autoTakeoverHook.removeAllListeners();
}

function armAutoTakeoverHook() {
  if (autoTakeoverHookActive) return;
  autoTakeoverHookActive = true;
  autoTakeoverHookTriggered = false;
  autoTakeoverHook.removeAllListeners();
  autoTakeoverHook.on('mousedown', (event: HookEvent) => {
    if (autoTakeoverHookTriggered) return;
    if (Date.now() <= autoTakeoverSuppressUntilMs) return;
    const mouseEvent = event as HookMouseEvent;
    const button = mouseEvent.button ?? 1;
    if (button !== 1) return;

    if (!playbackEngine.playing) return;
    if (typeof mouseEvent.x !== 'number' || typeof mouseEvent.y !== 'number') return;
    autoTakeoverHookTriggered = true;
    void startLocalTakeover(mouseEvent);
  });
  autoTakeoverHook.start();
}

async function startModRecording(target: string): Promise<{ success: boolean; error?: string }> {
  const baseUrl = await resolveModBaseUrl();
  if (!baseUrl) return { success: false, error: 'mod_unreachable' };
  clearPendingDraftState();
  clearModPlaybackAutoIdleTimer();
  clearModStatePollTimer();
  lastPlaybackLeadInMs = 0;
  pendingTakeoverProfile = null;
  pendingTakeoverStartMs = null;
  modTakeoverArmed = false;
  modExpectTakeoverRecording = false;
  modAutoFinalizeRecording = false;
  modTakeoverRearmBlockedUntilMs = 0;
  playbackViaMod = false;
  const response = await modRequest<ModStatusResponse>(baseUrl, '/record/start', { target });
  if (!response.ok) {
    return { success: false, error: response.error ?? 'record_start_failed' };
  }
  recordingViaMod = true;
  activeModBaseUrl = baseUrl;
  // Keep adapter status polling active during plain recording as well so
  // auto-stop on death/complete is always finalized into a draft.
  startModStatePolling(baseUrl, 0);
  applyLifecycle('arm_record', 'mod_record_start');
  broadcastStatus(IPC_CHANNELS.RECORDING_STATUS, { state: 'armed' });
  return { success: true };
}

async function stopModRecordingAndDraft(): Promise<{ success: boolean; profile?: any; error?: string }> {
  if (!activeModBaseUrl) return { success: false, error: 'mod_unreachable' };
  modExpectTakeoverRecording = false;
  let response: ModRecordResponse;
  try {
    response = await modRequest<ModRecordResponse>(activeModBaseUrl, '/record/stop');
  } catch (error: any) {
    const message = error?.message ?? '';
    if (message.includes('not_recording')) {
      clearStaleModRecordingState();
      return { success: false, error: 'not_recording' };
    }
    throw error;
  }
  if (!response.ok) {
    return { success: false, error: response.error ?? 'record_stop_failed' };
  }
  const rawEvents = convertModEventsToRecordedEvents(response.events ?? []);
  let events = rawEvents;
  const takeoverStartMs = response.start_ms ?? null;
  const baseProfile = pendingTakeoverProfile;
  let normalizedTakeoverStartMs =
    baseProfile && typeof takeoverStartMs === 'number'
      ? takeoverStartMs + lastPlaybackLeadInMs
      : null;
  if (baseProfile && typeof normalizedTakeoverStartMs === 'number') {
    const maxBaseMs = computeProfileDuration(baseProfile.events);
    normalizedTakeoverStartMs = Math.max(0, Math.min(normalizedTakeoverStartMs, maxBaseMs));
  }
  const takeoverBaseId = baseProfile?.id ?? null;
  pendingTakeoverStartMs = typeof normalizedTakeoverStartMs === 'number' ? normalizedTakeoverStartMs : null;
  if (baseProfile && typeof normalizedTakeoverStartMs === 'number' && rawEvents.length > 0) {
    events = mergeTakeoverEvents(baseProfile, Math.max(0, normalizedTakeoverStartMs), rawEvents);
  }
  pendingTakeoverProfile = null;
  pendingTakeoverStartMs = null;
  modTakeoverArmed = false;
  playbackViaMod = false;
  clearModStatePollTimer();

  // If recording was only armed and never actually captured inputs, treat
  // this as a cancel/no-op instead of creating an empty draft.
  if (events.length === 0 && !baseProfile) {
    currentRecordingTarget = null;
    recordingViaMod = false;
    activeModBaseUrl = null;
    lastDraftProfile = null;
    draftQuickReplayPending = false;
    applyLifecycle('stop_record', 'mod_record_cancel_empty');
    broadcastStatus(IPC_CHANNELS.RECORDING_STATUS, { state: 'idle' });
    return { success: true, profile: { events: [], duration: 0 } };
  }

  const createdAt = new Date().toISOString();
  const totalDurationMs = events.length > 0 ? computeProfileDuration(events) : response.duration_ms ?? 0;
  profileStore.saveDraft({
    target_app: currentRecordingTarget ?? 'Geometry Dash',
    events,
    success_metric: buildSuccessMetric(),
    created_at: createdAt,
    metadata: {
      created_at: createdAt,
      updated_at: createdAt,
      version: 1,
      total_duration_ms: totalDurationMs,
      event_count: events.length,
      override_count: events.filter(event => event.human_override).length,
      tags: [],
      custom: {
        mod_adapter: MOD_ADAPTER_ID,
        mod_tick_hz: response.tick_hz ?? 240,
        ...(typeof normalizedTakeoverStartMs === 'number'
          ? { takeover_start_ms: normalizedTakeoverStartMs }
          : {}),
        ...(typeof takeoverBaseId === 'string' ? { takeover_base_profile_id: takeoverBaseId } : {}),
      },
    },
  });
  currentRecordingTarget = null;
  recordingViaMod = false;
  activeModBaseUrl = null;
  lastDraftProfile = buildDraftPlaybackProfile();
  draftQuickReplayPending = true;
  applyLifecycle('stop_record', 'mod_record_finalize');
  applyLifecycle('finalize_done', 'mod_record_saved_draft');
  broadcastStatus(IPC_CHANNELS.RUN_COMPLETE, {
    source: 'recording',
    draft: profileStore.getDraft(),
  });
  broadcastStatus(IPC_CHANNELS.RECORDING_STATUS, { state: 'idle' });
  return {
    success: true,
    profile: {
      events,
      duration: response.duration_ms ?? 0,
    },
  };
}

async function armModTakeover(profile: Profile): Promise<{ success: boolean; error?: string }> {
  const baseUrl = await resolveModBaseUrl();
  if (!baseUrl) {
    return { success: false, error: 'mod_unreachable' };
  }
  if (modTakeoverArmed) {
    return { success: true };
  }
  const response = await modRequest<ModStatusResponse>(baseUrl, '/replay/takeover');
  if (!response.ok) {
    return { success: false, error: response.error ?? 'takeover_failed' };
  }
  pendingTakeoverProfile = profile;
  pendingTakeoverStartMs = null;
  activeModBaseUrl = baseUrl;
  currentRecordingTarget = profile.target_app;
  modTakeoverArmed = true;
  modExpectTakeoverRecording = true;
  modTakeoverLastArmAttemptMs = Date.now();
  return { success: true };
}

async function startModPlayback(profile: Profile): Promise<{ success: boolean; error?: string; eventCount?: number }> {
  const baseUrl = await resolveModBaseUrl();
  if (!baseUrl) {
    broadcastStatus(IPC_CHANNELS.PLAYBACK_STATUS, buildModPlaybackStatus('idle', 0, 'mod_unreachable'));
    return { success: false, error: 'mod_unreachable' };
  }
  clearModPlaybackAutoIdleTimer();
  clearModStatePollTimer();
  // Adapter replay is attempt-boundary anchored, so preserve absolute
  // level-start timing from the saved profile and do not trim lead-in.
  lastPlaybackLeadInMs = 0;
  pendingTakeoverProfile = null;
  // Always clear any stale replay arm/state before arming a fresh replay.
  await modRequest<ModStatusResponse>(baseUrl, '/replay/stop').catch(() => null);
  const modEvents = convertRecordedEventsToModEvents(profile.events);
  activeModPlaybackEvents = modEvents;
  const response = await modRequest<ModStatusResponse>(baseUrl, '/replay/start', { events: modEvents });
  if (!response.ok) {
    const errorText = response.error ?? 'replay_start_failed';
    broadcastStatus(IPC_CHANNELS.PLAYBACK_STATUS, buildModPlaybackStatus('idle', 0, errorText));
    return { success: false, error: errorText };
  }
  playbackViaMod = true;
  activeModBaseUrl = baseUrl;
  applyLifecycle('arm_replay', 'mod_replay_start');
  modTakeoverArmed = false;
  modExpectTakeoverRecording = false;
  modTakeoverArmInFlight = false;
  modTakeoverLastArmAttemptMs = 0;
  modTakeoverRearmBlockedUntilMs = 0;
  lastModReplayPaused = false;
  recordingViaMod = false;
  modAutoFinalizeRecording = false;
  if (shouldAutoTakeover()) {
    const takeoverResult = await armModTakeover(profile).catch((error: any) => ({
      success: false,
      error: error?.message ?? 'takeover_arm_failed',
    }));
    if (!takeoverResult.success) {
      broadcastStatus(
        IPC_CHANNELS.PLAYBACK_STATUS,
        buildModPlaybackStatus('playing', modEvents.length, takeoverResult.error ?? 'takeover_arm_failed')
      );
    }
  } else {
    pendingTakeoverProfile = null;
    pendingTakeoverStartMs = null;
    modTakeoverArmed = false;
  }
  startModStatePolling(baseUrl, modEvents.length);
  clearModPlaybackAutoIdleTimer();
  broadcastStatus(IPC_CHANNELS.PLAYBACK_STATUS, buildModPlaybackStatus('playing', modEvents.length));
  return { success: true, eventCount: modEvents.length };
}

async function stopModPlayback(): Promise<{ success: boolean; error?: string }> {
  if (!activeModBaseUrl) return { success: false, error: 'mod_unreachable' };
  modExpectTakeoverRecording = false;
  clearModPlaybackAutoIdleTimer();
  clearModStatePollTimer();
  await modRequest<ModStatusResponse>(activeModBaseUrl, '/replay/stop').catch(() => null);
  applyLifecycle('stop_replay', 'mod_replay_stop');
  settleModPlaybackIdle();
  return { success: true };
}

async function startModTakeoverImmediate(): Promise<{ success: boolean; error?: string }> {
  const baseUrl = await resolveModBaseUrl();
  if (!baseUrl) {
    return { success: false, error: 'mod_unreachable' };
  }
  if (!lastPlaybackProfile) {
    return { success: false, error: 'no_playback_profile' };
  }
  pendingTakeoverProfile = lastPlaybackProfile;
  pendingTakeoverStartMs = null;
  modExpectTakeoverRecording = true;

  const response = await modRequest<ModStatusResponse>(baseUrl, '/replay/takeover', { immediate: true }).catch(
    () => null
  );
  if (!response?.ok) {
    const status = await modGetStatus(baseUrl);
    if (!status?.record_active) {
      modExpectTakeoverRecording = false;
      return { success: false, error: response?.error ?? status?.error ?? 'takeover_failed' };
    }
  }

  clearModPlaybackAutoIdleTimer();
  applyLifecycle('takeover_click', 'mod_takeover_immediate');
  playbackViaMod = false;
  recordingViaMod = true;
  modTakeoverArmed = true;
  activeModBaseUrl = baseUrl;
  disarmAutoTakeoverHook();
  // Keep polling alive during takeover recording so death/complete finalizes
  // into a draft and the save/discard modal always appears.
  startModStatePolling(baseUrl, lastPlaybackProfile.events.length);
  broadcastStatus(IPC_CHANNELS.PLAYBACK_STATUS, buildModPlaybackStatus('idle', lastPlaybackProfile.events.length));
  broadcastStatus(IPC_CHANNELS.RECORDING_STATUS, { state: 'recording' });
  return { success: true };
}

async function startLocalTakeover(triggerEvent?: HookMouseEvent): Promise<{ success: boolean; error?: string }> {
  if (!lastPlaybackProfile) {
    return { success: false, error: 'no_playback_profile' };
  }
  if (!playbackEngine.playing) {
    return { success: false, error: 'not_playing' };
  }
  pendingTakeoverProfile = lastPlaybackProfile;
  pendingTakeoverStartMs = Math.max(0, playbackEngine.getElapsedMs() + lastPlaybackLeadInMs);
  const target = lastPlaybackTarget ?? lastPlaybackProfile.target_app ?? 'screen';
  currentRecordingTarget = target;
  disarmAutoTakeoverHook();
  applyLifecycle('takeover_click', 'local_takeover');
  await playbackEngine.stop();
  recordingEngine.setTakeoverActive(true);
  const result = await recordingEngine.start(buildRecordingConfig({ target }));
  if (result.success) {
    applyLifecycle('arm_record', 'local_record_start');
    applyLifecycle('attempt_boundary', 'local_record_live_immediate');
    if (triggerEvent) {
      recordingEngine.injectMouseDown(triggerEvent);
    }
    broadcastStatus(IPC_CHANNELS.RECORDING_STATUS, { state: 'recording' });
  }
  return result;
}

async function stopRecordingAndDraft() {
  const result = await recordingEngine.stop();
  if (result.success && result.profile) {
    const createdAt = new Date().toISOString();
    let events = result.profile.events;
    if (pendingTakeoverProfile && typeof pendingTakeoverStartMs === 'number') {
      events = mergeTakeoverEvents(
        pendingTakeoverProfile,
        Math.max(0, pendingTakeoverStartMs),
        events
      );
    }
    pendingTakeoverProfile = null;
    pendingTakeoverStartMs = null;
    const totalDurationMs = computeProfileDuration(events);
    profileStore.saveDraft({
      target_app: currentRecordingTarget ?? 'screen',
      events,
      success_metric: buildSuccessMetric(),
      created_at: createdAt,
      metadata: {
        created_at: createdAt,
        updated_at: createdAt,
        version: 1,
        total_duration_ms: totalDurationMs,
        event_count: events.length,
        override_count: events.filter((event: Profile['events'][0]) => event.human_override).length,
        tags: [],
      },
    });
    lastDraftProfile = buildDraftPlaybackProfile();
    draftQuickReplayPending = true;
    applyLifecycle('stop_record', 'local_record_finalize');
    applyLifecycle('finalize_done', 'local_record_saved_draft');
    currentRecordingTarget = null;
    broadcastStatus(IPC_CHANNELS.RUN_COMPLETE, {
      source: 'recording',
      draft: profileStore.getDraft(),
    });
  }
  return result;
}

async function triggerTakeover(): Promise<{ success: boolean; error?: string }> {
  if (playbackViaMod) {
    return startModTakeoverImmediate();
  }
  return startLocalTakeover();
}

type NoPayload = undefined | null;
type IpcInvalidPayload = {
  success: false;
  error: 'E_IPC_INVALID_PAYLOAD';
  code: 'E_IPC_INVALID_PAYLOAD';
  channel: string;
};

function ipcInvalidPayload(channel: string): IpcInvalidPayload {
  return {
    success: false,
    error: 'E_IPC_INVALID_PAYLOAD',
    code: 'E_IPC_INVALID_PAYLOAD',
    channel,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNoPayload(value: unknown): value is NoPayload {
  return value === undefined || value === null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isRecordingConfigPayload(value: unknown): value is Partial<RecordingConfig> {
  if (!isRecord(value)) return false;
  if (value.target !== undefined && typeof value.target !== 'string') return false;
  if (value.captureImages !== undefined && typeof value.captureImages !== 'boolean') return false;
  if (value.imagePatchSize !== undefined && typeof value.imagePatchSize !== 'number') return false;
  if (value.minEventInterval !== undefined && typeof value.minEventInterval !== 'number') return false;
  if (value.recordKeyboard !== undefined && typeof value.recordKeyboard !== 'boolean') return false;
  if (value.recordMouse !== undefined && typeof value.recordMouse !== 'boolean') return false;
  if (value.stopHotkey !== undefined && typeof value.stopHotkey !== 'string') return false;
  if (value.takeoverHotkey !== undefined && typeof value.takeoverHotkey !== 'string') return false;
  return true;
}

function isPlaybackConfigPayload(value: unknown): value is Partial<PlaybackConfig> {
  if (!isRecord(value)) return false;
  if (!isString(value.profileId)) return false;
  if (value.target !== undefined && typeof value.target !== 'string') return false;
  if (value.useImageMatching !== undefined && typeof value.useImageMatching !== 'boolean') return false;
  if (value.imageMatchThreshold !== undefined && typeof value.imageMatchThreshold !== 'number') return false;
  if (value.timingTolerance !== undefined && typeof value.timingTolerance !== 'number') return false;
  if (value.retryCount !== undefined && typeof value.retryCount !== 'number') return false;
  if (value.retryDelay !== undefined && typeof value.retryDelay !== 'number') return false;
  if (value.imageSearchRadius !== undefined && typeof value.imageSearchRadius !== 'number') return false;
  if (value.takeoverHotkey !== undefined && typeof value.takeoverHotkey !== 'string') return false;
  if (value.speedMultiplier !== undefined && typeof value.speedMultiplier !== 'number') return false;
  if (value.useRelativeCoords !== undefined && typeof value.useRelativeCoords !== 'boolean') return false;
  if (value.snapToHz !== undefined && typeof value.snapToHz !== 'number') return false;
  if (value.snapMode !== undefined && !['nearest', 'floor', 'duration-lock'].includes(String(value.snapMode))) {
    return false;
  }
  if (value.snapPhaseMs !== undefined && typeof value.snapPhaseMs !== 'number') return false;
  return true;
}

function isProfilePayload(value: unknown): value is Profile {
  if (!isRecord(value)) return false;
  if (!isString(value.id) || !isString(value.name) || !isString(value.target_app)) return false;
  if (!isString(value.created_at) || !isString(value.notes)) return false;
  if (typeof value.version !== 'number') return false;
  if (!Array.isArray(value.events)) return false;
  if (!isRecord(value.success_metric)) return false;
  return true;
}

function isDraftSavePayload(
  value: unknown
): value is { name: string; notes: string; tags: string[]; autoTune?: Profile['auto_tune'] } {
  if (!isRecord(value)) return false;
  if (!isString(value.name)) return false;
  if (typeof value.notes !== 'string') return false;
  if (!isStringArray(value.tags)) return false;
  return true;
}

function isProfileSelectPayload(value: unknown): value is { profileId?: string | null } {
  if (!isRecord(value)) return false;
  if (value.profileId === undefined || value.profileId === null) return true;
  return typeof value.profileId === 'string';
}

function isSettingsPayload(value: unknown): value is Partial<UserPreferences> {
  return isRecord(value);
}

function isBooleanPayload(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isSubscriptionPayload(value: unknown): value is ReturnType<SettingsStore['getSubscription']> {
  return isRecord(value);
}

function isBillingPayload(value: unknown): value is { priceId: string } {
  return isRecord(value) && isString(value.priceId);
}

function isAuthLoginPayload(value: unknown): value is { email: string; password?: string } {
  if (!isRecord(value)) return false;
  if (!isString(value.email)) return false;
  if (value.password !== undefined && typeof value.password !== 'string') return false;
  return true;
}

function isIdPayload(value: unknown): value is { id: string } {
  return isRecord(value) && isString(value.id);
}

function isUrlPayload(value: unknown): value is { url: string } {
  return isRecord(value) && isString(value.url);
}

function isProfileIdList(value: unknown): value is string[] | undefined {
  return value === undefined || isStringArray(value);
}

function registerValidatedHandle<TPayload, TResult>(
  channel: string,
  validate: (payload: unknown) => payload is TPayload,
  handler: (payload: TPayload) => Promise<TResult> | TResult
) {
  ipcMain.handle(channel, async (_event, payload: unknown) => {
    if (!validate(payload)) {
      return ipcInvalidPayload(channel);
    }
    return handler(payload);
  });
}

function setupIpcHandlers() {
  registerValidatedHandle(IPC_CHANNELS.RECORDING_START, isRecordingConfigPayload, async config => {
    const normalized = buildRecordingConfig(config);
    clearPendingDraftState();
    currentRecordingTarget = normalized.target;
    const preferences = settingsStore.getPreferences();
    const adapterReachable = await isModAdapterReachable();
    const useModAdapterForThisRun =
      adapterReachable && (preferences.useModAdapter || isGeometryDashTarget(normalized.target));
    recordingEngine.setTakeoverActive(false);
    pendingTakeoverProfile = null;
    pendingTakeoverStartMs = null;

    if (useModAdapterForThisRun) {
      try {
        const result = await startModRecording(normalized.target);
        if (result.success) return result;
        return { success: false, error: result.error ?? 'record_start_failed' };
      } catch (error: any) {
        return { success: false, error: error?.message ?? 'record_start_failed' };
      }
    }

    const result = await recordingEngine.start(normalized);
    if (result.success) {
      applyLifecycle('arm_record', 'local_record_start_ipc');
      applyLifecycle('attempt_boundary', 'local_record_live_ipc');
      broadcastStatus(IPC_CHANNELS.RECORDING_STATUS, { state: 'recording' });
    }
    return result;
  });

  registerValidatedHandle(IPC_CHANNELS.RECORDING_STOP, isNoPayload, async () => {
    const modState = await resolveModRecordingState();
    const shouldStopMod =
      recordingViaMod || modTakeoverArmed || (modState ? isModRecordingLifecycleActive(modState.status) : false);
    if (shouldStopMod) {
      if (!modState) {
        clearStaleModRecordingState();
        return { success: false, error: 'mod_unreachable' };
      }
      activeModBaseUrl = modState.baseUrl;
      try {
        return await stopModRecordingAndDraft();
      } catch (error: any) {
        clearStaleModRecordingState();
        return { success: false, error: error?.message ?? 'record_stop_failed' };
      }
    }

    if (recordingViaMod || modTakeoverArmed) {
      clearStaleModRecordingState();
      return { success: false, error: 'not_recording' };
    }

    return stopRecordingAndDraft();
  });

  registerValidatedHandle(IPC_CHANNELS.PLAYBACK_START, isPlaybackConfigPayload, async config => {
    const playbackConfig = buildPlaybackConfig(config);
    const profile = profileStore.get(playbackConfig.profileId);
    if (!profile) {
      return { success: false, error: 'Profile not found' };
    }
    draftQuickReplayPending = false;
    lastProfileId = profile.id;
    lastPlaybackProfile = profile;
    lastPlaybackTarget = playbackConfig.target;
    pendingTakeoverProfile = null;
    pendingTakeoverStartMs = null;
    lastPlaybackLeadInMs = 0;
    const preferences = settingsStore.getPreferences();
    const adapterReachable = await isModAdapterReachable();
    const useModAdapterForThisRun =
      adapterReachable && (preferences.useModAdapter || isGeometryDashTarget(profile.target_app));
    if (useModAdapterForThisRun) {
      try {
        const modResult = await startModPlayback(profile);
        if (modResult.success) {
          return modResult;
        }
        return { success: false, error: modResult.error ?? 'replay_start_failed' };
      } catch (error: any) {
        return { success: false, error: error?.message ?? 'replay_start_failed' };
      }
    }

    const runtime = buildRuntimePlaybackProfile(profile);
    lastPlaybackLeadInMs = runtime.leadInMs;
    const result = await playbackEngine.start(playbackConfig, runtime.profile);
    if (result.success && shouldAutoTakeover()) {
      armAutoTakeoverHook();
    }
    if (result.success) {
      applyLifecycle('arm_replay', 'local_replay_start_ipc');
      applyLifecycle('attempt_boundary', 'local_replay_live_ipc');
    }
    if (!result.success) {
      broadcastStatus(
        IPC_CHANNELS.PLAYBACK_STATUS,
        { ...playbackEngine.getStatus(), state: 'idle', lastError: result.error ?? 'playback_start_failed' }
      );
    }
    return result;
  });

  registerValidatedHandle(IPC_CHANNELS.PLAYBACK_STOP, isNoPayload, async () => {
    if (playbackViaMod && activeModBaseUrl) {
      return stopModPlayback();
    }
    disarmAutoTakeoverHook();
    lastPlaybackLeadInMs = 0;
    applyLifecycle('stop_replay', 'local_replay_stop_ipc');
    return playbackEngine.stop();
  });

  registerValidatedHandle(IPC_CHANNELS.PLAYBACK_SELECT, isProfileSelectPayload, async payload => {
    const profileId = payload?.profileId ?? null;
    if (!profileId) {
      return { success: false, error: 'Profile id missing' };
    }
    const profile = profileStore.get(profileId);
    if (!profile) {
      return { success: false, error: 'Profile not found' };
    }
    draftQuickReplayPending = false;
    lastProfileId = profile.id;
    lastPlaybackProfile = profile;
    return { success: true };
  });

  registerValidatedHandle(IPC_CHANNELS.PLAYBACK_TAKEOVER, isNoPayload, async () => {
    return triggerTakeover();
  });

  registerValidatedHandle(IPC_CHANNELS.PROFILE_LIST, isNoPayload, async () => profileStore.list());
  registerValidatedHandle(IPC_CHANNELS.PROFILE_GET, isString, async id => profileStore.get(id));

  registerValidatedHandle(IPC_CHANNELS.PROFILE_SAVE, isProfilePayload, async profile => {
    try {
      const subscription = settingsStore.getSubscription();
      const saved = profileStore.save(profile, subscription);
      lastProfileId = saved.id;
      broadcastStatus('profile:saved', saved);
      const preferences = settingsStore.getPreferences();
      if (subscription.features.cloudSync && preferences.cloudSyncOptIn) {
        void syncProfileToCloud(saved);
      }
      return saved;
    } catch (error: any) {
      return { success: false, error: error?.message ?? 'Save failed' };
    }
  });

  registerValidatedHandle(
    IPC_CHANNELS.PROFILE_SAVE_DRAFT,
    isDraftSavePayload,
    async payload => {
    try {
      const subscription = settingsStore.getSubscription();
      const draftProfile = profileStore.finalizeDraft(payload.name, payload.notes, payload.tags);
      draftProfile.auto_tune = payload.autoTune;
      if (draftProfile.metadata && draftProfile.auto_tune?.enabled) {
        const tuned = runAutoTune(draftProfile.events, draftProfile.auto_tune);
        draftProfile.metadata.custom = {
          ...(draftProfile.metadata.custom ?? {}),
          timing_adjustments: tuned.adjustments,
        };
      }
      const saved = profileStore.create(draftProfile, subscription);
      profileStore.discardDraft();
      lastDraftProfile = null;
      draftQuickReplayPending = false;
      lastProfileId = saved.id;
      broadcastStatus('profile:saved', saved);
      const preferences = settingsStore.getPreferences();
      if (subscription.features.cloudSync && preferences.cloudSyncOptIn) {
        void syncProfileToCloud(saved);
      }
      return saved;
    } catch (error: any) {
      return { success: false, error: error?.message ?? 'Save failed' };
    }
  }
  );

  registerValidatedHandle(IPC_CHANNELS.PROFILE_DISCARD_DRAFT, isNoPayload, async () => {
    profileStore.discardDraft();
    lastDraftProfile = null;
    draftQuickReplayPending = false;
    return { success: true };
  });

  registerValidatedHandle(IPC_CHANNELS.PROFILE_DELETE, isString, async id => {
    profileStore.delete(id);
    const subscription = settingsStore.getSubscription();
    const preferences = settingsStore.getPreferences();
    if (subscription.features.cloudSync && preferences.cloudSyncOptIn) {
      void syncProfileDeleteToCloud(id);
    }
    return { success: true };
  });

  registerValidatedHandle(IPC_CHANNELS.PROFILE_EXPORT, isProfileIdList, async profileIds => {
    if (!mainWindow) return { success: false, error: 'Window missing' };
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Profiles',
      defaultPath: profileStore.suggestExportPath(app.getPath('documents'), 'clicksmith-profiles.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { success: false };
    return { success: true, data: profileStore.exportProfiles(result.filePath, profileIds) };
  });

  registerValidatedHandle(IPC_CHANNELS.PROFILE_IMPORT, isNoPayload, async () => {
    if (!mainWindow) return { success: false, error: 'Window missing' };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Profiles',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return { success: false };
    const imported = profileStore.importProfiles(result.filePaths[0]);
    return { success: true, data: imported };
  });

  registerValidatedHandle(IPC_CHANNELS.WINDOW_LIST, isNoPayload, async () => windowManager.listWindowsForPicker());

  registerValidatedHandle(IPC_CHANNELS.SETTINGS_GET, isNoPayload, async () => ({
    preferences: settingsStore.getPreferences(),
    subscription: settingsStore.getSubscription(),
    eulaAccepted: settingsStore.hasAcceptedEula(),
  }));

  registerValidatedHandle(IPC_CHANNELS.SETTINGS_SET, isSettingsPayload, async preferences => {
    const updated = settingsStore.setPreferences(preferences);
    registerGlobalHotkeys(updated.hotkeys);
    return updated;
  });

  registerValidatedHandle(IPC_CHANNELS.SUBSCRIPTION_SET, isSubscriptionPayload, async subscription => {
    return settingsStore.setSubscription(subscription);
  });

  registerValidatedHandle(IPC_CHANNELS.SUBSCRIPTION_GET, isNoPayload, async () => settingsStore.getSubscription());

  registerValidatedHandle(IPC_CHANNELS.EULA_ACCEPT, isBooleanPayload, async accepted => {
    settingsStore.setEulaAccepted(accepted);
    return { success: true };
  });

  registerValidatedHandle(IPC_CHANNELS.BILLING_CHECKOUT, isBillingPayload, async payload => {
    const endpoint = process.env.CLICKSMITH_API_URL || 'http://127.0.0.1:3000';
    try {
      const response = await fetch(`${endpoint}/api/v1/billing/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        return { success: false, error: `Billing service error (${response.status})` };
      }
      const data = await response.json();
      if (data?.url) {
        await shell.openExternal(data.url);
        return { success: true };
      }
      return { success: false, error: 'Checkout unavailable' };
    } catch (error: any) {
      return { success: false, error: error?.message ?? 'Checkout failed' };
    }
  });

  registerValidatedHandle(IPC_CHANNELS.MODS_LIST, isNoPayload, async () => modManager.listAdapters());

  registerValidatedHandle(IPC_CHANNELS.MODS_PROBE, isIdPayload, async payload => {
    const status = await modManager.probeAdapter(payload.id);
    if (!status) {
      return { success: false, error: 'Adapter not found' };
    }
    return { success: true, status };
  });

  registerValidatedHandle(IPC_CHANNELS.MODS_LAUNCH, isIdPayload, async payload => {
    return modManager.launchAdapter(payload.id);
  });

  registerValidatedHandle(IPC_CHANNELS.MODS_OPEN_DOC, isIdPayload, async payload => {
    return modManager.openInstallDoc(payload.id);
  });

  registerValidatedHandle(IPC_CHANNELS.MODS_OPEN_URL, isUrlPayload, async payload => {
    return modManager.openDownloadUrl(payload.url);
  });

  registerValidatedHandle(IPC_CHANNELS.AUTH_STATUS, isNoPayload, async () => ({
    authenticated: false,
    user: null,
    provider: 'not_configured',
  }));

  registerValidatedHandle(IPC_CHANNELS.AUTH_LOGIN, isAuthLoginPayload, async payload => ({
    success: false,
    error: 'not_implemented',
    email: payload.email,
  }));

  registerValidatedHandle(IPC_CHANNELS.AUTH_LOGOUT, isNoPayload, async () => ({ success: true }));

  registerValidatedHandle(IPC_CHANNELS.APP_VERSION, isNoPayload, async () => app.getVersion());

  ipcMain.on('overlay:set-interactive', (_, interactive: unknown) => {
    if (typeof interactive !== 'boolean') return;
    if (!overlayWindow) return;
    overlayWindow.setIgnoreMouseEvents(!interactive, { forward: true });
  });

  ipcMain.on(IPC_CHANNELS.OVERLAY_SHOW, () => overlayWindow?.show());
  ipcMain.on(IPC_CHANNELS.OVERLAY_HIDE, () => overlayWindow?.hide());
  ipcMain.on(IPC_CHANNELS.APP_MINIMIZE, () => mainWindow?.minimize());
  ipcMain.on(IPC_CHANNELS.APP_QUIT, () => app.quit());
}

function registerGlobalHotkeys(hotkeys = DEFAULT_HOTKEYS) {
  globalShortcut.unregisterAll();

  globalShortcut.register(hotkeys.toggleRecording, async () => {
    const preferences = settingsStore.getPreferences();
    const modState = await resolveModRecordingState();
    const shouldStopMod =
      recordingViaMod || modTakeoverArmed || (modState ? isModRecordingLifecycleActive(modState.status) : false);
    if (shouldStopMod) {
      if (!modState) {
        clearStaleModRecordingState();
        return;
      }
      activeModBaseUrl = modState.baseUrl;
      await stopModRecordingAndDraft().catch(() => {
        clearStaleModRecordingState();
      });
      return;
    }

    if (recordingEngine.recording) {
      await stopRecordingAndDraft();
      mainWindow?.webContents.send(IPC_CHANNELS.RECORDING_STATUS, {
        state: recordingEngine.recording ? 'recording' : 'idle',
      });
      return;
    }

    const adapterReachable = await isModAdapterReachable();
    const useModAdapterForThisRun = adapterReachable && preferences.useModAdapter;
    clearPendingDraftState();
    if (useModAdapterForThisRun) {
      const result = await startModRecording('screen').catch(() => null);
      if (result?.success) return;
      broadcastStatus(IPC_CHANNELS.RECORDING_STATUS, { state: 'idle', error: result?.error ?? 'record_start_failed' });
      return;
    }

    currentRecordingTarget = 'screen';
    await recordingEngine.start(buildRecordingConfig({ target: 'screen' }));
    applyLifecycle('arm_record', 'local_record_start_hotkey');
    applyLifecycle('attempt_boundary', 'local_record_live_hotkey');
    mainWindow?.webContents.send(IPC_CHANNELS.RECORDING_STATUS, {
      state: recordingEngine.recording ? 'recording' : 'idle',
    });
  });

  globalShortcut.register(hotkeys.togglePlayback, async () => {
    const preferences = settingsStore.getPreferences();
    const adapterReachable = await isModAdapterReachable();
    if (playbackViaMod && activeModBaseUrl) {
      const status = await modGetStatus(activeModBaseUrl);
      const adapterReplayBusy = Boolean(
        status?.replay_active || status?.replay_armed || status?.replay_requested || status?.record_active
      );
      if (adapterReplayBusy) {
        await stopModPlayback().catch(() => null);
        return;
      }
      // Renderer/UI can briefly lag behind adapter state; clear stale local
      // flags and continue as a start request in this same key press.
      settleModPlaybackIdle(lastPlaybackProfile?.events.length ?? 0);
    }
    if (playbackEngine.playing) {
      disarmAutoTakeoverHook();
      lastPlaybackLeadInMs = 0;
      applyLifecycle('stop_replay', 'local_replay_stop_hotkey');
      await playbackEngine.stop();
      return;
    }
    const draftProfile = draftQuickReplayPending ? lastDraftProfile ?? buildDraftPlaybackProfile() : null;
    if (draftProfile) {
      draftQuickReplayPending = false;
      lastPlaybackProfile = draftProfile;
      lastPlaybackTarget = draftProfile.target_app;
      const useModAdapterForThisRun =
        adapterReachable && (preferences.useModAdapter || isGeometryDashTarget(draftProfile.target_app));
      if (useModAdapterForThisRun) {
        const modResult = await startModPlayback(draftProfile).catch((error: any) => ({
          success: false,
          error: error?.message ?? 'replay_start_failed',
        }));
        if (modResult?.success) {
          return;
        }
        broadcastStatus(
          IPC_CHANNELS.PLAYBACK_STATUS,
          buildModPlaybackStatus('idle', 0, modResult?.error ?? 'replay_start_failed')
        );
        return;
      }
      const runtime = buildRuntimePlaybackProfile(draftProfile);
      lastPlaybackLeadInMs = runtime.leadInMs;
      const result = await playbackEngine.start(
        buildPlaybackConfig({ profileId: draftProfile.id, target: draftProfile.target_app }),
        runtime.profile
      );
      if (result.success && shouldAutoTakeover()) {
        armAutoTakeoverHook();
      }
      if (result.success) {
        applyLifecycle('arm_replay', 'local_replay_start_hotkey_draft');
        applyLifecycle('attempt_boundary', 'local_replay_live_hotkey_draft');
      }
      return;
    }

    let profileId = lastProfileId;
    if (!profileId) {
      const fallback = profileStore.list()[0];
      if (!fallback) return;
      profileId = fallback.id;
      lastProfileId = fallback.id;
      lastPlaybackProfile = fallback;
    }
    const profile = profileStore.get(profileId);
    if (!profile) return;
    lastPlaybackProfile = profile;
    const useModAdapterForThisRun =
      adapterReachable && (preferences.useModAdapter || isGeometryDashTarget(profile.target_app));
    if (useModAdapterForThisRun) {
      const modResult = await startModPlayback(profile).catch((error: any) => ({
        success: false,
        error: error?.message ?? 'replay_start_failed',
      }));
      if (modResult?.success) {
        return;
      }
      broadcastStatus(
        IPC_CHANNELS.PLAYBACK_STATUS,
        buildModPlaybackStatus('idle', 0, modResult?.error ?? 'replay_start_failed')
      );
      return;
    }

    lastPlaybackTarget = 'screen';
    const runtime = buildRuntimePlaybackProfile(profile);
    lastPlaybackLeadInMs = runtime.leadInMs;
    const result = await playbackEngine.start(
      buildPlaybackConfig({ profileId, target: 'screen' }),
      runtime.profile
    );
    if (result.success && shouldAutoTakeover()) {
      armAutoTakeoverHook();
    }
    if (result.success) {
      applyLifecycle('arm_replay', 'local_replay_start_hotkey_profile');
      applyLifecycle('attempt_boundary', 'local_replay_live_hotkey_profile');
    }
  });

  globalShortcut.register(hotkeys.takeover, () => {
    void triggerTakeover();
  });

  globalShortcut.register(hotkeys.saveProfile, () => {
    mainWindow?.webContents.send(IPC_CHANNELS.PROFILE_SAVE_REQUEST);
  });

  globalShortcut.register(hotkeys.discardChanges, () => {
    mainWindow?.webContents.send(IPC_CHANNELS.PROFILE_DISCARD_DRAFT);
  });

  globalShortcut.register(hotkeys.quickReplay, async () => {
    let profileId = lastProfileId;
    if (!profileId) {
      const fallback = profileStore.list()[0];
      if (!fallback) return;
      profileId = fallback.id;
      lastProfileId = fallback.id;
      lastPlaybackProfile = fallback;
    }
    const profile = profileStore.get(profileId);
    if (!profile) return;
    lastPlaybackProfile = profile;
    const preferences = settingsStore.getPreferences();
    const adapterReachable = await isModAdapterReachable();
    const useModAdapterForThisRun =
      adapterReachable && (preferences.useModAdapter || isGeometryDashTarget(profile.target_app));
    if (useModAdapterForThisRun) {
      const modResult = await startModPlayback(profile).catch((error: any) => ({
        success: false,
        error: error?.message ?? 'replay_start_failed',
      }));
      if (modResult?.success) {
        return;
      }
      broadcastStatus(
        IPC_CHANNELS.PLAYBACK_STATUS,
        buildModPlaybackStatus('idle', 0, modResult?.error ?? 'replay_start_failed')
      );
      return;
    }
    lastPlaybackTarget = 'screen';
    const runtime = buildRuntimePlaybackProfile(profile);
    lastPlaybackLeadInMs = runtime.leadInMs;
    const result = await playbackEngine.start(
      buildPlaybackConfig({ profileId, target: 'screen' }),
      runtime.profile
    );
    if (result.success && shouldAutoTakeover()) {
      armAutoTakeoverHook();
    }
    if (result.success) {
      applyLifecycle('arm_replay', 'local_replay_start_quick');
      applyLifecycle('attempt_boundary', 'local_replay_live_quick');
    }
  });

  globalShortcut.register(hotkeys.openOverlay, () => {
    if (!overlayWindow) return;
    if (overlayWindow.isVisible()) {
      overlayWindow.hide();
    } else {
      overlayWindow.show();
    }
  });
}

recordingEngine.on('status', status => {
  if (status.state === 'paused') {
    applyLifecycle('pause', 'recording_engine_paused');
  } else if (lastRecordingEngineState === 'paused' && status.state === 'recording') {
    applyLifecycle('unpause', 'recording_engine_resumed');
  }

  if (status.state === 'idle' && (lastRecordingEngineState === 'recording' || lastRecordingEngineState === 'stopping')) {
    const snapshot = runLifecycle.getSnapshot();
    if (snapshot.state === 'record_live' || snapshot.state === 'takeover_live' || snapshot.state === 'finalizing') {
      applyLifecycle('stop_record', 'recording_engine_idle');
      applyLifecycle('finalize_done', 'recording_engine_idle_finalize');
    }
  }

  lastRecordingEngineState = status.state;
  broadcastStatus(IPC_CHANNELS.RECORDING_STATUS, status);
});

playbackEngine.on('status', status => {
  if (status.state === 'paused') {
    applyLifecycle('pause', 'playback_engine_paused');
  } else if (lastPlaybackEngineState === 'paused' && status.state === 'playing') {
    applyLifecycle('unpause', 'playback_engine_resumed');
  }

  if (status.state === 'idle' && (lastPlaybackEngineState === 'playing' || lastPlaybackEngineState === 'paused')) {
    applyLifecycle('stop_replay', 'playback_engine_idle');
  }

  if (status.state === 'playing') {
    const snapshot = runLifecycle.getSnapshot();
    const runChanged = lastLoggedDispatchRunId !== snapshot.runId || lastLoggedDispatchAttempt !== snapshot.attemptId;
    if (runChanged) {
      lastLoggedDispatchRunId = snapshot.runId;
      lastLoggedDispatchAttempt = snapshot.attemptId;
      lastLoggedDispatchIndex = -1;
    }
    if (status.currentEventIndex >= 0 && status.currentEventIndex !== lastLoggedDispatchIndex) {
      const actualMs = Math.max(0, status.elapsedMs);
      const deltaMs = status.timingDrift;
      const scheduledMs = Math.max(0, actualMs - deltaMs);
      runTrace.logDispatch({
        runId: snapshot.runId,
        attemptId: snapshot.attemptId,
        eventIndex: status.currentEventIndex,
        scheduledMs,
        actualMs,
        deltaMs,
        action: 'playback_event',
      });
      lastLoggedDispatchIndex = status.currentEventIndex;
    }
  }

  lastPlaybackEngineState = status.state;
  broadcastStatus(IPC_CHANNELS.PLAYBACK_STATUS, status);
});
playbackEngine.on('dispatch', (payload: { actionType?: string }) => {
  if (payload?.actionType === 'mouseDown') {
    autoTakeoverSuppressUntilMs = Date.now() + AUTO_TAKEOVER_SUPPRESS_WINDOW_MS;
  }
});
playbackEngine.on('complete', status => {
  applyLifecycle('stop_replay', 'playback_engine_complete');
  disarmAutoTakeoverHook();
  broadcastStatus(IPC_CHANNELS.RUN_COMPLETE, { source: 'playback', status });
});

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    app.setActivationPolicy('regular');
    app.dock.show();
  }
  createMainWindow();
  createOverlayWindow();
  setupIpcHandlers();
  registerGlobalHotkeys(settingsStore.getPreferences().hotkeys);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  recordingEngine.dispose();
  globalShortcut.unregisterAll();
});
