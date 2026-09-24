import { PlaybackConfig, RecordingConfig, UserPreferences } from '../types';

export function recordingConfigFromPreferences(
  config: Partial<RecordingConfig>,
  preferences: UserPreferences
): RecordingConfig {
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

export function playbackConfigFromPreferences(
  config: Partial<PlaybackConfig>,
  preferences: UserPreferences
): PlaybackConfig {
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
