import { Profile } from '../types';
import { ValidationResult } from '../middleware/validate';

type StringMap = Record<string, unknown>;

type SignupBody = { email: string; password: string };
type LoginBody = { email: string; password?: string };
type CheckoutBody = { priceId: string; customerEmail?: string };

function isObject(value: unknown): value is StringMap {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function success<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

function failure<T>(...errors: string[]): ValidationResult<T> {
  return { ok: false, errors };
}

export function validateSignupBody(value: unknown): ValidationResult<SignupBody> {
  if (!isObject(value)) return failure('Body must be an object');
  if (!isNonEmptyString(value.email)) return failure('email is required');
  if (!isNonEmptyString(value.password)) return failure('password is required');
  return success({ email: value.email, password: value.password });
}

export function validateLoginBody(value: unknown): ValidationResult<LoginBody> {
  if (!isObject(value)) return failure('Body must be an object');
  if (!isNonEmptyString(value.email)) return failure('email is required');
  if (value.password !== undefined && typeof value.password !== 'string') {
    return failure('password must be a string when provided');
  }
  return success({ email: value.email, password: value.password as string | undefined });
}

export function validateCheckoutBody(value: unknown): ValidationResult<CheckoutBody> {
  if (!isObject(value)) return failure('Body must be an object');
  if (!isNonEmptyString(value.priceId)) return failure('priceId is required');
  if (value.customerEmail !== undefined && typeof value.customerEmail !== 'string') {
    return failure('customerEmail must be a string when provided');
  }
  return success({
    priceId: value.priceId,
    customerEmail: value.customerEmail as string | undefined,
  });
}

function validateSuccessMetric(value: unknown): value is Profile['success_metric'] {
  return (
    isObject(value) &&
    typeof value.furthest_frame === 'number' &&
    Number.isFinite(value.furthest_frame) &&
    typeof value.score === 'number' &&
    Number.isFinite(value.score)
  );
}

function validateEvents(value: unknown): value is Profile['events'] {
  if (!Array.isArray(value)) return false;
  return value.every(event => {
    if (!isObject(event)) return false;
    if (typeof event.t_ms !== 'number') return false;
    if (event.type !== 'mouse' && event.type !== 'keyboard') return false;
    if (typeof event.x !== 'number' || typeof event.y !== 'number') return false;
    if (typeof event.rel_x !== 'number' || typeof event.rel_y !== 'number') return false;
    if (typeof event.duration_ms !== 'number') return false;
    if (typeof event.human_override !== 'boolean') return false;
    return true;
  });
}

export function validateProfileCreateBody(value: unknown): ValidationResult<Omit<Profile, 'ownerId'>> {
  if (!isObject(value)) return failure('Body must be an object');
  if (!isNonEmptyString(value.name)) return failure('name is required');
  if (!isNonEmptyString(value.target_app)) return failure('target_app is required');
  if (!isNonEmptyString(value.created_at)) return failure('created_at is required');
  if (!validateEvents(value.events)) return failure('events must be a valid event array');
  if (!validateSuccessMetric(value.success_metric)) return failure('success_metric is invalid');
  if (typeof value.version !== 'number') return failure('version is required');
  if (typeof value.notes !== 'string') return failure('notes is required');

  return success({
    id: isNonEmptyString(value.id) ? value.id : '',
    name: value.name,
    target_app: value.target_app,
    created_at: value.created_at,
    events: value.events,
    success_metric: value.success_metric,
    version: value.version,
    notes: value.notes,
    metadata: isObject(value.metadata) ? (value.metadata as unknown as Profile['metadata']) : undefined,
  });
}

export function validateProfileUpdateBody(value: unknown): ValidationResult<Partial<Profile>> {
  if (!isObject(value)) return failure('Body must be an object');
  const next: Partial<Profile> = {};

  if (value.name !== undefined) {
    if (!isNonEmptyString(value.name)) return failure('name must be a non-empty string');
    next.name = value.name;
  }
  if (value.target_app !== undefined) {
    if (!isNonEmptyString(value.target_app)) return failure('target_app must be a non-empty string');
    next.target_app = value.target_app;
  }
  if (value.events !== undefined) {
    if (!validateEvents(value.events)) return failure('events must be a valid event array');
    next.events = value.events;
  }
  if (value.success_metric !== undefined) {
    if (!validateSuccessMetric(value.success_metric)) return failure('success_metric is invalid');
    next.success_metric = value.success_metric;
  }
  if (value.version !== undefined) {
    if (typeof value.version !== 'number') return failure('version must be numeric');
    next.version = value.version;
  }
  if (value.notes !== undefined) {
    if (typeof value.notes !== 'string') return failure('notes must be a string');
    next.notes = value.notes;
  }
  if (value.metadata !== undefined) {
    if (!isObject(value.metadata)) return failure('metadata must be an object');
    next.metadata = value.metadata as unknown as Profile['metadata'];
  }

  return success(next);
}
