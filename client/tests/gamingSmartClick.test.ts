jest.mock('../src/main/screenCapture', () => ({
  capturePatch: jest.fn(async () => Buffer.from('patch')),
  captureRegion: jest.fn(async () => Buffer.from('region')),
  captureScreen: jest.fn(async () => Buffer.from('screen')),
}));

import { PlaybackEngine } from '../src/main/playbackEngine';
import { joinGamePresses, windowScale } from '../src/main/gameAim';
import { PlaybackConfig, Profile, RecordedEvent } from '../src/types';

describe('gaming SmartClick', () => {
  test('joins a press that lands inside a click at the same place', () => {
    const click = {
      t_ms: 10,
      type: 'mouse' as const,
      btn: 'left' as const,
      x: 100,
      y: 100,
      rel_x: 0.5,
      rel_y: 0.5,
      duration_ms: 30,
      human_override: false,
      metadata: { action: 'down', release_t_ms: 40 },
    };
    const jump = {
      t_ms: 16,
      type: 'keyboard' as const,
      key: 'space',
      x: 100,
      y: 100,
      rel_x: 0.5,
      rel_y: 0.5,
      duration_ms: 20,
      human_override: false,
      metadata: { action: 'down', release_t_ms: 36 },
    };
    const later = {
      ...jump,
      t_ms: 80,
      key: 'e',
    };
    const joined = joinGamePresses([click, jump, later]);
    expect(joined.get(click)?.map(event => event.key)).toEqual(['space']);
    expect(windowScale({ width: 200, height: 100 }, { width: 100, height: 50 })).toEqual({ sx: 0.5, sy: 0.5 });
  });

  test('clicks and presses the joined key at the scaled match point', async () => {
    const matchImage = jest.fn(async () => ({
      success: true,
      matches: [],
      bestMatch: { x: 15, y: 25, confidence: 0.95, bounds: { x: 0, y: 0, width: 8, height: 8 } },
      processingTimeMs: 1,
    }));
    const calls: unknown[][] = [];
    const player = {
      moveMouse: (x: number, y: number) => calls.push(['move', x, y]),
      mouseDown: (button: string) => calls.push(['down', button]),
      mouseUp: (button: string) => calls.push(['up', button]),
      keyDown: (key: string) => calls.push(['key', key]),
      keyUp: (key: string) => calls.push(['keyUp', key]),
      scroll: () => undefined,
      gamepadButton: () => true,
      gamepadAxis: () => true,
    };
    const place = {
      t_ms: 0,
      type: 'mouse' as const,
      btn: 'left' as const,
      x: 100,
      y: 100,
      rel_x: 0.5,
      rel_y: 0.5,
      duration_ms: 40,
      human_override: false,
      img_patch_b64: 'cGF0Y2g=',
      metadata: {
        action: 'down',
        release_t_ms: 40,
        anchor_window: { width: 200, height: 200 },
      },
    };
    const jump: RecordedEvent = {
      t_ms: 10,
      type: 'keyboard',
      key: 'space',
      x: 100,
      y: 100,
      rel_x: 0.5,
      rel_y: 0.5,
      duration_ms: 20,
      human_override: false,
      metadata: { action: 'down', release_t_ms: 30 },
    };
    const profile: Profile = {
      id: 'aim',
      name: 'Aim',
      target_app: 'game',
      created_at: new Date().toISOString(),
      version: 1,
      notes: '',
      success_metric: { furthest_frame: 0, score: 0 },
      events: [place, jump],
    };
    const config: PlaybackConfig = {
      profileId: 'aim',
      target: 'game',
      useImageMatching: true,
      imageMatchThreshold: 0.6,
      timingTolerance: 20,
      retryCount: 0,
      retryDelay: 0,
      takeoverHotkey: 'F11',
      speedMultiplier: 1,
      useRelativeCoords: true,
      imageSearchRadius: 160,
    };
    const playback = new PlaybackEngine({
      inputPlayer: player as any,
      imageService: { matchImage } as any,
      windowManager: { getTargetBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) } as any,
    });

    const finished = new Promise(resolve => playback.once('complete', resolve));
    await playback.start(config, profile);
    await finished;

    expect(matchImage).toHaveBeenCalledTimes(1);
    expect(matchImage).toHaveBeenCalledWith(expect.objectContaining({ scaleX: 0.5, scaleY: 0.5 }));
    expect(calls).toEqual([
      ['move', 15, 25],
      ['down', 'left'],
      ['key', 'space'],
      ['up', 'left'],
      ['keyUp', 'space'],
    ]);
  });
});
