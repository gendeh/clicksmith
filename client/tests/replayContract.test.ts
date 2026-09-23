import {
  CHECKOUT_ADAPTER_PROTOCOL_VERSION,
  adapterProtocolMismatch,
  isReplayEventDue,
  resolveTickStamp,
} from '../src/main/replayContract';

describe('replayContract', () => {
  it('keeps an explicit progress tick and derives t_ms from it', () => {
    expect(resolveTickStamp(3416.1, 820)).toEqual({ t_tick: 820, t_ms: 820 * (1000 / 240) });
  });

  it('derives t_tick from a 240 Hz t_ms boundary when the profile omitted t_tick', () => {
    expect(resolveTickStamp(3416.666666666667)).toEqual({ t_tick: 820, t_ms: 820 * (1000 / 240) });
  });

  it('treats due-ness as a pure function of tick', () => {
    expect(isReplayEventDue(2872, 2871)).toBe(false);
    expect(isReplayEventDue(2872, 2872)).toBe(true);
    expect(isReplayEventDue(2872, 3004)).toBe(true);
  });

  it('refuses a stale adapter protocol', () => {
    expect(adapterProtocolMismatch('1.0.0')).toBe(
      `stale_adapter_protocol: loaded 1.0.0, checkout ${CHECKOUT_ADAPTER_PROTOCOL_VERSION}`
    );
    expect(adapterProtocolMismatch(CHECKOUT_ADAPTER_PROTOCOL_VERSION)).toBeNull();
    expect(adapterProtocolMismatch(undefined)).toContain('stale_adapter_protocol');
  });
});
