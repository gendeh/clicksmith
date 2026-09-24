import { RecordingEngine } from '../src/main/recordingEngine';
import { PlaybackEngine } from '../src/main/playbackEngine';
import { MockInputHook } from '../src/main/inputHooks';
import { decodeJsEvents, GamepadSample, GamepadSource } from '../src/main/gamepadSource';
import { PlaybackConfig, Profile, RecordingConfig, RecordedEvent } from '../src/types';
import { summarizeRecordedInputs } from '../src/types/input';

const recordConfig: RecordingConfig = {
  target: 'notepad.exe',
  captureImages: false,
  imagePatchSize: 128,
  minEventInterval: 100000,
  recordKeyboard: true,
  recordMouse: true,
  recordWheel: true,
  recordMotion: true,
  recordGamepad: true,
  stopHotkey: 'F9',
  takeoverHotkey: 'F11',
};

function engineWith(hook: MockInputHook, gamepadSource?: GamepadSource) {
  return new RecordingEngine({
    inputHook: hook,
    windowManager: { getTargetBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }) } as any,
    gamepadSource,
  });
}

describe('gaming input capture', () => {
  test('keeps pointer buttons, keys, scroll, and motion as separate events', async () => {
    const hook = new MockInputHook();
    const engine = engineWith(hook);
    await engine.start(recordConfig);

    hook.emit('mousedown', { x: 10, y: 10, button: 1 });
    hook.emit('mouseup', { x: 10, y: 10, button: 1 });
    hook.emit('mousedown', { x: 12, y: 10, button: 2 });
    hook.emit('mouseup', { x: 12, y: 10, button: 2 });
    hook.emit('mousedown', { x: 14, y: 10, button: 3 });
    hook.emit('mouseup', { x: 14, y: 10, button: 3 });
    hook.emit('mousedown', { x: 16, y: 10, button: 4 });
    hook.emit('mouseup', { x: 16, y: 10, button: 4 });
    hook.emit('mousedown', { x: 18, y: 10, button: 5 });
    hook.emit('mouseup', { x: 18, y: 10, button: 5 });
    hook.emit('mousedown', { x: 18, y: 10, button: 9 });
    hook.emit('mousedown', { x: 18, y: 10, button: 1 });

    hook.emit('keydown', { keycode: 17 });
    hook.emit('keyup', { keycode: 17 });
    hook.emit('keydown', { keycode: 57416 });
    hook.emit('keyup', { keycode: 57416 });
    hook.emit('keydown', { keycode: 57 });
    hook.emit('keydown', { keycode: 57 });

    hook.emit('wheel', { x: 40, y: 50, rotation: -1, direction: 3 });
    hook.emit('wheel', { x: 40, y: 50, rotation: 2, direction: 4 });
    hook.emit('mousemove', { x: 0, y: 0 });
    hook.emit('mousemove', { x: 30, y: 0 });
    hook.emit('mousemove', { x: 31, y: 0 });

    const result = await engine.stop();
    const events = result.profile.events as RecordedEvent[];
    expect(events.filter(event => event.type === 'mouse').map(event => event.btn)).toEqual([
      'left',
      'right',
      'middle',
      'back',
      'forward',
      'left',
    ]);
    expect(events.filter(event => event.type === 'keyboard').map(event => event.key)).toEqual(['w', 'up', 'space']);
    expect(events.filter(event => event.type === 'wheel')).toEqual([
      expect.objectContaining({ wheel_dx: 0, wheel_dy: -1 }),
      expect.objectContaining({ wheel_dx: 2, wheel_dy: 0 }),
    ]);
    expect(events.filter(event => event.type === 'move')).toEqual([
      expect.objectContaining({ type: 'move', x: 30, y: 0 }),
    ]);
    expect(summarizeRecordedInputs(events)).toBe(
      '6 pointer clicks, 3 keys, 1 pointer move, 2 scrolls'
    );
  });

  test('records a gamepad button hold and a stick deflection', async () => {
    const queued: GamepadSample[][] = [
      [{ pad: 0, kind: 'button', index: 0, value: 1 }],
      [{ pad: 0, kind: 'button', index: 0, value: 0 }, { pad: 0, kind: 'axis', index: 1, value: 0.8 }],
    ];
    const source: GamepadSource = {
      start() {
        return;
      },
      stop() {
        return;
      },
      poll() {
        return queued.shift() ?? [];
      },
    };
    const engine = engineWith(new MockInputHook(), source);
    await engine.start(recordConfig);
    const result = await engine.stop();
    const events = result.profile.events as RecordedEvent[];
    expect(events).toEqual([
      expect.objectContaining({ type: 'gamepad', pad: 0, control: 0, value: 1 }),
      expect.objectContaining({ type: 'gamepad', pad: 0, control: 1, value: 0.8 }),
    ]);
    expect(events[0].duration_ms).toBeGreaterThan(0);
    expect(events[0].metadata).toEqual(expect.objectContaining({ action: 'down', axis: false }));
    expect(summarizeRecordedInputs(events)).toBe('2 gamepad inputs');
  });

  test('decodes linux joystick packets and skips init frames', () => {
    const axis = Buffer.alloc(8);
    axis.writeInt16LE(32767, 4);
    axis.writeUInt8(0x02, 6);
    axis.writeUInt8(1, 7);
    const button = Buffer.alloc(8);
    button.writeInt16LE(1, 4);
    button.writeUInt8(0x01, 6);
    button.writeUInt8(0, 7);
    const init = Buffer.alloc(8);
    init.writeUInt8(0x81, 6);
    const packet = Buffer.concat([init, button, axis]);
    expect(decodeJsEvents(packet, 2)).toEqual([
      { pad: 2, kind: 'button', index: 0, value: 1 },
      { pad: 2, kind: 'axis', index: 1, value: 1 },
    ]);
  });
});

