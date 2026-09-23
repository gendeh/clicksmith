import { UserPreferences } from '../types';

export function desktopAutomationPreferences(current: UserPreferences): UserPreferences {
  return {
    ...current,
    useModAdapter: false,
    defaultRecordingConfig: {
      ...current.defaultRecordingConfig,
      captureImages: true,
      imagePatchSize: 128,
      recordKeyboard: true,
      recordMouse: true,
    },
    defaultPlaybackConfig: {
      ...current.defaultPlaybackConfig,
      useImageMatching: true,
      imageMatchThreshold: 0.6,
      retryCount: 2,
      useRelativeCoords: true,
      imageSearchRadius: 320,
      snapToHz: 0,
    },
  };
}
