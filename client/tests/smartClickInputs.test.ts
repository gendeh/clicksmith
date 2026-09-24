jest.mock('../src/main/screenCapture', () => ({
  capturePatch: jest.fn(async () => Buffer.from('anchor-patch')),
  captureRegion: jest.fn(async () => Buffer.from('search-region')),
  captureScreen: jest.fn(async () => Buffer.from('full-screen')),
}));

import { RecordingEngine } from '../src/main/recordingEngine';
import { PlaybackEngine } from '../src/main/playbackEngine';
import { MockInputHook } from '../src/main/inputHooks';
import { capturePatch } from '../src/main/screenCapture';
import { PlaybackConfig, Profile, RecordingConfig, RecordedEvent } from '../src/types';

const capturePatchMock = capturePatch as jest.Mock;

describe('SmartClick on gaming inputs', () => {
  beforeEach(() => {
    capturePatchMock.mockClear();
  });

  test('anchors pointer buttons, spaced motion, and scroll, and skips keys', async () => {
    const hook = new MockInputHook();
    const engine = new RecordingEngine({
      inputHook: hook,
      windowManager: { getTargetBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }) } as any,
    });
    const config: RecordingConfig = {
      target: 'game',
      captureImages: true,
      imagePatchSize: 32,
      minEventInterval: 100000,
      recordKeyboard: true,
      recordMouse: true,
      recordWheel: true,
      recordMotion: true,
      stopHotkey: 'F9',
      takeoverHotkey: 'F11',
    };

    await engine.start(config);
    hook.emit('mousemove', { x: 0, y: 0 });
    hook.emit('mousemove', { x: 20, y: 0 });
    hook.emit('mousemove', { x: 30, y: 0 });
    hook.emit('mousemove', { x: 80, y: 0 });
    hook.emit('wheel', { x: 80, y: 0, rotation: -1, direction: 3 });
    hook.emit('mousedown', { x: 80, y: 0, button: 4 });
    hook.emit('mouseup', { x: 80, y: 0, button: 4 });
    hook.emit('keydown', { keycode: 17 });
    hook.emit('keyup', { keycode: 17 });
    const result = await engine.stop();
    await new Promise(resolve => setImmediate(resolve));

    const events = result.profile.events as RecordedEvent[];
    const anchored = events.filter(event => event.img_patch_b64).map(event => event.type);
    expect(anchored).toEqual(['move', 'move', 'wheel', 'mouse', 'keyboard']);
    expect(events.find(event => event.type === 'mouse')?.btn).toBe('back');
    expect(events.find(event => event.type === 'keyboard')?.metadata).toEqual(
      expect.objectContaining({ anchor_window: { width: 1000, height: 800 } })
    );
    expect(capturePatchMock).toHaveBeenCalledTimes(5);
  });

  test('retargets a side click, a move, and a scroll, then keeps that offset', async () => {
    const matchImage = jest.fn(async () => ({
      success: true,
      matches: [],
      bestMatch: {
        x: 40,
        y: 10,
        confidence: 0.95,
        bounds: { x: 0, y: 0, width: 8, height: 8 },
      },
      processingTimeMs: 1,
    }));
    const calls: unknown[][] = [];
    const player = {
      moveMouse: (x: number, y: number) => calls.push(['move', x, y]),
      mouseDown: (button: string) => calls.push(['down', button]),
      mouseUp: (button: string) => calls.push(['up', button]),
      scroll: (dx: number, dy: number) => calls.push(['scroll', dx, dy]),
      keyDown: (key: string) => calls.push(['key', key]),
      keyUp: () => calls.push(['keyUp']),
      gamepadAxis: () => calls.push(['axis']),
    };
    const point = {
      x: 500,
      y: 400,
      rel_x: 0.5,
      rel_y: 0.5,
      human_override: false,
      duration_ms: 0,
      img_patch_b64: 'cGF0Y2g=',
    };
    const profile: Profile = {
      id: 'smart',
      name: 'Smart',
      target_app: 'game',
      created_at: new Date().toISOString(),
      version: 1,
      notes: '',
      success_metric: { furthest_frame: 0, score: 0 },
      events: [
        { ...point, t_ms: 0, type: 'mouse', btn: 'back' },
        { ...point, t_ms: 80, type: 'move' },
        { ...point, t_ms: 160, type: 'wheel', wheel_dx: 0, wheel_dy: -1 },
        { ...point, t_ms: 240, type: 'move', rel_x: 0.6, img_patch_b64: undefined },
        { ...point, t_ms: 320, type: 'keyboard', key: 'w', img_patch_b64: undefined },
        {
          ...point,
          t_ms: 400,
          type: 'gamepad',
          pad: 0,
          control: 1,
          value: 0.4,
          img_patch_b64: undefined,
          metadata: { action: 'axis', axis: true },
        },
      ],
    };
    const config: PlaybackConfig = {
      profileId: 'smart',
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
      windowManager: { getTargetBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }) } as any,
    });

    const finished = new Promise(resolve => playback.once('complete', resolve));
    await playback.start(config, profile);
    await finished;

    expect(matchImage).toHaveBeenCalledTimes(3);
    expect(calls).toEqual([
      ['move', 380, 250],
      ['down', 'back'],
      ['up', 'back'],
      ['move', 380, 250],
      ['move', 380, 250],
      ['scroll', 0, -1],
      ['move', 480, 250],
      ['key', 'w'],
      ['keyUp'],
      ['axis'],
    ]);
  });
});
