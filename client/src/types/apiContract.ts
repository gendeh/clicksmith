// Generated contract types from docs/openapi/clicksmith-v1.yaml (v1).
// Keep this file versioned with API changes.

export namespace ApiV1 {
  export interface ApiError {
    error: string;
    code?: string;
    details?: string[];
  }

  export interface SignupRequest {
    email: string;
    password: string;
  }

  export interface LoginRequest {
    email: string;
    password?: string;
  }

  export interface AuthResponse {
    token: string;
    userId: string;
    message?: string;
  }

  export interface Subscription {
    uid: string;
    tier: 'free' | 'pro';
    isActive: boolean;
    stripeSubscriptionId?: string;
    updatedAt: string;
  }

  export interface AuthProfileResponse {
    uid: string;
    email: string;
    subscription: Subscription;
  }

  export interface RecordedEvent {
    t_ms: number;
    type: 'mouse' | 'keyboard';
    btn?: string;
    key?: string;
    keyCode?: number;
    x: number;
    y: number;
    rel_x: number;
    rel_y: number;
    duration_ms: number;
    img_patch_b64?: string;
    img_hash?: string;
    human_override: boolean;
    metadata?: Record<string, unknown>;
  }

  export interface SuccessMetric {
    furthest_frame: number;
    score: number;
  }

  export interface ProfileMetadata {
    created_at: string;
    updated_at: string;
    version: number;
    total_duration_ms: number;
    event_count: number;
    override_count: number;
    tags: string[];
    custom?: Record<string, unknown>;
  }

  export interface Profile {
    id: string;
    name: string;
    target_app: string;
    created_at: string;
    events: RecordedEvent[];
    success_metric: SuccessMetric;
    version: number;
    notes: string;
    metadata?: ProfileMetadata;
    ownerId?: string;
  }

  export type ProfileCreateRequest = Profile;

  export interface ProfileUpdateRequest {
    name?: string;
    target_app?: string;
    events?: RecordedEvent[];
    success_metric?: SuccessMetric;
    version?: number;
    notes?: string;
    metadata?: ProfileMetadata;
  }

  export interface CheckoutRequest {
    priceId: string;
    customerEmail?: string;
  }

  export interface CheckoutResponse {
    url: string;
  }
}

