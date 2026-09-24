import { RunLifecycleManager } from '../src/main/runLifecycle';

describe('run lifecycle takeover', () => {
  test('a wheel grab is takeover_live until the human segment finishes', () => {
    const lifecycle = new RunLifecycleManager();
    lifecycle.apply({ type: 'arm_replay', atMs: 0 });
    lifecycle.apply({ type: 'attempt_boundary', atMs: 1 });
    const grabbed = lifecycle.apply({ type: 'takeover_click', atMs: 50 });
    expect(grabbed.next).toBe('takeover_live');
    expect(lifecycle.getSnapshot().state).toBe('takeover_live');

    lifecycle.apply({ type: 'arm_record', atMs: 51 });
    expect(lifecycle.getSnapshot().state).toBe('record_armed');
    lifecycle.apply({ type: 'stop_record', atMs: 80 });
    expect(lifecycle.getSnapshot().state).toBe('idle');
  });
});
