import { Profile, RecordedEvent } from '../types';

function getPressReleaseTimes(event: RecordedEvent): { pressTime: number; releaseTime: number | null } {
    const metadata = event.metadata as Record<string, unknown> | undefined;
    const action = typeof metadata?.action === 'string' ? metadata.action : undefined;
    const releaseTime =
        typeof metadata?.release_t_ms === 'number' ? (metadata.release_t_ms as number) : undefined;
    const duration = Math.max(0, event.duration_ms ?? 0);

    if (duration > 0 || releaseTime !== undefined) {
        if (action === 'down') {
            return { pressTime: event.t_ms, releaseTime: releaseTime ?? event.t_ms + duration };
        }
        if (action === 'up') {
            return { pressTime: Math.max(0, event.t_ms - duration), releaseTime: event.t_ms };
        }
        if (releaseTime !== undefined) {
            return { pressTime: Math.max(0, releaseTime - duration), releaseTime };
        }
        return { pressTime: Math.max(0, event.t_ms - duration), releaseTime: event.t_ms };
    }

    return { pressTime: event.t_ms, releaseTime: null };
}

function clipBaseEventAtTakeoverBoundary(
    event: RecordedEvent,
    takeoverStartMs: number
): RecordedEvent | null {
    const metadata = event.metadata as Record<string, unknown> | undefined;
    if (metadata?.takeover_marker) return null;

    const { pressTime, releaseTime } = getPressReleaseTimes(event);
    if (pressTime >= takeoverStartMs) return null;
    if (releaseTime === null || releaseTime <= takeoverStartMs) return event;

    const clippedRelease = takeoverStartMs;
    return {
        ...event,
        t_ms: pressTime,
        duration_ms: Math.max(0, clippedRelease - pressTime),
        metadata: {
            ...(metadata ?? {}),
            action: 'down',
            release_t_ms: clippedRelease,
        },
    };
}

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
    const baseEvents = baseProfile.events
        .map(event => clipBaseEventAtTakeoverBoundary(event, takeoverStartMs))
        .filter((event): event is RecordedEvent => event !== null);

    const shiftedTakeover = takeoverEvents.map(event => {
        const metadata = event.metadata as Record<string, unknown> | undefined;
        const releaseTime =
            typeof metadata?.release_t_ms === 'number' ? (metadata.release_t_ms as number) : undefined;
        return {
            ...event,
            t_ms: takeoverStartMs + event.t_ms,
            human_override: true,
            metadata:
                releaseTime !== undefined
                    ? {
                          ...(metadata ?? {}),
                          release_t_ms: takeoverStartMs + releaseTime,
                      }
                    : event.metadata,
        };
    });

    return [...baseEvents, ...shiftedTakeover].sort((a, b) => a.t_ms - b.t_ms);
}
