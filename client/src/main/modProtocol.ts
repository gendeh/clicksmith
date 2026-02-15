export interface ModStatusResponse {
    ok: boolean;
    replay_active?: boolean;
    replay_armed?: boolean;
    replay_requested?: boolean;
    replay_state?: string;
    replay_index?: number;
    record_active?: boolean;
    record_armed?: boolean;
    record_state?: string;
    record_complete?: boolean;
    takeover_armed?: boolean;
    paused?: boolean;
    game_tick?: number;
    error?: string;
    [key: string]: unknown;
}

export function isReplayLive(status: ModStatusResponse): boolean {
    return Boolean(
        status.replay_active || status.replay_state === 'live' || status.replay_state === 'playing'
    );
}

export function isReplaySignalActive(status: ModStatusResponse): boolean {
    return Boolean(
        status.replay_active ||
        status.replay_armed ||
        status.replay_requested ||
        status.replay_state === 'live' ||
        status.replay_state === 'armed' ||
        status.replay_state === 'playing'
    );
}

export function validateModStatusPayload(
    payload: unknown
): { ok: true; status: ModStatusResponse } | { ok: false; status?: undefined } {
    if (typeof payload !== 'object' || payload === null) {
        return { ok: false };
    }
    const record = payload as Record<string, unknown>;
    if (typeof record.ok !== 'boolean' && record.ok !== undefined) {
        return { ok: false };
    }
    return { ok: true, status: payload as ModStatusResponse };
}
