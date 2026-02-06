import { app, BrowserWindow, dialog, ipcMain, globalShortcut, screen, shell } from 'electron';
import * as path from 'path';
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
import { syncProfileToCloud } from './cloudSync';
import { ModManager } from './modManager';
import { createDefaultInputHook, HookEvent, HookMouseEvent, InputHook } from './inputHooks';

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

let lastProfileId: string | null = null;
let currentRecordingTarget: string | null = null;
let lastPlaybackProfile: Profile | null = null;
let lastPlaybackTarget: string | null = null;
let lastPlaybackLeadInMs = 0;
let lastDraftProfile: Profile | null = null;
let recordingViaMod = false;
let playbackViaMod = false;
let activeModBaseUrl: string | null = null;
let pendingTakeoverProfile: Profile | null = null;
let pendingTakeoverStartMs: number | null = null;
let modTakeoverArmed = false;
let modPlaybackAutoIdleTimer: NodeJS.Timeout | null = null;
let modStatePollTimer: NodeJS.Timeout | null = null;
let autoTakeoverHookActive = false;
let autoTakeoverHookTriggered = false;
const autoTakeoverHook: InputHook = createDefaultInputHook();

function broadcastStatus(channel: string, data: any) {
  mainWindow?.webContents.send(channel, data);
  overlayWindow?.webContents.send(channel, data);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
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
      nodeIntegration: true,
      contextIsolation: false,
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
    imageSearchRadius: config.imageSearchRadius ?? 160,
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

function settleModPlaybackIdle(totalEvents = 0) {
  clearModPlaybackAutoIdleTimer();
  clearModStatePollTimer();
  playbackViaMod = false;
  modTakeoverArmed = false;
  activeModBaseUrl = null;
  pendingTakeoverProfile = null;
  pendingTakeoverStartMs = null;
  lastPlaybackLeadInMs = 0;
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
      if (!playbackViaMod && !recordingViaMod && !modTakeoverArmed) {
        clearModStatePollTimer();
        return;
      }

      const status = await modGetStatus(baseUrl);
      if (!status?.ok) return;

      if (playbackViaMod && status.record_active && !status.replay_active) {
        clearModPlaybackAutoIdleTimer();
        playbackViaMod = false;
        recordingViaMod = true;
        modTakeoverArmed = true;
        disarmAutoTakeoverHook();
        broadcastStatus(IPC_CHANNELS.PLAYBACK_STATUS, buildModPlaybackStatus('idle', totalEvents));
        broadcastStatus(IPC_CHANNELS.RECORDING_STATUS, { state: 'recording' });
        return;
      }

      if (playbackViaMod && !status.replay_active && !status.replay_requested && !status.record_active) {
        settleModPlaybackIdle(totalEvents);
      }
    })();
  }, 120);
}

function mergeTakeoverEvents(
  baseProfile: Profile,
  takeoverStartMs: number,
  takeoverEvents: RecordedEvent[]
): RecordedEvent[] {
  const clampedBase = baseProfile.events
    .filter(event => event.t_ms <= takeoverStartMs)
    .map(event => {
      const duration = Math.max(0, event.duration_ms ?? 0);
      if (duration <= 0) return event;
      const end = event.t_ms + duration;
      if (end <= takeoverStartMs) return event;
      return {
        ...event,
        duration_ms: Math.max(0, takeoverStartMs - event.t_ms),
      };
    });

  const takeoverSegment = takeoverEvents.map(event => ({
    ...event,
    t_ms: event.t_ms + takeoverStartMs,
    human_override: true,
    metadata: {
      ...(event.metadata ?? {}),
      takeover_segment: true,
    },
  }));

  return [...clampedBase, ...takeoverSegment].sort((a, b) => a.t_ms - b.t_ms);
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

type ModStatusResponse = {
  ok: boolean;
  state?: string;
  tick_hz?: number;
  capabilities?: string[];
  record_active?: boolean;
  record_armed?: boolean;
  replay_active?: boolean;
  replay_requested?: boolean;
  takeover_armed?: boolean;
  error?: string;
};

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
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await response.json()) as T;
  if (!response.ok) {
    throw new Error((data as any)?.error ?? `Mod request failed (${response.status})`);
  }
  return data;
}

