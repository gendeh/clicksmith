import { RecordingEngine } from '../../src/main/recordingEngine';
import { PlaybackEngine } from '../../src/main/playbackEngine';
import { MockInputHook } from '../../src/main/inputHooks';
import { PlaybackConfig, Profile, RecordingConfig } from '../../src/types';

jest.mock('../../src/main/screenCapture', () => ({
  captureRegion: jest.fn().mockResolvedValue(Buffer.from('')),
}));

describe('Synthetic recording + playback', () => {
  test('replays with low drift and expected dispatch volume', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2020-01-01T00:00:00Z'));

    const hook = new MockInputHook();
    const recording = new RecordingEngine({
      inputHook: hook,
      windowManager: { getTargetBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }) } as any,
    });

    const recordConfig: RecordingConfig = {
      target: 'synthetic',
      captureImages: false,
      imagePatchSize: 128,
      minEventInterval: 0,
      recordKeyboard: false,
      recordMouse: true,
      stopHotkey: 'F9',
      takeoverHotkey: 'F11',
    };

    await recording.start(recordConfig);

    for (let i = 0; i < 20; i += 1) {
      hook.emit('mousedown', { x: 100 + i * 5, y: 120 + i * 3, button: 1 });
      jest.advanceTimersByTime(5);
      hook.emit('mouseup', { x: 100 + i * 5, y: 120 + i * 3, button: 1 });
      jest.advanceTimersByTime(95);
    }

    const result = await recording.stop();
    const baseProfile: Profile = {
      id: 'synthetic',
      name: 'Synthetic',
      target_app: 'synthetic',
      created_at: new Date().toISOString(),
      version: 1,
      events: result.profile.events.map((event: any) => ({
        ...event,
        img_patch_b64: 'ZHVtbXk=',
      })),
      success_metric: { furthest_frame: 0, score: 0 },
      notes: '',
      metadata: {
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        version: 1,
        total_duration_ms: result.profile.duration,
        event_count: result.profile.events.length,
        override_count: 0,
        tags: [],
      },
    };

    const config: PlaybackConfig = {
      profileId: baseProfile.id,
      target: 'synthetic',
      useImageMatching: false,
      imageMatchThreshold: 0.6,
      timingTolerance: 20,
      retryCount: 1,
      retryDelay: 10,
      takeoverHotkey: 'F11',
      speedMultiplier: 1,
      useRelativeCoords: true,
      imageSearchRadius: 100,
    };

    const fakePlayer = {
      moveMouse: jest.fn(),
      mouseDown: jest.fn(),
      mouseUp: jest.fn(),
      keyDown: jest.fn(),
      keyUp: jest.fn(),
    };

    const fakeImageService = {
      matchImage: jest.fn().mockResolvedValue({
        success: true,
        matches: [],
        bestMatch: { x: 10, y: 10, confidence: 0.9, bounds: { x: 0, y: 0, width: 20, height: 20 } },
        processingTimeMs: 4,
      }),
    };

    const playback = new PlaybackEngine({
      inputPlayer: fakePlayer as any,
      imageService: fakeImageService as any,
      windowManager: { getTargetBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }) } as any,
    });
    const driftSamples: number[] = [];
    playback.on('status', status => {
      if (status.state === 'playing' && Number.isFinite(status.timingDrift)) {
        driftSamples.push(Math.abs(status.timingDrift));
      }
    });

    await playback.start(config, baseProfile);
    await jest.advanceTimersByTimeAsync(3000);

    const status = playback.getStatus();
    const sortedDrift = [...driftSamples].sort((a, b) => a - b);
    const p95Index = Math.max(0, Math.floor(sortedDrift.length * 0.95) - 1);
    const driftP95 = sortedDrift[p95Index] ?? 0;

    expect(Math.abs(status.timingDrift)).toBeLessThan(8);
    expect(driftP95).toBeLessThanOrEqual(4);
    expect(fakePlayer.mouseDown).toHaveBeenCalledTimes(baseProfile.events.length);
    expect(fakePlayer.mouseUp).toHaveBeenCalledTimes(baseProfile.events.length);
    jest.useRealTimers();
  });
});
