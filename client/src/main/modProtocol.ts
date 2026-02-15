const REQUIRED_CAPABILITIES = ['status', 'record', 'replay'] as const;
const SUPPORTED_PROTOCOL_MAJOR = 1;

export type ModRecordState = 'idle' | 'armed' | 'live';
export type ModReplayState = 'idle' | 'armed' | 'live' | 'paused';

export type ModStatusResponse = {
  ok: boolean;
  state?: string;
  protocol_version: string;
  tick_hz: number;
  game_tick?: number;
  replay_index?: number;
  capabilities: string[];
  record_state: ModRecordState;
  record_active: boolean;
  record_armed: boolean;
  record_complete: boolean;
  replay_state: ModReplayState;
  replay_active: boolean;
  replay_armed: boolean;
  replay_requested: boolean;
  paused: boolean;
  takeover_armed: boolean;
  error?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseSemverMajor(version: string): number | null {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isFinite(major) ? major : null;
}

function validateEnum<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.includes(value as T);
}

export function validateModStatusPayload(payload: unknown): { ok: true; status: ModStatusResponse } | { ok: false; error: string } {
  if (!isObject(payload)) {
    return { ok: false, error: 'status_not_object' };
  }
  if (payload.ok !== true) {
    return { ok: false, error: 'status_ok_false' };
  }

  const protocolVersion = payload.protocol_version;
  if (typeof protocolVersion !== 'string') {
    return { ok: false, error: 'missing_protocol_version' };
  }
  const protocolMajor = parseSemverMajor(protocolVersion);
  if (protocolMajor === null) {
    return { ok: false, error: 'invalid_protocol_version' };
  }
  if (protocolMajor !== SUPPORTED_PROTOCOL_MAJOR) {
    return { ok: false, error: `unsupported_protocol_major_${protocolMajor}` };
  }

  const tickHz = payload.tick_hz;
  if (typeof tickHz !== 'number' || !Number.isFinite(tickHz) || tickHz <= 0) {
    return { ok: false, error: 'invalid_tick_hz' };
  }

  const capabilities = payload.capabilities;
  if (!Array.isArray(capabilities) || capabilities.some(value => typeof value !== 'string')) {
    return { ok: false, error: 'invalid_capabilities' };
  }
  const missingCapability = REQUIRED_CAPABILITIES.find(capability => !capabilities.includes(capability));
  if (missingCapability) {
    return { ok: false, error: `missing_capability_${missingCapability}` };
  }

  const recordState = payload.record_state;
  if (!validateEnum(recordState, ['idle', 'armed', 'live'])) {
    return { ok: false, error: 'invalid_record_state' };
  }

  const replayState = payload.replay_state;
  if (!validateEnum(replayState, ['idle', 'armed', 'live', 'paused'])) {
    return { ok: false, error: 'invalid_replay_state' };
  }

  const requiredBooleans = [
    'record_active',
    'record_armed',
    'record_complete',
    'replay_active',
    'replay_armed',
    'replay_requested',
    'paused',
    'takeover_armed',
  ] as const;

  for (const field of requiredBooleans) {
    if (typeof payload[field] !== 'boolean') {
      return { ok: false, error: `invalid_${field}` };
    }
  }

  const status: ModStatusResponse = {
    ok: true,
    protocol_version: protocolVersion,
    tick_hz: tickHz,
    capabilities: capabilities as string[],
    record_state: recordState,
    record_active: payload.record_active as boolean,
    record_armed: payload.record_armed as boolean,
    record_complete: payload.record_complete as boolean,
    replay_state: replayState,
    replay_active: payload.replay_active as boolean,
    replay_armed: payload.replay_armed as boolean,
    replay_requested: payload.replay_requested as boolean,
    paused: payload.paused as boolean,
    takeover_armed: payload.takeover_armed as boolean,
    state: typeof payload.state === 'string' ? payload.state : undefined,
    game_tick: typeof payload.game_tick === 'number' && Number.isFinite(payload.game_tick) ? payload.game_tick : undefined,
    replay_index:
      typeof payload.replay_index === 'number' && Number.isFinite(payload.replay_index) ? payload.replay_index : undefined,
    error: typeof payload.error === 'string' ? payload.error : undefined,
  };

  return { ok: true, status };
}

export function isReplaySignalActive(status: ModStatusResponse): boolean {
  return status.replay_state === 'armed' || status.replay_state === 'live' || status.replay_state === 'paused';
}

export function isReplayLive(status: ModStatusResponse): boolean {
  return status.replay_state === 'live';
}

