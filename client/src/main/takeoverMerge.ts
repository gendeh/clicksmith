import { Profile, RecordedEvent } from '../types';

/**
 * Merge the base profile events (up to the takeover point) with the
 * human-recorded takeover events. Takeover events are time-shifted so
 * they start at `takeoverStartMs` within the combined timeline.
 */
export function mergeTakeoverEvents(
    baseProfile: Profile,
    takeoverStartMs: number,
    takeoverEvents: RecordedEvent[]
): RecordedEvent[] {
    const baseEvents = baseProfile.events.filter(event => {
        const metadata = event.metadata as Record<string, unknown> | undefined;
        if (metadata?.takeover_marker) return false;
        return event.t_ms < takeoverStartMs;
    });

    const shiftedTakeover = takeoverEvents.map(event => ({
        ...event,
        t_ms: takeoverStartMs + event.t_ms,
        human_override: true,
    }));

    return [...baseEvents, ...shiftedTakeover].sort((a, b) => a.t_ms - b.t_ms);
}
