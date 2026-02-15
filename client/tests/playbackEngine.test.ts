import { PlaybackEngine } from '../src/main/playbackEngine';
import { PlaybackConfig, Profile } from '../src/types';

describe('PlaybackEngine', () => {
  const baseProfile: Profile = {
    id: 'p1',
    name: 'Test',
    target_app: 'screen',
    created_at: new Date().toISOString(),
    version: 1,
    events: [
      {
        t_ms: 0,
        type: 'mouse',
        btn: 'left',
        x: 10,
        y: 20,
        rel_x: 0.1,
        rel_y: 0.2,
        duration_ms: 5,
        human_override: false,
      },
      {
        t_ms: 50,
        type: 'keyboard',
        key: 'a',
        keyCode: 30,
        x: 10,
        y: 20,
        rel_x: 0.1,
        rel_y: 0.2,
        duration_ms: 10,
        human_override: false,
      },
    ],
    success_metric: { furthest_frame: 0, score: 0 },
    notes: '',
    metadata: {
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: 1,
      total_duration_ms: 100,
      event_count: 2,
      override_count: 0,
      tags: [],
    },
  };

  const config: PlaybackConfig = {
    profileId: 'p1',
    target: 'screen',
    useImageMatching: false,
    imageMatchThreshold: 0.6,
    timingTolerance: 20,
    retryCount: 0,
    retryDelay: 10,
    takeoverHotkey: 'F11',
    speedMultiplier: 1,
    useRelativeCoords: true,
  };

  test('plays through events', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2020-01-01T00:00:00Z'));

    const actions: string[] = [];
    const fakePlayer = {
      moveMouse: () => actions.push('move'),
      mouseDown: () => actions.push('mouseDown'),
      mouseUp: () => actions.push('mouseUp'),
      keyDown: () => actions.push('keyDown'),
      keyUp: () => actions.push('keyUp'),
    };

    const engine = new PlaybackEngine({
      inputPlayer: fakePlayer as any,
      windowManager: { getTargetBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) } as any,
    });

    await engine.start(config, baseProfile);
    await jest.advanceTimersByTimeAsync(250);

    expect(actions).toContain('mouseDown');
    expect(actions).toContain('mouseUp');
    expect(actions).toContain('keyDown');
    expect(engine.getStatus().state).toBe('idle');
    jest.useRealTimers();
  });

  test('pause/resume compensates timeline without cumulative drift', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2020-01-01T00:00:00Z'));

    const profile: Profile = {
      ...baseProfile,
      events: [
        {
          t_ms: 100,
          type: 'mouse',
          btn: 'left',
          x: 10,
          y: 20,
          rel_x: 0.1,
          rel_y: 0.2,
          duration_ms: 0,
          human_override: false,
        },
      ],
    };

    const actions: string[] = [];
    const fakePlayer = {
      moveMouse: () => actions.push('move'),
      mouseDown: () => actions.push('mouseDown'),
      mouseUp: () => actions.push('mouseUp'),
      keyDown: () => actions.push('keyDown'),
      keyUp: () => actions.push('keyUp'),
    };

    const engine = new PlaybackEngine({
      inputPlayer: fakePlayer as any,
      windowManager: { getTargetBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) } as any,
    });

    await engine.start(config, profile);
    await jest.advanceTimersByTimeAsync(40);
    engine.pause();
    await jest.advanceTimersByTimeAsync(500);
    expect(actions.length).toBe(0);

    engine.resume();
    await jest.advanceTimersByTimeAsync(55);
    expect(actions.length).toBe(0);
    await jest.advanceTimersByTimeAsync(10);
    expect(actions).toContain('mouseDown');
    expect(actions).toContain('mouseUp');
    jest.useRealTimers();
  });

  test('dispatch order is stable for same timestamp actions', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2020-01-01T00:00:00Z'));

    const profile: Profile = {
      ...baseProfile,
      events: [
        {
          t_ms: 0,
          type: 'mouse',
          btn: 'left',
          x: 10,
          y: 20,
          rel_x: 0.1,
          rel_y: 0.2,
          duration_ms: 0,
          human_override: false,
        },
        {
          t_ms: 0,
          type: 'keyboard',
          key: 'a',
          keyCode: 30,
          x: 10,
          y: 20,
          rel_x: 0.1,
          rel_y: 0.2,
          duration_ms: 0,
          human_override: false,
        },
      ],
    };

    const actions: string[] = [];
    const fakePlayer = {
      moveMouse: () => actions.push('move'),
      mouseDown: () => actions.push('mouseDown'),
      mouseUp: () => actions.push('mouseUp'),
      keyDown: () => actions.push('keyDown'),
      keyUp: () => actions.push('keyUp'),
    };

    const engine = new PlaybackEngine({
      inputPlayer: fakePlayer as any,
      windowManager: { getTargetBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) } as any,
    });

    await engine.start(config, profile);
    await jest.advanceTimersByTimeAsync(20);

    expect(actions).toEqual(['move', 'mouseDown', 'keyDown', 'mouseUp', 'keyUp']);
    jest.useRealTimers();
  });
});
