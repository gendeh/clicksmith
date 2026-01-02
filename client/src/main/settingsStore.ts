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
  },
  hotkeys: DEFAULT_HOTKEYS,
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
    return this.store.get('preferences', DEFAULT_PREFERENCES) as UserPreferences;
  }

  public setPreferences(preferences: Partial<UserPreferences>): UserPreferences {
    const merged = { ...this.getPreferences(), ...preferences };
    this.store.set('preferences', merged);
    return merged;
  }

  public getSubscription(): SubscriptionStatus {
    return this.store.get('subscription', DEFAULT_SUBSCRIPTION) as SubscriptionStatus;
  }

  public setSubscription(subscription: SubscriptionStatus): SubscriptionStatus {
    this.store.set('subscription', subscription);
    return subscription;
  }

  public hasAcceptedEula(): boolean {
    return this.store.get('eulaAccepted', false) as boolean;
  }

  public setEulaAccepted(accepted: boolean) {
    this.store.set('eulaAccepted', accepted);
  }
}
