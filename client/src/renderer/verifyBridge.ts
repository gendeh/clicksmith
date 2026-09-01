import {
  IPC_CHANNELS,
  PlaybackStatus,
  Profile,
  TIER_LIMITS,
  UserPreferences,
} from '../types';

type Listener = (event: unknown, ...args: unknown[]) => void;

const SAMPLE_EVENT = {
  t_ms: 120,
  type: 'mouse' as const,
  btn: 'left' as const,
  x: 640,
  y: 420,
  rel_x: 0.5,
  rel_y: 0.5,
  duration_ms: 12,
  human_override: false,
};

function nowIso() {
  return new Date().toISOString();
}

function defaultPreferences(): UserPreferences {
  return {
    theme: 'system',
    defaultRecordingConfig: {
      captureImages: true,
      imagePatchSize: 128,
      minEventInterval: 8,
      recordKeyboard: true,
      recordMouse: true,
    },
    defaultPlaybackConfig: {
      useImageMatching: true,
      imageMatchThreshold: 0.6,
      timingTolerance: 20,
      retryCount: 2,
      retryDelay: 80,
      speedMultiplier: 1,
      useRelativeCoords: true,
      imageSearchRadius: 160,
      snapToHz: 240,
      snapMode: 'duration-lock',
      snapPhaseMs: 0,
    },
    hotkeys: {
      toggleRecording: 'F9',
      togglePlayback: 'F10',
      takeover: 'F11',
      saveProfile: 'Ctrl+S',
      discardChanges: 'Ctrl+Shift+D',
      openOverlay: 'Ctrl+Shift+O',
      quickReplay: 'F12',
    },
    useModAdapter: false,
    autoTakeoverOnInput: true,
    showEulaReminder: true,
    telemetryOptIn: false,
    cloudSyncOptIn: false,
  };
}

export function shouldInstallVerifyBridge(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.clicksmith) return false;
  const params = new URLSearchParams(window.location.search);
  if (params.get('verify') === '0') return false;
  return import.meta.env.VITE_CLICKSMITH_VERIFY === 'true' || params.get('verify') === '1';
}

