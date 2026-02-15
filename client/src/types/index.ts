/**
 * Clicksmith Type Definitions
 * Core data structures for the input automation application
 */

// ============================================================================
// Profile Types
// ============================================================================

/**
 * Input event types supported by Clicksmith
 */
export type InputEventType = 'mouse' | 'keyboard';

/**
 * Mouse button types
 */
export type MouseButton = 'left' | 'right' | 'middle';

/**
 * Keyboard modifier keys
 */
export type ModifierKey = 'ctrl' | 'alt' | 'shift' | 'meta';

/**
 * Single recorded input event with full context
 */
export interface RecordedEvent {
  /** Timestamp in milliseconds from recording start */
  t_ms: number;
  /** Event type: mouse or keyboard */
  type: InputEventType;
  /** Mouse button (for mouse events) */
  btn?: MouseButton;
  /** Keyboard key (for keyboard events) */
  key?: string;
  /** Key code (for keyboard events) */
  keyCode?: number;
  /** Absolute X coordinate on screen */
  x: number;
  /** Absolute Y coordinate on screen */
  y: number;
  /** Relative X coordinate (0-1) within target window */
  rel_x: number;
  /** Relative Y coordinate (0-1) within target window */
  rel_y: number;
  /** Click/key press duration in ms */
  duration_ms: number;
  /** Base64 encoded image patch (128x128) around cursor */
  img_patch_b64?: string;
  /** Content-addressed image patch reference (sha256) */
  img_patch_ref?: string;
  /** SHA256 hash of image patch for quick comparison */
  img_hash?: string;
  /** Whether this event was a human override/takeover */
  human_override: boolean;
  /** Active modifier keys during event */
  modifiers?: ModifierKey[];
  /** Event-specific metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Success metrics for a profile run
 */
export interface SuccessMetric {
  /** Furthest frame/checkpoint reached */
  furthest_frame: number;
  /** Numeric score (application-specific) */
  score: number;
  /** Custom metrics */
  custom?: Record<string, number | number[] | string>;
}

/**
 * Profile metadata for versioning and organization
 */
export interface ProfileMetadata {
  /** Creation timestamp */
  created_at: string;
  /** Last modified timestamp */
  updated_at: string;
  /** Profile version number */
  version: number;
  /** Total duration of recording in ms */
  total_duration_ms: number;
  /** Number of events */
  event_count: number;
  /** Number of human overrides */
  override_count: number;
  /** Tags for organization */
  tags: string[];
  /** Custom metadata payload */
  custom?: Record<string, number | number[] | string>;
}

/**
 * Complete profile structure
 */
export interface Profile {
  /** Unique profile identifier */
  id: string;
  /** User-friendly profile name */
  name: string;
  /** Target application window title or executable name */
  target_app: string;
  /** Creation timestamp (ISO8601) */
  created_at: string;
  /** Target window class (for more precise matching) */
  target_class?: string;
  /** Recorded events */
  events: RecordedEvent[];
  /** Success metrics from last run */
  success_metric: SuccessMetric;
  /** Profile version number */
  version: number;
  /** Profile metadata */
  metadata?: ProfileMetadata;
  /** User notes */
  notes: string;
  /** Auto-tune settings (if enabled) */
  auto_tune?: AutoTuneSettings;
}

/**
 * Profile export format for sharing
 */
export interface ProfileExport {
  /** Export format version */
  format_version: string;
  /** Exported profiles */
  profiles: Profile[];
  /** Export timestamp */
  exported_at: string;
  /** Exporting application version */
  app_version: string;
}

// ============================================================================
// Recording & Playback Types
// ============================================================================

/**
 * Recording session state
 */
export type RecordingState = 'idle' | 'recording' | 'paused' | 'stopping';

/**
 * Playback session state
 */
export type PlaybackState = 'idle' | 'playing' | 'paused' | 'takeover' | 'stopping';

/**
 * Recording session configuration
 */
export interface RecordingConfig {
  /** Target window handle or title */
  target: string;
  /** Capture image patches */
  captureImages: boolean;
  /** Image patch size (default 128) */
  imagePatchSize: number;
  /** Minimum event interval in ms to record */
  minEventInterval: number;
  /** Record keyboard events */
  recordKeyboard: boolean;
  /** Record mouse events */
  recordMouse: boolean;
  /** Hotkey to stop recording */
  stopHotkey: string;
  /** Hotkey for takeover */
  takeoverHotkey: string;
}

/**
 * Playback session configuration
 */
export interface PlaybackConfig {
  /** Profile to play */
  profileId: string;
  /** Target window handle or title */
  target: string;
  /** Use image matching for click verification */
  useImageMatching: boolean;
  /** Image match confidence threshold (0-1) */
  imageMatchThreshold: number;
  /** Timing jitter tolerance in ms */
  timingTolerance: number;
  /** Retry count for failed clicks */
  retryCount: number;
  /** Delay between retries in ms */
  retryDelay: number;
  /** SmartClick search radius in px */
  imageSearchRadius?: number;
  /** Hotkey for takeover */
  takeoverHotkey: string;
  /** Speed multiplier (1.0 = normal) */
  speedMultiplier: number;
  /** Use relative coordinates when possible */
  useRelativeCoords: boolean;
  /** Snap playback timing to a fixed Hz (0 disables snapping) */
  snapToHz?: number;
  /** Timing snap strategy */
  snapMode?: 'nearest' | 'floor' | 'duration-lock';
  /** Phase offset for snapped timing (ms) */
  snapPhaseMs?: number;
}

// ============================================================================
// Mod Adapter Types
// ============================================================================

export type ModProtocolType = 'local-http';

export type ModSnapMode = 'nearest' | 'floor' | 'duration-lock';

export interface ModAdapterProtocol {
  type: ModProtocolType;
  statusUrl?: string;
  baseUrl?: string;
}

export interface ModAdapterLaunch {
  type: 'uri' | 'appPath';
  value: string;
}

export interface ModAdapterInstall {
  instructionsPath?: string;
  downloadUrl?: string;
}

export interface ModAdapterManifest {
  id: string;
  name: string;
  description?: string;
  framework: string;
  game: string;
  platforms?: NodeJS.Platform[];
  install?: ModAdapterInstall;
  detect?: Partial<Record<NodeJS.Platform, string[]>>;
  launch?: ModAdapterLaunch;
  protocol?: ModAdapterProtocol;
}

export interface ModRegistry {
  version: number;
  adapters: ModAdapterManifest[];
}

export interface ModAdapterStatus {
  adapter: ModAdapterManifest;
  installed: boolean;
  detectedPath?: string;
  connection: 'unknown' | 'connected' | 'unreachable';
  lastError?: string;
}

/**
 * Real-time playback status
 */
export interface PlaybackStatus {
  /** Current state */
  state: PlaybackState;
  /** Current event index */
  currentEventIndex: number;
  /** Total events */
  totalEvents: number;
  /** Elapsed time in ms */
  elapsedMs: number;
  /** Number of successful matches */
  successfulMatches: number;
  /** Number of failed matches */
  failedMatches: number;
  /** Number of retries */
  retries: number;
  /** Current timing drift in ms */
  timingDrift: number;
  /** Last error message */
  lastError?: string;
}

// ============================================================================
// Window & Screen Types
// ============================================================================

/**
 * Window information
 */
export interface WindowInfo {
  /** Window handle (HWND on Windows) */
  handle: number;
  /** Window title */
  title: string;
  /** Window class name */
  className: string;
  /** Process ID */
  processId: number;
  /** Executable path */
  executablePath: string;
  /** Window bounds */
  bounds: WindowBounds;
  /** Is window visible */
  isVisible: boolean;
  /** Is window minimized */
  isMinimized: boolean;
  /** Is window focused */
  isFocused: boolean;
}

/**
 * Window bounds rectangle
 */
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Screen/display information
 */
export interface ScreenInfo {
  /** Display ID */
  id: number;
  /** Display bounds */
  bounds: WindowBounds;
  /** Work area (excluding taskbar) */
  workArea: WindowBounds;
  /** Scale factor (DPI) */
  scaleFactor: number;
  /** Is primary display */
  isPrimary: boolean;
}

// ============================================================================
// Image Matching Types
// ============================================================================

/**
 * Image match request
 */
export interface ImageMatchRequest {
  /** Template image (base64) */
  template: string;
  /** Search area image (base64) or full screen if omitted */
  searchArea?: string;
  /** Confidence threshold (0-1) */
  threshold: number;
  /** Match method */
  method: 'template' | 'feature' | 'hybrid';
  /** Return multiple matches */
  findAll: boolean;
  /** Maximum matches to return */
  maxMatches: number;
}

/**
 * Single match result
 */
export interface MatchResult {
  /** X coordinate of match center */
  x: number;
  /** Y coordinate of match center */
  y: number;
  /** Match confidence (0-1) */
  confidence: number;
  /** Match bounds */
  bounds: WindowBounds;
}

/**
 * Image match response
 */
export interface ImageMatchResponse {
  /** Whether any match was found */
  success: boolean;
  /** All matches found */
  matches: MatchResult[];
  /** Best match (highest confidence) */
  bestMatch?: MatchResult;
  /** Processing time in ms */
  processingTimeMs: number;
  /** Error message if failed */
  error?: string;
}

// ============================================================================
// Auto-Tune Types
// ============================================================================

/**
 * Auto-tune settings for evolutionary optimization
 */
export interface AutoTuneSettings {
  /** Is auto-tune enabled */
  enabled: boolean;
  /** Number of generations to run */
  generations: number;
  /** Population size per generation */
  populationSize: number;
  /** Mutation rate (0-1) */
  mutationRate: number;
  /** Maximum timing jitter to apply (ms) */
  maxJitter: number;
  /** Fitness function weights */
  fitnessWeights: {
    successRate: number;
    timing: number;
    smoothness: number;
  };
}

/**
 * Auto-tune generation result
 */
export interface AutoTuneResult {
  /** Generation number */
  generation: number;
  /** Best fitness score */
  bestFitness: number;
  /** Average fitness */
  avgFitness: number;
  /** Best timing adjustments */
  bestAdjustments: number[];
  /** Improvement from previous generation */
  improvement: number;
}

// ============================================================================
// User & Subscription Types
// ============================================================================

/**
 * User subscription tier
 */
export type SubscriptionTier = 'free' | 'pro' | 'enterprise';

/**
 * User subscription status
 */
export interface SubscriptionStatus {
  /** Current tier */
  tier: SubscriptionTier;
  /** Is subscription active */
  isActive: boolean;
  /** Subscription end date */
  expiresAt?: string;
  /** Stripe subscription ID */
  stripeSubscriptionId?: string;
  /** Features available */
  features: SubscriptionFeatures;
}

/**
 * Features by subscription tier
 */
export interface SubscriptionFeatures {
  /** Maximum saved profiles */
  maxProfiles: number;
  /** Cloud sync enabled */
  cloudSync: boolean;
  /** Auto-tune enabled */
  autoTune: boolean;
  /** Priority support */
  prioritySupport: boolean;
  /** Advanced image matching */
  advancedImageMatch: boolean;
  /** Profile sharing */
  profileSharing: boolean;
}

/**
 * User profile
 */
export interface UserProfile {
  /** Firebase user ID */
  uid: string;
  /** Email address */
  email: string;
  /** Display name */
  displayName?: string;
  /** Profile photo URL */
  photoURL?: string;
  /** Subscription status */
  subscription: SubscriptionStatus;
  /** Account creation date */
  createdAt: string;
  /** Last login date */
  lastLoginAt: string;
  /** User preferences */
  preferences: UserPreferences;
}

/**
 * User preferences
 */
export interface UserPreferences {
  /** Theme preference */
  theme: 'light' | 'dark' | 'system';
  /** Default recording config */
  defaultRecordingConfig: Partial<RecordingConfig>;
  /** Default playback config */
  defaultPlaybackConfig: Partial<PlaybackConfig>;
  /** Hotkey bindings */
  hotkeys: HotkeyBindings;
  /** Prefer mod adapter recording/playback when available */
  useModAdapter: boolean;
  /** Auto takeover on user input during playback */
  autoTakeoverOnInput: boolean;
  /** Show EULA reminder */
  showEulaReminder: boolean;
  /** Telemetry opt-in */
  telemetryOptIn: boolean;
  /** Cloud sync opt-in */
  cloudSyncOptIn: boolean;
}

/**
 * Hotkey bindings configuration
 */
export interface HotkeyBindings {
  /** Start/stop recording */
  toggleRecording: string;
  /** Start/stop playback */
  togglePlayback: string;
  /** Takeover control */
  takeover: string;
  /** Save profile */
  saveProfile: string;
  /** Discard changes */
  discardChanges: string;
  /** Open overlay */
  openOverlay: string;
  /** Quick replay last profile */
  quickReplay: string;
}

// ============================================================================
// IPC Communication Types
// ============================================================================

/**
 * IPC channel names
 */
export const IPC_CHANNELS = {
  // Recording
  RECORDING_START: 'recording:start',
  RECORDING_STOP: 'recording:stop',
  RECORDING_PAUSE: 'recording:pause',
  RECORDING_EVENT: 'recording:event',
  RECORDING_STATUS: 'recording:status',
  
  // Playback
  PLAYBACK_START: 'playback:start',
  PLAYBACK_STOP: 'playback:stop',
  PLAYBACK_PAUSE: 'playback:pause',
  PLAYBACK_TAKEOVER: 'playback:takeover',
  PLAYBACK_STATUS: 'playback:status',
  PLAYBACK_SELECT: 'playback:select',
  
  // Profiles
  PROFILE_LIST: 'profile:list',
  PROFILE_GET: 'profile:get',
  PROFILE_SAVE: 'profile:save',
  PROFILE_SAVE_DRAFT: 'profile:save-draft',
  PROFILE_DELETE: 'profile:delete',
  PROFILE_DISCARD_DRAFT: 'profile:discard-draft',
  PROFILE_EXPORT: 'profile:export',
  PROFILE_IMPORT: 'profile:import',
  PROFILE_SAVE_REQUEST: 'profile:save-request',
  
  // Windows
  WINDOW_LIST: 'window:list',
  WINDOW_FOCUS: 'window:focus',
  WINDOW_CAPTURE: 'window:capture',
  
  // Auth
  AUTH_LOGIN: 'auth:login',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_STATUS: 'auth:status',

  // Billing
  BILLING_CHECKOUT: 'billing:checkout',
  
  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SUBSCRIPTION_GET: 'subscription:get',
  SUBSCRIPTION_SET: 'subscription:set',
  EULA_ACCEPT: 'eula:accept',
  RUN_COMPLETE: 'run:complete',
  
  // Overlay
  OVERLAY_SHOW: 'overlay:show',
  OVERLAY_HIDE: 'overlay:hide',
  OVERLAY_TOGGLE: 'overlay:toggle',

  // Mods
  MODS_LIST: 'mods:list',
  MODS_PROBE: 'mods:probe',
  MODS_LAUNCH: 'mods:launch',
  MODS_OPEN_DOC: 'mods:open-doc',
  MODS_OPEN_URL: 'mods:open-url',
  
  // App
  APP_QUIT: 'app:quit',
  APP_MINIMIZE: 'app:minimize',
  APP_VERSION: 'app:version',
} as const;

/**
 * IPC response wrapper
 */
export interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

// ============================================================================
// API Types
// ============================================================================

/**
 * API error response
 */
export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Paginated response
 */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Default feature limits by tier
 */
export const TIER_LIMITS: Record<SubscriptionTier, SubscriptionFeatures> = {
  free: {
    maxProfiles: 3,
    cloudSync: false,
    autoTune: false,
    prioritySupport: false,
    advancedImageMatch: false,
    profileSharing: false,
  },
  pro: {
    maxProfiles: -1, // unlimited
    cloudSync: true,
    autoTune: true,
    prioritySupport: true,
    advancedImageMatch: true,
    profileSharing: true,
  },
  enterprise: {
    maxProfiles: -1,
    cloudSync: true,
    autoTune: true,
    prioritySupport: true,
    advancedImageMatch: true,
    profileSharing: true,
  },
};

/**
 * Default hotkey bindings
 */
export const DEFAULT_HOTKEYS: HotkeyBindings = {
  toggleRecording: 'F9',
  togglePlayback: 'F10',
  takeover: 'F11',
  saveProfile: 'Ctrl+S',
  discardChanges: 'Ctrl+Shift+D',
  openOverlay: 'Ctrl+Shift+O',
  quickReplay: 'F12',
};

/**
 * Application version
 */
export const APP_VERSION = '1.0.0';