describe('gaming input playback', () => {
  test('replays move, scroll, side button, key, and gamepad samples', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2020-01-01T00:00:00Z'));

    const calls: unknown[][] = [];
    const fakePlayer = {
      moveMouse: (x: number, y: number) => calls.push(['move', x, y]),
      mouseDown: (button: string) => calls.push(['mouseDown', button]),
      mouseUp: (button: string) => calls.push(['mouseUp', button]),
      scroll: (dx: number, dy: number) => calls.push(['scroll', dx, dy]),
      keyDown: (key: string) => calls.push(['keyDown', key]),
      keyUp: (key: string) => calls.push(['keyUp', key]),
      gamepadButton: (pad: number, index: number, down: boolean) => calls.push(['pad', pad, index, down]),
      gamepadAxis: (pad: number, index: number, value: number) => calls.push(['axis', pad, index, value]),
    };

    const point = { x: 10, y: 20, rel_x: 0.1, rel_y: 0.2, human_override: false, duration_ms: 0 };
    const profile: Profile = {
      id: 'inputs',
      name: 'Inputs',
      target_app: 'screen',
      created_at: new Date().toISOString(),
      version: 1,
      notes: '',
      success_metric: { furthest_frame: 0, score: 0 },
      events: [
        { ...point, t_ms: 0, type: 'move' },
        { ...point, t_ms: 5, type: 'wheel', wheel_dx: 0, wheel_dy: -1 },
        {
          ...point,
          t_ms: 10,
          type: 'mouse',
          btn: 'back',
          duration_ms: 8,
          metadata: { action: 'down', release_t_ms: 18 },
        },
        {
          ...point,
          t_ms: 12,
          type: 'keyboard',
          key: 'up',
          duration_ms: 6,
          metadata: { action: 'down', release_t_ms: 18 },
        },
        {
          ...point,
          t_ms: 20,
          type: 'gamepad',
          pad: 0,
          control: 1,
          value: 0.5,
          metadata: { action: 'axis', axis: true },
        },
        {
          ...point,
          t_ms: 22,
          type: 'gamepad',
          pad: 0,
          control: 0,
          value: 1,
          duration_ms: 10,
          metadata: { action: 'down', release_t_ms: 32, axis: false },
        },
      ],
    };

    const config: PlaybackConfig = {
      profileId: 'inputs',
      target: 'screen',
      useImageMatching: false,
      imageMatchThreshold: 0.6,
      timingTolerance: 50,
      retryCount: 0,
      retryDelay: 0,
      takeoverHotkey: 'F11',
      speedMultiplier: 1,
      useRelativeCoords: true,
    };

    const playback = new PlaybackEngine({
      inputPlayer: fakePlayer as any,
      windowManager: { getTargetBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) } as any,
    });

    await playback.start(config, profile);
    await jest.advanceTimersByTimeAsync(80);

    expect(calls).toEqual([
      ['move', 10, 20],
      ['move', 10, 20],
      ['scroll', 0, -1],
      ['move', 10, 20],
      ['mouseDown', 'back'],
      ['keyDown', 'up'],
      ['mouseUp', 'back'],
      ['keyUp', 'up'],
      ['axis', 0, 1, 0.5],
      ['pad', 0, 0, true],
      ['pad', 0, 0, false],
    ]);
    expect(playback.getStatus().state).toBe('idle');
    jest.useRealTimers();
  });
});