export function installVerifyBridge() {
  const params = new URLSearchParams(window.location.search);
  const listeners = new Map<string, Set<Listener>>();
  const profiles = new Map<string, Profile>();
  let preferences = defaultPreferences();
  let eulaAccepted = params.get('eula') !== 'required';
  let recordingState: 'idle' | 'armed' | 'recording' | 'paused' = 'idle';
  let playbackStatus: PlaybackStatus = {
    state: 'idle',
    currentEventIndex: 0,
    totalEvents: 0,
    elapsedMs: 0,
    successfulMatches: 0,
    failedMatches: 0,
    retries: 0,
    timingDrift: 0,
  };
  let selectedProfileId: string | null = null;
  let draft: {
    target_app: string;
    events: Profile['events'];
    success_metric: Profile['success_metric'];
    created_at: string;
  } | null = null;
  let nextId = 1;

  function emit(channel: string, payload: unknown) {
    const set = listeners.get(channel);
    if (!set) return;
    for (const listener of set) {
      listener({}, payload);
    }
  }

  function makeProfile(name: string, notes: string, tags: string[]): Profile {
    const created = nowIso();
    const events = draft?.events ?? [{ ...SAMPLE_EVENT }];
    const id = `verify-${nextId++}`;
    return {
      id,
      name,
      target_app: draft?.target_app ?? 'screen',
      created_at: created,
      events,
      success_metric: draft?.success_metric ?? { furthest_frame: 0, score: 0 },
      version: 1,
      notes,
      auto_tune: {
        enabled: false,
        generations: 2,
        populationSize: 6,
        mutationRate: 0.2,
        maxJitter: 18,
        fitnessWeights: { successRate: 1, timing: 1, smoothness: 1 },
      },
      metadata: {
        created_at: created,
        updated_at: created,
        version: 1,
        total_duration_ms: events.reduce((max, event) => Math.max(max, event.t_ms + (event.duration_ms ?? 0)), 0),
        event_count: events.length,
        override_count: 0,
        tags,
        custom: { verify_bridge: '1' },
      },
    };
  }

  const seed = makeProfile('Verify Seed', 'Seeded by the ClickSmith verify bridge.', ['verify']);
  profiles.set(seed.id, seed);
  selectedProfileId = seed.id;

  window.clicksmith = {
    invoke: async (channel: string, payload?: unknown) => {
      switch (channel) {
        case IPC_CHANNELS.PROFILE_LIST:
          return Array.from(profiles.values());
        case IPC_CHANNELS.PROFILE_GET:
          return typeof payload === 'string' ? profiles.get(payload) ?? null : null;
        case IPC_CHANNELS.WINDOW_LIST:
          return [
            {
              handle: 1,
              title: 'Notepad',
              className: 'Notepad',
              processId: 100,
              executablePath: '/usr/bin/notepad',
              bounds: { x: 0, y: 0, width: 800, height: 600 },
              isVisible: true,
              isMinimized: false,
              isFocused: false,
            },
            {
              handle: 2,
              title: 'Geometry Dash',
              className: 'GeometryDash',
              processId: 200,
              executablePath: '/usr/bin/geometrydash',
              bounds: { x: 0, y: 0, width: 1280, height: 720 },
              isVisible: true,
              isMinimized: false,
              isFocused: false,
            },
          ];
        case IPC_CHANNELS.SETTINGS_GET:
          return {
            preferences,
            subscription: { tier: 'pro', isActive: true, features: TIER_LIMITS.pro },
            eulaAccepted,
          };
        case IPC_CHANNELS.SETTINGS_SET: {
          preferences = { ...preferences, ...(payload as Partial<UserPreferences>) };
          return preferences;
        }
        case IPC_CHANNELS.MODS_LIST:
          return [
            {
              adapter: {
                id: 'geode-geometry-dash',
                name: 'Geode',
                install: { instructionsPath: 'docs/mods/geode.md', downloadUrl: '' },
                launch: true,
              },
              connection: 'disconnected',
            },
          ];
        case IPC_CHANNELS.RECORDING_START:
          recordingState = 'recording';
          emit(IPC_CHANNELS.RECORDING_STATUS, { state: 'recording' });
          return { success: true };
        case IPC_CHANNELS.RECORDING_STOP: {
          recordingState = 'idle';
          draft = {
            target_app: 'screen',
            events: [{ ...SAMPLE_EVENT }],
            success_metric: { furthest_frame: 0, score: 0 },
            created_at: nowIso(),
          };
          emit(IPC_CHANNELS.RECORDING_STATUS, { state: 'idle' });
          emit(IPC_CHANNELS.RUN_COMPLETE, { source: 'recording', draft });
          return { success: true, profile: { events: draft.events, duration: 120 } };
        }
        case IPC_CHANNELS.PLAYBACK_START: {
          const body = (payload as { profileId?: string }) ?? {};
          const profile = body.profileId ? profiles.get(body.profileId) : selectedProfileId ? profiles.get(selectedProfileId) : undefined;
          if (!profile) return { success: false, error: 'Profile not found' };
          playbackStatus = {
            ...playbackStatus,
            state: 'playing',
            totalEvents: profile.events.length,
            currentEventIndex: 0,
            lastError: undefined,
          };
          emit(IPC_CHANNELS.PLAYBACK_STATUS, playbackStatus);
          return { success: true };
        }
        case IPC_CHANNELS.PLAYBACK_STOP:
          playbackStatus = { ...playbackStatus, state: 'idle' };
          emit(IPC_CHANNELS.PLAYBACK_STATUS, playbackStatus);
          return { success: true };
        case IPC_CHANNELS.PLAYBACK_TAKEOVER:
          playbackStatus = { ...playbackStatus, state: 'paused' };
          emit(IPC_CHANNELS.PLAYBACK_STATUS, playbackStatus);
          return { success: true };
        case IPC_CHANNELS.PLAYBACK_SELECT: {
          const profileId = (payload as { profileId?: string | null })?.profileId ?? null;
          if (!profileId || !profiles.has(profileId)) return { success: false, error: 'Profile not found' };
          selectedProfileId = profileId;
          return { success: true };
        }
        case IPC_CHANNELS.PROFILE_SAVE_DRAFT: {
          const body = payload as { name: string; notes: string; tags: string[] };
          const saved = makeProfile(body.name, body.notes, body.tags);
          profiles.set(saved.id, saved);
          selectedProfileId = saved.id;
          draft = null;
          emit('profile:saved', saved);
          return saved;
        }
        case IPC_CHANNELS.PROFILE_DISCARD_DRAFT:
          draft = null;
          return { success: true };
        case IPC_CHANNELS.PROFILE_DELETE: {
          if (typeof payload === 'string') profiles.delete(payload);
          return { success: true };
        }
        case IPC_CHANNELS.PROFILE_EXPORT:
          return { success: true, data: Array.from(profiles.values()) };
        case IPC_CHANNELS.PROFILE_IMPORT:
          return { success: false, error: 'verify_import_uses_http_lane' };
        case IPC_CHANNELS.EULA_ACCEPT:
          eulaAccepted = Boolean(payload);
          return { success: true };
        case IPC_CHANNELS.BILLING_CHECKOUT:
          return { success: false, error: 'verify_billing_skipped' };
        case IPC_CHANNELS.MODS_PROBE:
          return { success: true, status: { adapter: { id: 'geode-geometry-dash' }, connection: 'disconnected' } };
        case IPC_CHANNELS.MODS_LAUNCH:
        case IPC_CHANNELS.MODS_OPEN_DOC:
        case IPC_CHANNELS.MODS_OPEN_URL:
          return { success: false, error: 'desktop_only' };
        case IPC_CHANNELS.APP_VERSION:
          return 'verify';
        default:
          return { success: false, error: `unhandled_verify_channel:${channel}` };
      }
    },
    send() {
      return;
    },
    on(channel: string, listener: Listener) {
      const set = listeners.get(channel) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(channel, set);
    },
    once(channel: string, listener: Listener) {
      const wrapped: Listener = (event, ...args) => {
        window.clicksmith.removeListener(channel, wrapped);
        listener(event, ...args);
      };
      window.clicksmith.on(channel, wrapped);
    },
    removeListener(channel: string, listener: Listener) {
      listeners.get(channel)?.delete(listener);
    },
    removeAllListeners(channel: string) {
      listeners.delete(channel);
    },
  };
}
