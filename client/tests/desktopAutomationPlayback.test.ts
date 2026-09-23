const backingStore = new Map<string, unknown>();

jest.mock('electron-store', () => {
  return jest.fn().mockImplementation(() => ({
    get: (key: string, defaultValue?: unknown) => (backingStore.has(key) ? backingStore.get(key) : defaultValue),
    set: (key: string, value: unknown) => {
      backingStore.set(key, value);
    },
  }));
});

import { SettingsStore } from '../src/main/settingsStore';
import { desktopAutomationPreferences } from '../src/services/desktopAutomation';
import { playbackConfigFromPreferences, recordingConfigFromPreferences } from '../src/services/sessionConfig';

describe('desktop automation reaches the next record and play', () => {
  beforeEach(() => {
    backingStore.clear();
  });

  test('a Notes playback uses the stored radius and leaves 240Hz snap off', () => {
    const store = new SettingsStore();
    store.setPreferences({
      useModAdapter: true,
      defaultRecordingConfig: {
        captureImages: false,
        imagePatchSize: 32,
      },
      defaultPlaybackConfig: {
        useImageMatching: false,
        imageMatchThreshold: 0.9,
        retryCount: 0,
        useRelativeCoords: false,
        imageSearchRadius: 160,
        snapToHz: 240,
        snapMode: 'duration-lock',
      },
    });

    const before = store.getPreferences();
    expect(before.defaultPlaybackConfig.imageSearchRadius).toBe(160);
    expect(before.defaultPlaybackConfig.snapToHz).toBe(240);
    expect(before.useModAdapter).toBe(true);

    store.setPreferences(desktopAutomationPreferences(before));
    const after = store.getPreferences();

    expect(after.defaultPlaybackConfig.imageSearchRadius).toBe(320);
    expect(after.defaultPlaybackConfig.snapToHz).toBe(0);
    expect(after.defaultPlaybackConfig.useImageMatching).toBe(true);
    expect(after.defaultPlaybackConfig.imageMatchThreshold).toBe(0.6);
    expect(after.useModAdapter).toBe(false);
    expect(after.defaultRecordingConfig.captureImages).toBe(true);
    expect(after.defaultRecordingConfig.imagePatchSize).toBe(128);
    expect(after.defaultPlaybackConfig.snapMode).toBe('duration-lock');

    const playback = playbackConfigFromPreferences({ profileId: 'notes-run', target: 'Notes' }, after);
    expect(playback.target).toBe('Notes');
    expect(playback.profileId).toBe('notes-run');
    expect(playback.imageSearchRadius).toBe(320);
    expect(playback.snapToHz).toBe(0);
    expect(playback.useImageMatching).toBe(true);
    expect(playback.imageMatchThreshold).toBe(0.6);
    expect(playback.retryCount).toBe(2);
    expect(playback.useRelativeCoords).toBe(true);

    const recording = recordingConfigFromPreferences({ target: 'Notes' }, after);
    expect(recording.target).toBe('Notes');
    expect(recording.captureImages).toBe(true);
    expect(recording.imagePatchSize).toBe(128);

    const storedDefaults = playbackConfigFromPreferences({ profileId: 'notes-run', target: 'Notes' }, before);
    expect(storedDefaults.imageSearchRadius).toBe(160);
    expect(storedDefaults.snapToHz).toBe(240);

    const explicitPayload = playbackConfigFromPreferences(
      { profileId: 'notes-run', target: 'Notes', imageSearchRadius: 160, snapToHz: 240 },
      after
    );
    expect(explicitPayload.imageSearchRadius).toBe(160);
    expect(explicitPayload.snapToHz).toBe(240);
  });
});
