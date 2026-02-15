import { RunLifecycleManager, RunLifecycleEventType } from '../src/main/runLifecycle';

function applySequence(manager: RunLifecycleManager, events: RunLifecycleEventType[]) {
  const now = Date.now();
  events.forEach((type, index) => {
    manager.apply({ type, atMs: now + index });
  });
  return manager.getSnapshot();
}

describe('RunLifecycleManager', () => {
  test('record arm transitions to live on attempt boundary', () => {
    const manager = new RunLifecycleManager();
    const snapshot = applySequence(manager, ['arm_record', 'attempt_boundary']);

    expect(snapshot.state).toBe('record_live');
    expect(snapshot.attemptId).toBe(1);
    expect(snapshot.paused).toBe(false);
  });

  test('record arm survives death until attempt boundary', () => {
    const manager = new RunLifecycleManager();
    const snapshot = applySequence(manager, ['arm_record', 'death']);

    expect(snapshot.state).toBe('record_armed');
    expect(snapshot.paused).toBe(false);
  });

  test('stop record finalizes then returns to idle', () => {
    const manager = new RunLifecycleManager();
    let snapshot = applySequence(manager, ['arm_record', 'attempt_boundary', 'stop_record']);

    expect(snapshot.state).toBe('finalizing');

    snapshot = applySequence(manager, ['finalize_done']);
    expect(snapshot.state).toBe('idle');
  });

  test('replay arm transitions to live and stops on death', () => {
    const manager = new RunLifecycleManager();
    const snapshot = applySequence(manager, ['arm_replay', 'attempt_boundary', 'death']);

    expect(snapshot.state).toBe('idle');
    expect(snapshot.paused).toBe(false);
  });

  test('takeover switches replay live to takeover live', () => {
    const manager = new RunLifecycleManager();
    const snapshot = applySequence(manager, ['arm_replay', 'attempt_boundary', 'takeover_click']);

    expect(snapshot.state).toBe('takeover_live');
  });

  test('pause/unpause toggles paused flag in live replay state', () => {
    const manager = new RunLifecycleManager();
    let snapshot = applySequence(manager, ['arm_replay', 'attempt_boundary', 'pause']);

    expect(snapshot.state).toBe('replay_live');
    expect(snapshot.paused).toBe(true);

    snapshot = applySequence(manager, ['unpause']);
    expect(snapshot.paused).toBe(false);
  });

  test('level complete in takeover transitions to finalizing', () => {
    const manager = new RunLifecycleManager();
    const snapshot = applySequence(manager, [
      'arm_replay',
      'attempt_boundary',
      'takeover_click',
      'level_complete',
    ]);

    expect(snapshot.state).toBe('finalizing');
  });

  test('arm replay toggles off when pressed twice before boundary', () => {
    const manager = new RunLifecycleManager();
    const snapshot = applySequence(manager, ['arm_replay', 'arm_replay']);

    expect(snapshot.state).toBe('idle');
  });
});
