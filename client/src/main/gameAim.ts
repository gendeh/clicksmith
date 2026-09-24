import { RecordedEvent } from '../types';

export const AIM_JOIN_SLACK_MS = 30;

export type WindowSize = { width: number; height: number };

export function readAnchorWindow(event: RecordedEvent): WindowSize | null {
  const raw = event.metadata?.anchor_window as { width?: number; height?: number } | undefined;
  if (!raw) return null;
  if (typeof raw.width !== 'number' || typeof raw.height !== 'number') return null;
  if (raw.width <= 0 || raw.height <= 0) return null;
  return { width: raw.width, height: raw.height };
}

export function windowScale(recorded: WindowSize, current: WindowSize): { sx: number; sy: number } {
  return {
    sx: current.width / recorded.width,
    sy: current.height / recorded.height,
  };
}

export function holdEnd(event: RecordedEvent): number {
  const release = event.metadata?.release_t_ms;
  if (typeof release === 'number' && Number.isFinite(release)) return Math.max(event.t_ms, release);
  return event.t_ms + Math.max(0, event.duration_ms || 0);
}

export function isGamePress(event: RecordedEvent): boolean {
  if (event.metadata?.takeover_marker) return false;
  if (event.type === 'keyboard') return event.metadata?.action !== 'up';
  if (event.type === 'gamepad') {
    if (event.metadata?.axis === true || event.metadata?.action === 'axis') return false;
    return event.metadata?.action !== 'up';
  }
  return false;
}

export function isPointerPlace(event: RecordedEvent): boolean {
  if (event.type !== 'mouse' || event.metadata?.takeover_marker) return false;
  return event.metadata?.action !== 'up';
}

function samePlace(a: RecordedEvent, b: RecordedEvent): boolean {
  return Math.hypot(a.rel_x - b.rel_x, a.rel_y - b.rel_y) <= 0.08;
}

export function joinGamePresses(events: RecordedEvent[]): Map<RecordedEvent, RecordedEvent[]> {
  const joined = new Map<RecordedEvent, RecordedEvent[]>();
  const used = new Set<RecordedEvent>();
  for (const place of events) {
    if (!isPointerPlace(place)) continue;
    const start = place.t_ms;
    const end = holdEnd(place);
    const presses = events.filter(press => {
      if (!isGamePress(press) || used.has(press)) return false;
      if (!samePlace(press, place)) return false;
      return press.t_ms >= start - AIM_JOIN_SLACK_MS && press.t_ms <= end;
    });
    if (presses.length === 0) continue;
    presses.forEach(press => used.add(press));
    joined.set(place, presses);
  }
  return joined;
}

export function consumedPresses(joined: Map<RecordedEvent, RecordedEvent[]>): Set<RecordedEvent> {
  const used = new Set<RecordedEvent>();
  for (const presses of joined.values()) {
    presses.forEach(press => used.add(press));
  }
  return used;
}
