import { app, BrowserWindow, dialog, ipcMain, globalShortcut, screen, shell } from 'electron';
import * as path from 'path';
import {
  DEFAULT_HOTKEYS,
  IPC_CHANNELS,
  PlaybackConfig,
  Profile,
  RecordingConfig,
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

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
const isDev = process.env.NODE_ENV === 'development';

const settingsStore = new SettingsStore();
const profileStore = new ProfileStore();
const windowManager = new WindowManager();
const recordingEngine = new RecordingEngine({ windowManager });
const playbackEngine = new PlaybackEngine({ windowManager });

let lastProfileId: string | null = null;
let currentRecordingTarget: string | null = null;

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

  overlayWindow = new BrowserWindow({
    width: 360,
    height: 140,
    x: width - 380,
    y: 96,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    focusable: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    title: 'Clicksmith Overlay',
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

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
  };
}

function buildSuccessMetric(): SuccessMetric {
  return { furthest_frame: 0, score: 0 };
}

function setupIpcHandlers() {
  ipcMain.handle(IPC_CHANNELS.RECORDING_START, async (_, config: RecordingConfig) => {
    const normalized = buildRecordingConfig(config);
    currentRecordingTarget = normalized.target;
    const result = await recordingEngine.start(normalized);
    if (result.success) {
      broadcastStatus(IPC_CHANNELS.RECORDING_STATUS, { state: 'recording' });
    }
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.RECORDING_STOP, async () => {
    const result = await recordingEngine.stop();
    if (result.success && result.profile) {
      const createdAt = new Date().toISOString();
      profileStore.saveDraft({
        target_app: currentRecordingTarget ?? 'screen',
        events: result.profile.events,
        success_metric: buildSuccessMetric(),
        created_at: createdAt,
        metadata: {
          created_at: createdAt,
          updated_at: createdAt,
          version: 1,
          total_duration_ms: result.profile.duration,
          event_count: result.profile.events.length,
          override_count: result.profile.events.filter((event: Profile['events'][0]) => event.human_override)
            .length,
          tags: [],
        },
      });
      currentRecordingTarget = null;
      broadcastStatus(IPC_CHANNELS.RUN_COMPLETE, {
        source: 'recording',
        draft: profileStore.getDraft(),
      });
    }
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.PLAYBACK_START, async (_, config: PlaybackConfig) => {
    const playbackConfig = buildPlaybackConfig(config);
    const profile = profileStore.get(playbackConfig.profileId);
    if (!profile) {
      return { success: false, error: 'Profile not found' };
    }
    lastProfileId = profile.id;
    return playbackEngine.start(playbackConfig, profile);
  });

  ipcMain.handle(IPC_CHANNELS.PLAYBACK_STOP, async () => playbackEngine.stop());

  ipcMain.handle(IPC_CHANNELS.PLAYBACK_TAKEOVER, async () => {
    recordingEngine.setTakeoverActive(true);
    recordingEngine.recordTakeoverMarker();
    return playbackEngine.takeover();
  });

  ipcMain.handle(IPC_CHANNELS.PROFILE_LIST, async () => profileStore.list());
  ipcMain.handle(IPC_CHANNELS.PROFILE_GET, async (_, id: string) => profileStore.get(id));

  ipcMain.handle(IPC_CHANNELS.PROFILE_SAVE, async (_, profile: Profile) => {
    const subscription = settingsStore.getSubscription();
    const saved = profileStore.save(profile, subscription);
    lastProfileId = saved.id;
    broadcastStatus('profile:saved', saved);
    const preferences = settingsStore.getPreferences();
    if (subscription.features.cloudSync && preferences.cloudSyncOptIn) {
      void syncProfileToCloud(saved);
    }
    return saved;
  });

  ipcMain.handle(
    IPC_CHANNELS.PROFILE_SAVE_DRAFT,
    async (
      _,
      payload: { name: string; notes: string; tags: string[]; autoTune?: Profile['auto_tune'] }
    ) => {
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
    lastProfileId = saved.id;
    broadcastStatus('profile:saved', saved);
    const preferences = settingsStore.getPreferences();
    if (subscription.features.cloudSync && preferences.cloudSyncOptIn) {
      void syncProfileToCloud(saved);
    }
    return saved;
  }
  );

  ipcMain.handle(IPC_CHANNELS.PROFILE_DISCARD_DRAFT, async () => {
    profileStore.discardDraft();
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
    const endpoint = process.env.CLICKSMITH_API_URL || 'http://localhost:3000';
    const response = await fetch(`${endpoint}/api/v1/billing/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (data?.url) {
      await shell.openExternal(data.url);
      return { success: true };
    }
    return { success: false, error: 'Checkout unavailable' };
  });

  ipcMain.on(IPC_CHANNELS.OVERLAY_SHOW, () => overlayWindow?.show());
  ipcMain.on(IPC_CHANNELS.OVERLAY_HIDE, () => overlayWindow?.hide());
  ipcMain.on(IPC_CHANNELS.APP_MINIMIZE, () => mainWindow?.minimize());
  ipcMain.on(IPC_CHANNELS.APP_QUIT, () => app.quit());
}

function registerGlobalHotkeys(hotkeys = DEFAULT_HOTKEYS) {
  globalShortcut.unregisterAll();

  globalShortcut.register(hotkeys.toggleRecording, async () => {
    if (recordingEngine.recording) {
      await recordingEngine.stop();
    } else {
      await recordingEngine.start(buildRecordingConfig({ target: 'screen' }));
    }
    mainWindow?.webContents.send(IPC_CHANNELS.RECORDING_STATUS, {
      state: recordingEngine.recording ? 'recording' : 'idle',
    });
  });

  globalShortcut.register(hotkeys.togglePlayback, async () => {
    if (playbackEngine.playing) {
      await playbackEngine.stop();
      return;
    }
    if (!lastProfileId) return;
    const profile = profileStore.get(lastProfileId);
    if (!profile) return;
    await playbackEngine.start(
      buildPlaybackConfig({ profileId: lastProfileId, target: 'screen' }),
      profile
    );
  });

  globalShortcut.register(hotkeys.takeover, () => {
    recordingEngine.setTakeoverActive(true);
    recordingEngine.recordTakeoverMarker();
    playbackEngine.takeover();
    mainWindow?.webContents.send(IPC_CHANNELS.PLAYBACK_TAKEOVER);
  });

  globalShortcut.register(hotkeys.saveProfile, () => {
    mainWindow?.webContents.send(IPC_CHANNELS.PROFILE_SAVE_REQUEST);
  });

  globalShortcut.register(hotkeys.discardChanges, () => {
    mainWindow?.webContents.send(IPC_CHANNELS.PROFILE_DISCARD_DRAFT);
  });

  globalShortcut.register(hotkeys.quickReplay, async () => {
    if (!lastProfileId) return;
    const profile = profileStore.get(lastProfileId);
    if (!profile) return;
    await playbackEngine.start(buildPlaybackConfig({ profileId: lastProfileId, target: 'screen' }), profile);
  });
}

recordingEngine.on('status', status => broadcastStatus(IPC_CHANNELS.RECORDING_STATUS, status));
playbackEngine.on('status', status => broadcastStatus(IPC_CHANNELS.PLAYBACK_STATUS, status));
playbackEngine.on('complete', status => broadcastStatus(IPC_CHANNELS.RUN_COMPLETE, { source: 'playback', status }));

app.whenReady().then(() => {
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
