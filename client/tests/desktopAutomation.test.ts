import { desktopAutomationPreferences } from '../src/services/desktopAutomation';
import { DEFAULT_HOTKEYS, UserPreferences } from '../src/types';

describe('desktopAutomationPreferences', () => {
  test('desktop automation records patches and matches them above 0.6', () => {
    const current: UserPreferences = {
      theme: 'dark',
      defaultRecordingConfig: {
        captureImages: false,
        imagePatchSize: 32,
        recordKeyboard: false,
        recordMouse: false,
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
      hotkeys: { ...DEFAULT_HOTKEYS },
      useModAdapter: true,
      autoTakeoverOnInput: true,
      showEulaReminder: true,
      telemetryOptIn: true,
      cloudSyncOptIn: true,
    };

    const next = desktopAutomationPreferences(current);

    expect(next.defaultRecordingConfig.captureImages).toBe(true);
    expect(next.defaultRecordingConfig.imagePatchSize).toBe(128);
    expect(next.defaultPlaybackConfig.useImageMatching).toBe(true);
    expect(next.defaultPlaybackConfig.imageMatchThreshold).toBe(0.6);
    expect(next.defaultPlaybackConfig.useRelativeCoords).toBe(true);
    expect(next.defaultPlaybackConfig.retryCount).toBeGreaterThan(0);
    expect(next.defaultPlaybackConfig.imageSearchRadius).toBe(320);
    expect(next.defaultPlaybackConfig.snapToHz).toBe(0);
    expect(next.useModAdapter).toBe(false);
    expect(next.hotkeys).toEqual(DEFAULT_HOTKEYS);
    expect(next.theme).toBe('dark');
    expect(next.cloudSyncOptIn).toBe(true);
    expect(next.defaultPlaybackConfig.snapMode).toBe('duration-lock');
    expect(current.useModAdapter).toBe(true);
    expect(current.defaultPlaybackConfig.snapToHz).toBe(240);
    expect(current.defaultPlaybackConfig.imageSearchRadius).toBe(160);
  });
});
