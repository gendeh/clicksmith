export const CHECKOUT_ADAPTER_PROTOCOL_VERSION = '2.0.0';
export const TICK_HZ = 240;
export const TICK_MS = 1000 / TICK_HZ;

export type TickStamp = {
  t_ms: number;
  t_tick: number;
};

export function tickToMs(tick: number): number {
  if (!Number.isFinite(tick) || tick <= 0) return 0;
  return tick * TICK_MS;
}

export function msToTick(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.max(0, Math.round(ms / TICK_MS));
}

export function isReplayEventDue(tTick: number, elapsedTicks: number): boolean {
  return tTick <= elapsedTicks;
}

export function resolveTickStamp(tMs: unknown, tTick?: unknown): TickStamp | null {
  if (typeof tTick === 'number' && Number.isFinite(tTick)) {
    const tick = Math.max(0, Math.round(tTick));
    return { t_tick: tick, t_ms: tickToMs(tick) };
  }
  if (typeof tMs === 'number' && Number.isFinite(tMs) && tMs >= 0) {
    const tick = msToTick(tMs);
    return { t_tick: tick, t_ms: tickToMs(tick) };
  }
  return null;
}

export function adapterProtocolMismatch(protocolVersion: unknown): string | null {
  if (protocolVersion === CHECKOUT_ADAPTER_PROTOCOL_VERSION) return null;
  const loaded = typeof protocolVersion === 'string' && protocolVersion.length > 0 ? protocolVersion : 'missing';
  return `stale_adapter_protocol: loaded ${loaded}, checkout ${CHECKOUT_ADAPTER_PROTOCOL_VERSION}`;
}