async function modGetStatus(baseUrl: string): Promise<ModStatusResponse | null> {
  try {
    const response = await fetch(`${baseUrl}/status`);
    if (!response.ok) return null;
    return (await response.json()) as ModStatusResponse;
  } catch {
    return null;
  }
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
  const rawEvents: ModMacroEvent[] = [];
  events.forEach(event => {
    const metadata = event.metadata as Record<string, unknown> | undefined;
    const button =
      (typeof metadata?.button === 'string' && metadata.button) ||
      (event.key === 'left' ? 'left' : event.key === 'right' ? 'right' : 'jump');
    const player2 = Boolean(metadata?.player2);
    const source = typeof metadata?.source === 'string' ? metadata.source : '';
    const action = typeof metadata?.action === 'string' ? metadata.action : '';
    const durationMs = Math.max(0, event.duration_ms ?? 0);
    const releaseAt =
      typeof metadata?.release_t_ms === 'number' && Number.isFinite(metadata.release_t_ms)
        ? metadata.release_t_ms
        : undefined;

    // Preserve raw Geode edge events without creating synthetic jumps.
    if (source === 'geode' && action === 'up' && durationMs <= 0) {
      rawEvents.push({ t_ms: event.t_ms, button, down: false, player2 });
      return;
    }

    rawEvents.push({ t_ms: event.t_ms, button, down: true, player2 });

    if (source === 'geode' && action === 'down') {
      if (typeof releaseAt === 'number' && releaseAt >= event.t_ms) {
        rawEvents.push({ t_ms: releaseAt, button, down: false, player2 });
      } else if (durationMs > 0) {
        rawEvents.push({ t_ms: event.t_ms + durationMs, button, down: false, player2 });
      }
      return;
    }

    if (durationMs > 0) {
      rawEvents.push({ t_ms: event.t_ms + durationMs, button, down: false, player2 });
    } else {
      rawEvents.push({ t_ms: event.t_ms, button, down: false, player2 });
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
  lastError?: string
): PlaybackStatus {
  return {
    state,
    currentEventIndex: 0,
    totalEvents,
    elapsedMs: 0,
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

function disarmAutoTakeoverHook() {
  if (!autoTakeoverHookActive) return;
  autoTakeoverHookActive = false;
  autoTakeoverHookTriggered = false;
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
    const mouseEvent = event as HookMouseEvent;
    const button = mouseEvent.button ?? 1;
    if (button !== 1) return;

    if (playbackViaMod) {
      autoTakeoverHookTriggered = true;
      void startModTakeoverImmediate();
      return;
    }

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
  clearModPlaybackAutoIdleTimer();
  clearModStatePollTimer();
  lastPlaybackLeadInMs = 0;
  pendingTakeoverProfile = null;
  pendingTakeoverStartMs = null;
  modTakeoverArmed = false;
  playbackViaMod = false;
  const response = await modRequest<ModStatusResponse>(baseUrl, '/record/start', { target });
  if (!response.ok) {
    return { success: false, error: response.error ?? 'record_start_failed' };
  }
  recordingViaMod = true;
  activeModBaseUrl = baseUrl;
  return { success: true };
}

async function stopModRecordingAndDraft(): Promise<{ success: boolean; profile?: any; error?: string }> {
  if (!activeModBaseUrl) return { success: false, error: 'mod_unreachable' };
  const response = await modRequest<ModRecordResponse>(activeModBaseUrl, '/record/stop');
  if (!response.ok) {
    return { success: false, error: response.error ?? 'record_stop_failed' };
  }
  const rawEvents = convertModEventsToRecordedEvents(response.events ?? []);
  let events = rawEvents;
  const takeoverStartMs = response.start_ms ?? null;
  const baseProfile = pendingTakeoverProfile;
  const normalizedTakeoverStartMs =
    baseProfile && typeof takeoverStartMs === 'number'
      ? takeoverStartMs + lastPlaybackLeadInMs
      : null;
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
  const runtime = buildRuntimePlaybackProfile(profile);
  lastPlaybackLeadInMs = runtime.leadInMs;
  pendingTakeoverProfile = null;
  const modEvents = convertRecordedEventsToModEvents(runtime.profile.events);
  const response = await modRequest<ModStatusResponse>(baseUrl, '/replay/start', { events: modEvents });
  if (!response.ok) {
    const errorText = response.error ?? 'replay_start_failed';
    broadcastStatus(IPC_CHANNELS.PLAYBACK_STATUS, buildModPlaybackStatus('idle', 0, errorText));
    return { success: false, error: errorText };
  }
  playbackViaMod = true;
  activeModBaseUrl = baseUrl;
  modTakeoverArmed = false;
  recordingViaMod = false;
  if (shouldAutoTakeover()) {
    const takeoverResult = await armModTakeover(profile).catch((error: any) => ({
      success: false,
      error: error?.message ?? 'takeover_arm_failed',
    }));
    armAutoTakeoverHook();
    if (!takeoverResult.success) {
      broadcastStatus(
        IPC_CHANNELS.PLAYBACK_STATUS,
        buildModPlaybackStatus('playing', modEvents.length, takeoverResult.error ?? 'takeover_arm_failed')
      );
    }
  } else {
    disarmAutoTakeoverHook();
  }
  startModStatePolling(baseUrl, modEvents.length);
  scheduleModPlaybackAutoIdle(modEvents);
  broadcastStatus(IPC_CHANNELS.PLAYBACK_STATUS, buildModPlaybackStatus('playing', modEvents.length));
  return { success: true, eventCount: modEvents.length };
}

async function stopModPlayback(): Promise<{ success: boolean; error?: string }> {
  if (!activeModBaseUrl) return { success: false, error: 'mod_unreachable' };
  clearModPlaybackAutoIdleTimer();
  clearModStatePollTimer();
  await modRequest<ModStatusResponse>(activeModBaseUrl, '/replay/stop').catch(() => null);
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

  const response = await modRequest<ModStatusResponse>(baseUrl, '/replay/takeover', { immediate: true }).catch(
    () => null
  );
  if (!response?.ok) {
    const status = await modGetStatus(baseUrl);
    if (!status?.record_active) {
      return { success: false, error: response?.error ?? status?.error ?? 'takeover_failed' };
    }
  }

  clearModPlaybackAutoIdleTimer();
  clearModStatePollTimer();
  playbackViaMod = false;
  recordingViaMod = true;
  modTakeoverArmed = true;
  activeModBaseUrl = baseUrl;
  disarmAutoTakeoverHook();
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
  await playbackEngine.stop();
  recordingEngine.setTakeoverActive(true);
  const result = await recordingEngine.start(buildRecordingConfig({ target }));
  if (result.success) {
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

function setupIpcHandlers() {
  ipcMain.handle(IPC_CHANNELS.RECORDING_START, async (_, config: RecordingConfig) => {
    const normalized = buildRecordingConfig(config);
    currentRecordingTarget = normalized.target;
    const preferences = settingsStore.getPreferences();
    recordingEngine.setTakeoverActive(false);
    pendingTakeoverProfile = null;
    pendingTakeoverStartMs = null;

    if (preferences.useModAdapter) {
      try {
        const result = await startModRecording(normalized.target);
        if (result.success) {
          broadcastStatus(IPC_CHANNELS.RECORDING_STATUS, { state: 'recording' });
        }
        return result;
      } catch (error: any) {
        return { success: false, error: error?.message ?? 'record_start_failed' };
      }
    }

    const result = await recordingEngine.start(normalized);
    if (result.success) {
      broadcastStatus(IPC_CHANNELS.RECORDING_STATUS, { state: 'recording' });
    }
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.RECORDING_STOP, async () => {
    if ((recordingViaMod || modTakeoverArmed) && activeModBaseUrl) {
      try {
        return await stopModRecordingAndDraft();
      } catch (error: any) {
        recordingViaMod = false;
        activeModBaseUrl = null;
        return { success: false, error: error?.message ?? 'record_stop_failed' };
      }
    }

    return stopRecordingAndDraft();
  });

  ipcMain.handle(IPC_CHANNELS.PLAYBACK_START, async (_, config: PlaybackConfig) => {
    const playbackConfig = buildPlaybackConfig(config);
    const profile = profileStore.get(playbackConfig.profileId);
    if (!profile) {
      return { success: false, error: 'Profile not found' };
    }
    lastProfileId = profile.id;
    lastPlaybackProfile = profile;
    lastPlaybackTarget = playbackConfig.target;
    pendingTakeoverProfile = null;
    pendingTakeoverStartMs = null;
    lastPlaybackLeadInMs = 0;
    const preferences = settingsStore.getPreferences();
    if (preferences.useModAdapter) {
      try {
        return await startModPlayback(profile);
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
    if (!result.success) {
      broadcastStatus(
        IPC_CHANNELS.PLAYBACK_STATUS,
        { ...playbackEngine.getStatus(), state: 'idle', lastError: result.error ?? 'playback_start_failed' }
      );
    }
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.PLAYBACK_STOP, async () => {
    if (playbackViaMod && activeModBaseUrl) {
      return stopModPlayback();
    }
    disarmAutoTakeoverHook();
    lastPlaybackLeadInMs = 0;
    return playbackEngine.stop();
  });

  ipcMain.handle(IPC_CHANNELS.PLAYBACK_SELECT, async (_, payload: { profileId?: string | null }) => {
    const profileId = payload?.profileId ?? null;
    if (!profileId) {
      return { success: false, error: 'Profile id missing' };
    }
    const profile = profileStore.get(profileId);
    if (!profile) {
      return { success: false, error: 'Profile not found' };
    }
    lastProfileId = profile.id;
    lastPlaybackProfile = profile;
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.PLAYBACK_TAKEOVER, async () => {
    return triggerTakeover();
  });

  ipcMain.handle(IPC_CHANNELS.PROFILE_LIST, async () => profileStore.list());
  ipcMain.handle(IPC_CHANNELS.PROFILE_GET, async (_, id: string) => profileStore.get(id));

  ipcMain.handle(IPC_CHANNELS.PROFILE_SAVE, async (_, profile: Profile) => {
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

  ipcMain.handle(
    IPC_CHANNELS.PROFILE_SAVE_DRAFT,
    async (
      _,
      payload: { name: string; notes: string; tags: string[]; autoTune?: Profile['auto_tune'] }
    ) => {
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
      const saved = profileStore.save(draftProfile, subscription);
      profileStore.discardDraft();
      lastDraftProfile = null;
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

  ipcMain.handle(IPC_CHANNELS.PROFILE_DISCARD_DRAFT, async () => {
    profileStore.discardDraft();
    lastDraftProfile = null;
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.PROFILE_DELETE, async (_, id: string) => {
    profileStore.delete(id);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.PROFILE_EXPORT, async (_, profileIds?: string[]) => {
    if (!mainWindow) return { success: false, error: 'Window missing' };
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Profiles',
      defaultPath: profileStore.suggestExportPath(app.getPath('documents'), 'clicksmith-profiles.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { success: false };
    return { success: true, data: profileStore.exportProfiles(result.filePath, profileIds) };
  });

  ipcMain.handle(IPC_CHANNELS.PROFILE_IMPORT, async () => {
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

  ipcMain.handle(IPC_CHANNELS.WINDOW_LIST, async () => windowManager.listWindows());

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async () => ({
    preferences: settingsStore.getPreferences(),
    subscription: settingsStore.getSubscription(),
    eulaAccepted: settingsStore.hasAcceptedEula(),
  }));

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, async (_, preferences: Partial<UserPreferences>) => {
    const updated = settingsStore.setPreferences(preferences);
    registerGlobalHotkeys(updated.hotkeys);
    return updated;
  });

  ipcMain.handle(IPC_CHANNELS.SUBSCRIPTION_SET, async (_, subscription) => {
    return settingsStore.setSubscription(subscription);
  });

  ipcMain.handle(IPC_CHANNELS.SUBSCRIPTION_GET, async () => settingsStore.getSubscription());

  ipcMain.handle(IPC_CHANNELS.EULA_ACCEPT, async (_, accepted: boolean) => {
    settingsStore.setEulaAccepted(accepted);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.BILLING_CHECKOUT, async (_, payload: { priceId: string }) => {
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

  ipcMain.handle(IPC_CHANNELS.MODS_LIST, async () => modManager.listAdapters());

  ipcMain.handle(IPC_CHANNELS.MODS_PROBE, async (_, payload: { id: string }) => {
    const status = await modManager.probeAdapter(payload.id);
    if (!status) {
      return { success: false, error: 'Adapter not found' };
    }
    return { success: true, status };
  });

  ipcMain.handle(IPC_CHANNELS.MODS_LAUNCH, async (_, payload: { id: string }) => {
    return modManager.launchAdapter(payload.id);
  });

  ipcMain.handle(IPC_CHANNELS.MODS_OPEN_DOC, async (_, payload: { id: string }) => {
    return modManager.openInstallDoc(payload.id);
  });

  ipcMain.handle(IPC_CHANNELS.MODS_OPEN_URL, async (_, payload: { url: string }) => {
    return modManager.openDownloadUrl(payload.url);
  });

  ipcMain.on('overlay:set-interactive', (_, interactive: boolean) => {
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
    if (recordingViaMod || modTakeoverArmed) {
      await stopModRecordingAndDraft().catch(() => null);
      return;
    }

    if (recordingEngine.recording) {
      await stopRecordingAndDraft();
      mainWindow?.webContents.send(IPC_CHANNELS.RECORDING_STATUS, {
        state: recordingEngine.recording ? 'recording' : 'idle',
      });
      return;
    }

    if (preferences.useModAdapter) {
      const result = await startModRecording('screen').catch(() => null);
      if (result?.success) {
        broadcastStatus(IPC_CHANNELS.RECORDING_STATUS, { state: 'recording' });
      }
      return;
    }

    currentRecordingTarget = 'screen';
    await recordingEngine.start(buildRecordingConfig({ target: 'screen' }));
    mainWindow?.webContents.send(IPC_CHANNELS.RECORDING_STATUS, {
      state: recordingEngine.recording ? 'recording' : 'idle',
    });
  });

  globalShortcut.register(hotkeys.togglePlayback, async () => {
    const preferences = settingsStore.getPreferences();
    if (playbackViaMod && activeModBaseUrl) {
      await stopModPlayback().catch(() => null);
      return;
    }
    if (playbackEngine.playing) {
      disarmAutoTakeoverHook();
      lastPlaybackLeadInMs = 0;
      await playbackEngine.stop();
      return;
    }
    const draftProfile = lastDraftProfile ?? buildDraftPlaybackProfile();
    if (draftProfile) {
      lastPlaybackProfile = draftProfile;
      lastPlaybackTarget = draftProfile.target_app;
      if (preferences.useModAdapter) {
        await startModPlayback(draftProfile).catch(() => null);
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
    if (preferences.useModAdapter) {
      await startModPlayback(profile).catch(() => null);
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
    if (preferences.useModAdapter) {
      await startModPlayback(profile).catch(() => null);
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

recordingEngine.on('status', status => broadcastStatus(IPC_CHANNELS.RECORDING_STATUS, status));
playbackEngine.on('status', status => broadcastStatus(IPC_CHANNELS.PLAYBACK_STATUS, status));
playbackEngine.on('complete', status => {
  disarmAutoTakeoverHook();
  if (lastPlaybackProfile) {
    const createdAt = new Date().toISOString();
    profileStore.saveDraft({
      target_app: lastPlaybackProfile.target_app,
      events: lastPlaybackProfile.events,
      success_metric: lastPlaybackProfile.success_metric,
      created_at: createdAt,
      version: lastPlaybackProfile.version + 1,
      metadata: {
        created_at: lastPlaybackProfile.created_at,
        updated_at: createdAt,
        version: lastPlaybackProfile.version + 1,
        total_duration_ms: lastPlaybackProfile.metadata?.total_duration_ms ?? 0,
        event_count: lastPlaybackProfile.events.length,
        override_count: lastPlaybackProfile.events.filter(event => event.human_override).length,
        tags: lastPlaybackProfile.metadata?.tags ?? [],
        custom: {
          ...(lastPlaybackProfile.metadata?.custom ?? {}),
          parent_id: lastPlaybackProfile.id,
        },
      },
    });
    broadcastStatus(IPC_CHANNELS.RUN_COMPLETE, {
      source: 'playback',
      draft: profileStore.getDraft(),
      status,
    });
    return;
  }
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
  globalShortcut.unregisterAll();
});
