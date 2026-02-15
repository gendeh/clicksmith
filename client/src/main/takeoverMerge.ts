import { Profile, RecordedEvent } from '../types';

export function mergeTakeoverEvents(
  baseProfile: Profile,
  takeoverStartMs: number,
  takeoverEvents: RecordedEvent[]
): RecordedEvent[] {
  const clampedBase = baseProfile.events
    .filter(event => event.t_ms <= takeoverStartMs)
    .map(event => {
      const duration = Math.max(0, event.duration_ms ?? 0);
      if (duration <= 0) return event;
      const end = event.t_ms + duration;
      if (end <= takeoverStartMs) return event;
      return {
        ...event,
        duration_ms: Math.max(0, takeoverStartMs - event.t_ms),
      };
    });

  const takeoverSegment = takeoverEvents.map(event => ({
    ...event,
    t_ms: event.t_ms + takeoverStartMs,
    human_override: true,
    metadata: {
      ...(event.metadata ?? {}),
      takeover_segment: true,
    },
  }));

  return [...clampedBase, ...takeoverSegment].sort((a, b) => a.t_ms - b.t_ms);
}
