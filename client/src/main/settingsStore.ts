import Store from 'electron-store';
import { DEFAULT_HOTKEYS, SubscriptionStatus, TIER_LIMITS, UserPreferences } from '../types';

const DEFAULT_PREFERENCES: UserPreferences = {
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
  hotkeys: DEFAULT_HOTKEYS,
  useModAdapter: false,
  autoTakeoverOnInput: true,
  showEulaReminder: true,
  telemetryOptIn: false,
  cloudSyncOptIn: false,
};

const DEFAULT_SUBSCRIPTION: SubscriptionStatus = {
  tier: 'free',
  isActive: true,
  features: TIER_LIMITS.free,
};

export class SettingsStore {
  private store: Store;

  constructor() {
    this.store = new Store({ name: 'clicksmith-settings' });
  }

  public getPreferences(): UserPreferences {
    const stored = this.store.get('preferences', DEFAULT_PREFERENCES) as UserPreferences;
    return {
      ...DEFAULT_PREFERENCES,
      ...stored,
      defaultRecordingConfig: {
        ...DEFAULT_PREFERENCES.defaultRecordingConfig,
        ...(stored?.defaultRecordingConfig ?? {}),
      },
      defaultPlaybackConfig: {
        ...DEFAULT_PREFERENCES.defaultPlaybackConfig,
        ...(stored?.defaultPlaybackConfig ?? {}),
      },
      hotkeys: {
        ...DEFAULT_PREFERENCES.hotkeys,
        ...(stored?.hotkeys ?? {}),
      },
    };
  }

  public setPreferences(preferences: Partial<UserPreferences>): UserPreferences {
    const merged = { ...this.getPreferences(), ...preferences };
    this.store.set('preferences', merged);
    return merged;
  }

  public getSubscription(): SubscriptionStatus {
    const stored = this.store.get('subscription', DEFAULT_SUBSCRIPTION) as SubscriptionStatus;
    return {
      ...stored,
      features: stored.features ?? TIER_LIMITS[stored.tier],
    };
  }

  public setSubscription(subscription: SubscriptionStatus): SubscriptionStatus {
    const normalized = {
      ...subscription,
      features: subscription.features ?? TIER_LIMITS[subscription.tier],
    };
    this.store.set('subscription', normalized);
    return normalized;
  }

  public hasAcceptedEula(): boolean {
    return this.store.get('eulaAccepted', false) as boolean;
  }

  public setEulaAccepted(accepted: boolean) {
    this.store.set('eulaAccepted', accepted);
  }
}
