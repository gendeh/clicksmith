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
      clickWithDuration: async () => actions.push('click'),
      keyDown: () => actions.push('keyDown'),
      keyUp: () => actions.push('keyUp'),
    };

    const engine = new PlaybackEngine({
      inputPlayer: fakePlayer as any,
      windowManager: { getTargetBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) } as any,
    });

    await engine.start(config, baseProfile);
    jest.advanceTimersByTime(200);

    expect(actions).toContain('click');
    expect(actions).toContain('keyDown');
    expect(engine.getStatus().state).toBe('idle');
  });
});
