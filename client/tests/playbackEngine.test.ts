import { PlaybackEngine } from '../src/main/playbackEngine';
import { PlaybackConfig, Profile } from '../src/types';
import * as screenCapture from '../src/main/screenCapture';
import { computeDHash } from '../src/main/imageHash';

jest.mock('electron', () => ({
  screen: {
    getAllDisplays: jest.fn(() => [
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    ]),
    getPrimaryDisplay: jest.fn(() => ({
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      scaleFactor: 1,
    })),
  },
}));

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

  test('updates SmartClick scale hint with smoothing over successive matches', () => {
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      windowManager: { getTargetBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) } as any,
    }) as any;

    engine.smartClickScaleHint = 1.0;
    engine.updateSmartClickScaleHint(1.3);
    expect(engine.smartClickScaleHint).toBeCloseTo(1.18, 2);

    engine.updateSmartClickScaleHint(0.8);
    expect(engine.smartClickScaleHint).toBeCloseTo(0.95, 2);
  });

  test('resolves SmartClick even when prefetch is missing', async () => {
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      windowManager: { getTargetBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) } as any,
    }) as any;

    engine.smartClickAnchor = { dx: 3, dy: 4 };
    engine.resolveSmartClick = jest.fn().mockResolvedValue({ x: 321, y: 123 });

    const result = await engine.getSmartClickCoords(
      2,
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
        img_patch_b64: 'x',
      },
      { x: 30, y: 40 }
    );

    expect(engine.resolveSmartClick).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ x: 321, y: 123 });
  });

  test('SmartClick in-flight timeout falls back to expected coords and increments retries', async () => {
    jest.useFakeTimers();

    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      windowManager: { getTargetBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) } as any,
    }) as any;

    engine.smartClickAnchor = { dx: 5, dy: -2 };
    engine.status = { ...engine.getStatus(), retries: 0 };
    engine.smartClickPromises.set(5, new Promise(() => {}));

    const pending = engine.getSmartClickCoords(
      5,
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
        img_patch_b64: 'x',
      },
      { x: 100, y: 200 }
    );

    await jest.advanceTimersByTimeAsync(300);
    const result = await pending;

    expect(result).toEqual({ x: 100, y: 200 });
    expect(engine.getStatus().retries).toBe(1);
    jest.useRealTimers();
  });

  test('records smartClickLastScale in playback status telemetry', () => {
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      windowManager: { getTargetBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) } as any,
    }) as any;

    engine.markSmartClickSource('region', 'template', 0.93, 4, 1.22);
    expect(engine.getStatus().smartClickLastScale).toBeCloseTo(1.22, 2);
  });

  test('seeds SmartClick recorded scale and hint from profile metadata', () => {
    const profile: Profile = {
      ...baseProfile,
      events: [
        {
          ...baseProfile.events[0],
          img_patch_b64: 'patch',
          metadata: {
            recorded_match_scale: 1.15,
          },
        },
      ],
    };

    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      windowManager: { getTargetBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) } as any,
    });
    const anyEngine = engine as any;

    anyEngine.initializeSmartClickScaleState(profile);
    anyEngine.status = anyEngine.createStatus('idle');

    expect(engine.getStatus().smartClickRecordedScale).toBeCloseTo(1.15, 2);
    expect(engine.getStatus().smartClickLastStableScale).toBeCloseTo(1.15, 2);
    expect(engine.getStatus().smartClickScaleHint).toBeCloseTo(1.15, 2);
  });

  test('adaptation mode resets scale state to recorded scale baseline', () => {
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      windowManager: { getTargetBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) } as any,
    }) as any;

    engine.smartClickRecordedScale = 1.25;
    engine.smartClickLastStableScale = 0.82;
    engine.smartClickScaleHint = 0.84;
    engine.enterSmartClickAdaptationMode();

    expect(engine.smartClickLastStableScale).toBeCloseTo(1.25, 2);
    expect(engine.smartClickScaleHint).toBeCloseTo(1.25, 2);
    expect(engine.getStatus().smartClickRecordedScale).toBeCloseTo(1.25, 2);
    expect(engine.getStatus().smartClickLastStableScale).toBeCloseTo(1.25, 2);
  });

  test('content-driven scale evidence enters adaptation and seeds hint from candidates', () => {
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      windowManager: { getTargetBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) } as any,
    }) as any;

    engine.smartClickRecordedScale = 1.0;
    engine.smartClickLastStableScale = 1.0;
    engine.smartClickScaleHint = 1.0;
    engine.status = engine.createStatus('idle');

    const candidates = [
      {
        x: 200,
        y: 100,
        confidence: 0.72,
        method: 'template',
        scale: 1.25,
        bounds: { x: 180, y: 80, width: 32, height: 32 },
      },
      {
        x: 205,
        y: 102,
        confidence: 0.69,
        method: 'template',
        scale: 1.24,
        bounds: { x: 184, y: 82, width: 32, height: 32 },
      },
    ];

    const suggestedScale = engine.maybeAdaptToScaleEvidence('target_window', candidates, 0.65, true);

    expect(suggestedScale).toBeCloseTo(1.25, 2);
    expect(engine.smartClickAdaptationClicksLeft).toBe(5);
    expect(engine.smartClickScaleHint).toBeCloseTo(1.25, 2);
    expect(engine.smartClickLastStableScale).toBeCloseTo(1.0, 2);
    expect(engine.getStatus().smartClickAdaptationReason).toBe('scale_shift_evidence');
  });

  test('pickBestSmartClickCandidate does not let stale anchor beat a better scaled match', async () => {
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      windowManager: { getTargetBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) } as any,
    }) as any;

    engine.smartClickRecordedScale = 1.0;
    engine.smartClickLastStableScale = 1.0;
    engine.smartClickScaleHint = 1.0;
    engine.smartClickAnchor = { dx: 5, dy: 0 };
    engine.smartClickAnchorTrust = 4;
    engine.status = engine.createStatus('idle');

    const picked = await engine.pickBestSmartClickCandidate(
      'target_window',
      'relaxed',
      {
        t_ms: 0,
        type: 'mouse',
        btn: 'left',
        x: 100,
        y: 100,
        rel_x: 0,
        rel_y: 0,
        duration_ms: 0,
        human_override: false,
      },
      { x: 100, y: 100 },
      [
        {
          x: 300,
          y: 100,
          confidence: 0.71,
          method: 'template',
          scale: 1.25,
          bounds: { x: 284, y: 84, width: 32, height: 32 },
        },
        {
          x: 105,
          y: 100,
          confidence: 0.7,
          method: 'template',
          scale: 1.0,
          bounds: { x: 89, y: 84, width: 32, height: 32 },
        },
      ],
      0.65,
      { x: 0, y: 0 },
      4,
      null
    );

    expect(picked?.coords).toEqual({ x: 300, y: 100 });
    expect(picked?.scale).toBeCloseTo(1.25, 2);
  });

  test('enters adaptation mode after two consecutive SmartClick failures', () => {
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      windowManager: { getTargetBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) } as any,
    }) as any;

    engine.smartClickRecordedScale = 1.0;
    engine.smartClickLastStableScale = 1.0;
    engine.smartClickScaleHint = 1.0;
    engine.status = engine.createStatus('idle');

    engine.registerSmartClickFailure();
    expect(engine.smartClickAdaptationClicksLeft).toBe(0);

    engine.registerSmartClickFailure();
    expect(engine.smartClickAdaptationClicksLeft).toBe(5);
    expect(engine.smartClickScaleHint).toBeCloseTo(1.0, 2);
    expect(engine.getStatus().smartClickAdaptationReason).toBe('failure_streak');
  });

  test('bounds change adaptation records explicit reason', () => {
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      windowManager: { getTargetBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) } as any,
    }) as any;

    engine.smartClickRecordedScale = 1.0;
    engine.smartClickLastStableScale = 1.0;
    engine.smartClickScaleHint = 1.0;
    engine.status = engine.createStatus('idle');

    engine.enterSmartClickAdaptationMode(undefined, 'bounds_change');

    expect(engine.getStatus().smartClickAdaptationReason).toBe('bounds_change');
  });

  test('SmartClick service outage falls back to recorded coords without aborting playback', async () => {
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('fake'));
    const matchImage = jest.fn().mockResolvedValue({ success: false, error: 'fetch failed' });
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: { matchImage } as any,
      windowManager: { getTargetBounds: () => ({ x: 0, y: 0, width: 200, height: 200 }) } as any,
    }) as any;

    engine.config = { ...config, useImageMatching: true, imageSearchRadius: 64 };
    engine.status = engine.createStatus('playing');

    const result = await engine.resolveSmartClick(
      {
        t_ms: 0,
        type: 'mouse',
        btn: 'left',
        x: 42,
        y: 84,
        rel_x: 0.2,
        rel_y: 0.4,
        duration_ms: 0,
        human_override: false,
        img_patch_b64: Buffer.from('template').toString('base64'),
      },
      { x: 42, y: 84 }
    );

    expect(result).toEqual({ x: 42, y: 84 });
    expect(matchImage).toHaveBeenCalledTimes(1);
    expect(engine.getStatus().failedMatches).toBe(1);
    expect(engine.getStatus().lastError).toBe('image_service_unavailable');
    expect(engine.getStatus().smartClickLastSource).toBe('service_unavailable_fallback');
    captureSpy.mockRestore();
  });

  test('ocr fallback resolves coords from recorded text anchor', async () => {
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('fake'));
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: {
        ocrImage: jest.fn().mockResolvedValue({
          success: true,
          processingTimeMs: 12,
          items: [
            {
              text: 'Submit',
              confidence: 91,
              bounds: { x: 40, y: 30, width: 80, height: 20 },
            },
          ],
        }),
      } as any,
      windowManager: { getTargetBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) } as any,
    }) as any;

    const picked = await engine.tryOcrSmartClickFallback(
      {
        t_ms: 0,
        type: 'mouse',
        btn: 'left',
        x: 0,
        y: 0,
        rel_x: 0,
        rel_y: 0,
        duration_ms: 0,
        human_override: false,
        metadata: {
          ocr_primary_text: 'Submit',
          ocr_primary_text_normalized: 'submit',
          ocr_anchor_norm_x: 0.25,
          ocr_anchor_norm_y: -0.5,
        },
      },
      { x: 100, y: 200, width: 400, height: 300 },
      { x: 170, y: 235 },
      0.6,
      400
    );

    expect(picked?.method).toBe('ocr');
    expect(picked?.coords).toEqual({ x: 200, y: 230 });
    captureSpy.mockRestore();
  });

  test('SmartClick clicks the visual match when the window moved and relative coords are off', async () => {
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('fake'));
    const movedWindow = { x: 500, y: 200, width: 800, height: 600 };
    const match = {
      x: 90,
      y: 70,
      confidence: 0.91,
      method: 'template' as const,
      scale: 1,
      bounds: { x: 74, y: 54, width: 32, height: 32 },
    };
    const moves: Array<{ x: number; y: number }> = [];
    const engine = new PlaybackEngine({
      inputPlayer: {
        moveMouse: (x: number, y: number) => moves.push({ x, y }),
        mouseDown: () => undefined,
        mouseUp: () => undefined,
        keyDown: () => undefined,
        keyUp: () => undefined,
      } as any,
      imageService: {
        matchImage: jest.fn().mockResolvedValue({
          success: true,
          matches: [match],
          bestMatch: match,
          processingTimeMs: 8,
        }),
      } as any,
      windowManager: {
        getTargetBounds: () => movedWindow,
      } as any,
    });

    const recorded = { x: 40, y: 30 };
    const event = {
      t_ms: 0,
      type: 'mouse' as const,
      btn: 'left' as const,
      x: recorded.x,
      y: recorded.y,
      rel_x: 0.05,
      rel_y: 0.05,
      duration_ms: 0,
      human_override: false,
      img_patch_b64: Buffer.from('template').toString('base64'),
    };
    (engine as any).config = {
      ...config,
      target: 'Terminal',
      useImageMatching: true,
      useRelativeCoords: false,
      imageMatchThreshold: 0.6,
    };
    (engine as any).status = (engine as any).createStatus('playing');
    const result = await (engine as any).resolveSmartClick(event, recorded);
    await (engine as any).executeAction(
      { t_ms: 0, type: 'mouseDown', event },
      result,
      0,
      0,
      0,
    );

    expect(moves).toEqual([{ x: movedWindow.x + match.x, y: movedWindow.y + match.y }]);
    expect(moves[0]).not.toEqual(recorded);
    captureSpy.mockRestore();
  });

  test('screen-target SmartClick uses a fullscreen match above 0.6 when the local region misses', async () => {
    const regionSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('region'));
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(Buffer.from('screen'));
    const far = {
      x: 800,
      y: 400,
      confidence: 0.91,
      method: 'template' as const,
      scale: 1,
      bounds: { x: 784, y: 384, width: 32, height: 32 },
    };
    const matchImage = jest.fn(async (request: { maxBudgetMs?: number }) => {
      if ((request.maxBudgetMs ?? 0) >= 80) {
        return { success: true, matches: [far], bestMatch: far, processingTimeMs: 12 };
      }
      return { success: true, matches: [], bestMatch: null, processingTimeMs: 4 };
    });
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: { matchImage } as any,
      windowManager: { getTargetBounds: () => null } as any,
    }) as any;
    const recorded = { x: 40, y: 30 };
    engine.config = {
      ...config,
      target: 'screen',
      useImageMatching: true,
      useRelativeCoords: false,
      imageMatchThreshold: 0.6,
    };
    engine.status = engine.createStatus('playing');

    const result = await engine.resolveSmartClick(
      {
        t_ms: 0,
        type: 'mouse',
        btn: 'left',
        x: recorded.x,
        y: recorded.y,
        rel_x: 0,
        rel_y: 0,
        duration_ms: 0,
        human_override: false,
        img_patch_b64: Buffer.from('template').toString('base64'),
      },
      recorded
    );

    expect(result).toEqual({ x: far.x, y: far.y });
    expect(result).not.toEqual(recorded);
    regionSpy.mockRestore();
    screenSpy.mockRestore();
  });

  test('a timed-out SmartClick keeps the anchor offset instead of the old point', async () => {
    jest.useFakeTimers();
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      windowManager: { getTargetBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) } as any,
    }) as any;
    engine.smartClickAnchor = { dx: 400, dy: 250 };
    engine.smartClickAnchorTrust = 3;
    engine.status = { ...engine.getStatus(), retries: 0 };
    engine.smartClickPromises.set(5, new Promise(() => {}));

    const pending = engine.getSmartClickCoords(
      5,
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
        img_patch_b64: 'x',
      },
      { x: 100, y: 200 }
    );
    await jest.advanceTimersByTimeAsync(300);
    const result = await pending;

    expect(result).toEqual({ x: 500, y: 450 });
    jest.useRealTimers();
  });

  test('a match that finishes after the click wait does not publish that confidence', async () => {
    jest.useFakeTimers();
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('fake'));
    const match = {
      x: 90,
      y: 70,
      confidence: 0.95,
      method: 'template' as const,
      scale: 1,
      bounds: { x: 74, y: 54, width: 32, height: 32 },
    };
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: {
        matchImage: jest.fn().mockResolvedValue({
          success: true,
          matches: [match],
          bestMatch: match,
          processingTimeMs: 4,
        }),
      } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 500, y: 200, width: 800, height: 600 }),
      } as any,
    }) as any;
    const telemetry = { open: true };
    engine.smartClickAnchor = { dx: 10, dy: 0 };
    engine.smartClickAnchorTrust = 3;
    engine.config = {
      ...config,
      target: 'Terminal',
      useImageMatching: true,
      useRelativeCoords: false,
      imageMatchThreshold: 0.6,
    };
    engine.status = engine.createStatus('playing');
    engine.smartClickPromises.set(5, new Promise(() => {}));
    engine.smartClickTelemetry.set(5, telemetry);
    const expected = { x: 100, y: 200 };
    const event = {
      t_ms: 0,
      type: 'mouse' as const,
      btn: 'left' as const,
      x: 40,
      y: 30,
      rel_x: 0,
      rel_y: 0,
      duration_ms: 0,
      human_override: false,
      img_patch_b64: Buffer.from('template').toString('base64'),
    };

    const pending = engine.getSmartClickCoords(5, event, expected);
    await jest.advanceTimersByTimeAsync(300);
    const clicked = await pending;

    expect(clicked).toEqual({ x: 110, y: 200 });
    expect(telemetry.open).toBe(false);

    await engine.resolveSmartClick(event, expected, true, telemetry);

    expect(engine.getStatus().successfulMatches).toBe(0);
    expect(engine.getStatus().failedMatches).toBe(0);
    expect(engine.getStatus().smartClickLastConfidence).toBeUndefined();
    captureSpy.mockRestore();
    jest.useRealTimers();
  });

  test('a 0.66 region match is the click and a 0.55 match is not', async () => {
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('region'));
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(Buffer.from('screen'));
    const expected = { x: 400, y: 300 };
    const event = {
      t_ms: 0,
      type: 'mouse' as const,
      btn: 'left' as const,
      x: expected.x,
      y: expected.y,
      rel_x: 0,
      rel_y: 0,
      duration_ms: 0,
      human_override: false,
      img_patch_b64: Buffer.from('template').toString('base64'),
    };
    const local = { x: 50, y: 40 };
    const run = async (confidence: number) => {
      const match = {
        x: local.x,
        y: local.y,
        confidence,
        method: 'template' as const,
        scale: 1,
        bounds: { x: 34, y: 24, width: 32, height: 32 },
      };
      const matchImage = jest.fn().mockResolvedValue({
        success: true,
        matches: [match],
        bestMatch: match,
        processingTimeMs: 6,
      });
      const engine = new PlaybackEngine({
        inputPlayer: {} as any,
        imageService: { matchImage } as any,
        windowManager: { getTargetBounds: () => null } as any,
      }) as any;
      engine.config = {
        ...config,
        target: 'screen',
        useImageMatching: true,
        useRelativeCoords: false,
        imageMatchThreshold: 0.6,
        imageSearchRadius: 100,
      };
      engine.status = engine.createStatus('playing');
      const result = await engine.resolveSmartClick(event, expected);
      return { result, engine, matchImage };
    };

    const accepted = await run(0.66);
    expect(accepted.result).toEqual({ x: 350, y: 240 });
    expect(accepted.engine.getStatus().smartClickLastConfidence).toBeCloseTo(0.66);
    expect(accepted.engine.getStatus().smartClickLastSource).toBe('region');
    expect(accepted.engine.getStatus().smartClickRegionMinConfidence).toBeCloseTo(0.6);
    expect(accepted.engine.getStatus().smartClickFullscreenMinConfidence).toBeCloseTo(0.6);
    expect(accepted.matchImage.mock.calls[0][0].minScale).toBeCloseTo(0.7);
    expect(accepted.matchImage.mock.calls[0][0].maxScale).toBeCloseTo(1.4);

    const rejected = await run(0.55);
    expect(rejected.result).toEqual(expected);
    expect(rejected.engine.getStatus().successfulMatches).toBe(0);
    expect(rejected.engine.getStatus().smartClickLastConfidence).toBeUndefined();

    captureSpy.mockRestore();
    screenSpy.mockRestore();
  });

  test('playback clicks a 0.66 match in the moved window', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2020-01-01T00:00:00Z'));
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('fake'));
    const moves: Array<{ x: number; y: number }> = [];
    const match = {
      x: 90,
      y: 70,
      confidence: 0.66,
      method: 'template' as const,
      scale: 1,
      bounds: { x: 74, y: 54, width: 32, height: 32 },
    };
    const engine = new PlaybackEngine({
      inputPlayer: {
        moveMouse: (x: number, y: number) => moves.push({ x, y }),
        mouseDown: () => undefined,
        mouseUp: () => undefined,
        keyDown: () => undefined,
        keyUp: () => undefined,
      } as any,
      imageService: {
        matchImage: jest.fn().mockResolvedValue({
          success: true,
          matches: [match],
          bestMatch: match,
          processingTimeMs: 5,
        }),
      } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 500, y: 200, width: 800, height: 600 }),
      } as any,
    });
    const profile: Profile = {
      ...baseProfile,
      target_app: 'Terminal',
      events: [
        {
          t_ms: 0,
          type: 'mouse',
          btn: 'left',
          x: 40,
          y: 30,
          rel_x: 0.05,
          rel_y: 0.05,
          duration_ms: 0,
          human_override: false,
          img_patch_b64: Buffer.from('template').toString('base64'),
        },
      ],
    };

    await engine.start(
      {
        ...config,
        target: 'Terminal',
        useImageMatching: true,
        useRelativeCoords: false,
        imageMatchThreshold: 0.6,
      },
      profile
    );
    await jest.advanceTimersByTimeAsync(500);

    expect(moves[0]).toEqual({ x: 590, y: 270 });
    captureSpy.mockRestore();
    await engine.stop();
    jest.useRealTimers();
  });

  test('a context feature match clicks only when confidence clears 0.6', async () => {
    const regionSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('region'));
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(Buffer.from('screen'));
    const expected = { x: 40, y: 30 };
    const event = {
      t_ms: 0,
      type: 'mouse' as const,
      btn: 'left' as const,
      x: expected.x,
      y: expected.y,
      rel_x: 0,
      rel_y: 0,
      duration_ms: 0,
      human_override: false,
      img_patch_b64: Buffer.from('template').toString('base64'),
      img_context_b64: Buffer.from('context').toString('base64'),
    };
    const run = async (confidence: number) => {
      const feature = {
        x: 40,
        y: 30,
        confidence,
        method: 'feature' as const,
        scale: 1,
        homography_ok: true,
        inliers: 12,
        bounds: { x: 20, y: 10, width: 40, height: 40 },
      };
      const matchImage = jest.fn(async (request: { method?: string; threshold?: number }) => {
        if (request.method === 'feature') {
          return { success: true, matches: [feature], bestMatch: feature, processingTimeMs: 8 };
        }
        return { success: true, matches: [], bestMatch: null, processingTimeMs: 3 };
      });
      const engine = new PlaybackEngine({
        inputPlayer: {} as any,
        imageService: { matchImage } as any,
        windowManager: {
          getTargetBounds: () => ({ x: 500, y: 200, width: 800, height: 600 }),
          getTargetBoundsAsync: async () => ({ x: 500, y: 200, width: 800, height: 600 }),
        } as any,
      }) as any;
      engine.config = {
        ...config,
        target: 'Terminal',
        useImageMatching: true,
        useRelativeCoords: false,
        imageMatchThreshold: 0.6,
      };
      engine.status = engine.createStatus('playing');
      const result = await engine.resolveSmartClick(event, expected);
      const featureRequest = matchImage.mock.calls.map(call => call[0]).find(request => request.method === 'feature');
      return { result, engine, featureRequest };
    };

    const accepted = await run(0.66);
    expect(accepted.featureRequest?.threshold).toBeGreaterThanOrEqual(0.6);
    expect(accepted.result).toEqual({ x: 540, y: 230 });
    expect(accepted.engine.getStatus().smartClickLastConfidence).toBeCloseTo(0.66);

    const rejected = await run(0.55);
    expect(rejected.result).toEqual(expected);
    expect(rejected.engine.getStatus().successfulMatches).toBe(0);

    regionSpy.mockRestore();
    screenSpy.mockRestore();
  });

  test('a 0.66 feature match without homography still clicks the window', async () => {
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('fake'));
    const match = {
      x: 90,
      y: 70,
      confidence: 0.66,
      method: 'feature' as const,
      scale: 1,
      bounds: { x: 74, y: 54, width: 32, height: 32 },
    };
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: {
        matchImage: jest.fn().mockResolvedValue({
          success: true,
          matches: [match],
          bestMatch: match,
          processingTimeMs: 6,
        }),
      } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 500, y: 200, width: 800, height: 600 }),
        getTargetBoundsAsync: async () => ({ x: 500, y: 200, width: 800, height: 600 }),
      } as any,
    }) as any;
    engine.config = {
      ...config,
      target: 'Terminal',
      useImageMatching: true,
      useRelativeCoords: false,
      imageMatchThreshold: 0.6,
    };
    engine.status = engine.createStatus('playing');

    const result = await engine.resolveSmartClick(
      {
        t_ms: 0,
        type: 'mouse',
        btn: 'left',
        x: 40,
        y: 30,
        rel_x: 0,
        rel_y: 0,
        duration_ms: 0,
        human_override: false,
        img_patch_b64: Buffer.from('template').toString('base64'),
      },
      { x: 40, y: 30 }
    );

    expect(result).toEqual({ x: 590, y: 270 });
    expect(engine.getStatus().smartClickLastConfidence).toBeCloseTo(0.66);
    captureSpy.mockRestore();
  });

  test('a miss retries inside the click budget and then uses the visual match', async () => {
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('region'));
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(Buffer.from('screen'));
    const match = {
      x: 90,
      y: 70,
      confidence: 0.91,
      method: 'template' as const,
      scale: 1,
      bounds: { x: 74, y: 54, width: 32, height: 32 },
    };
    let calls = 0;
    const matchImage = jest.fn(async () => {
      calls += 1;
      if (calls < 4) {
        return { success: true, matches: [], bestMatch: null, processingTimeMs: 2 };
      }
      return { success: true, matches: [match], bestMatch: match, processingTimeMs: 4 };
    });
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: { matchImage } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 500, y: 200, width: 800, height: 600 }),
        getTargetBoundsAsync: async () => ({ x: 500, y: 200, width: 800, height: 600 }),
      } as any,
    }) as any;
    engine.config = {
      ...config,
      target: 'Terminal',
      useImageMatching: true,
      useRelativeCoords: false,
      imageMatchThreshold: 0.6,
      retryCount: 1,
    };
    engine.status = engine.createStatus('playing');

    const result = await engine.resolveSmartClick(
      {
        t_ms: 0,
        type: 'mouse',
        btn: 'left',
        x: 40,
        y: 30,
        rel_x: 0,
        rel_y: 0,
        duration_ms: 0,
        human_override: false,
        img_patch_b64: Buffer.from('template').toString('base64'),
      },
      { x: 40, y: 30 }
    );

    expect(result).toEqual({ x: 590, y: 270 });
    expect(engine.getStatus().retries).toBe(1);
    expect(engine.getStatus().failedMatches).toBe(0);
    captureSpy.mockRestore();
    screenSpy.mockRestore();
  });

  test('a miss does not retry after the click budget is gone', async () => {
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('region'));
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(Buffer.from('screen'));
    let now = 1_000;
    const matchImage = jest.fn(async () => {
      now += 300;
      return { success: true, matches: [], bestMatch: null, processingTimeMs: 2 };
    });
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: { matchImage } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 500, y: 200, width: 800, height: 600 }),
        getTargetBoundsAsync: async () => ({ x: 500, y: 200, width: 800, height: 600 }),
      } as any,
      clock: {
        now: () => now,
        setTimeout: (handler, timeout) => setTimeout(handler, timeout ?? 0),
        clearTimeout: (handle) => clearTimeout(handle),
      },
    }) as any;
    engine.config = {
      ...config,
      target: 'Terminal',
      useImageMatching: true,
      useRelativeCoords: false,
      imageMatchThreshold: 0.6,
      retryCount: 2,
    };
    engine.status = engine.createStatus('playing');

    const result = await engine.resolveSmartClick(
      {
        t_ms: 0,
        type: 'mouse',
        btn: 'left',
        x: 40,
        y: 30,
        rel_x: 0,
        rel_y: 0,
        duration_ms: 0,
        human_override: false,
        img_patch_b64: Buffer.from('template').toString('base64'),
      },
      { x: 40, y: 30 }
    );

    expect(result).toEqual({ x: 40, y: 30 });
    expect(matchImage).toHaveBeenCalledTimes(1);
    expect(engine.getStatus().retries).toBe(0);
    captureSpy.mockRestore();
    screenSpy.mockRestore();
  });

  test('a match publishes source, confidence, dHash, and anchor', async () => {
    const sharp = require('sharp');
    const patch = await sharp({
      create: {
        width: 128,
        height: 128,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    })
      .png()
      .toBuffer();
    const recordedHash = await computeDHash(patch);
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(patch);
    const match = {
      x: 64,
      y: 64,
      confidence: 0.91,
      method: 'template' as const,
      scale: 1,
      bounds: { x: 48, y: 48, width: 32, height: 32 },
    };
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: {
        matchImage: jest.fn().mockResolvedValue({
          success: true,
          matches: [match],
          bestMatch: match,
          processingTimeMs: 4,
        }),
      } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 100, y: 80, width: 400, height: 300 }),
        getTargetBoundsAsync: async () => ({ x: 100, y: 80, width: 400, height: 300 }),
      } as any,
    }) as any;
    engine.config = {
      ...config,
      target: 'Terminal',
      useImageMatching: true,
      useRelativeCoords: false,
      imageMatchThreshold: 0.6,
    };
    engine.status = engine.createStatus('playing');

    const result = await engine.resolveSmartClick(
      {
        t_ms: 0,
        type: 'mouse',
        btn: 'left',
        x: 100,
        y: 80,
        rel_x: 0,
        rel_y: 0,
        duration_ms: 0,
        human_override: false,
        img_patch_b64: patch.toString('base64'),
        metadata: { img_dhash: recordedHash },
      },
      { x: 100, y: 80 }
    );

    const status = engine.getStatus();
    expect(result).toEqual({ x: 164, y: 144 });
    expect(status.smartClickLastSource).toBe('window');
    expect(status.smartClickLastConfidence).toBeCloseTo(0.91);
    expect(status.smartClickLastDHashDistance).toBe(0);
    expect(status.smartClickAnchorDx).toBe(64);
    expect(status.smartClickAnchorDy).toBe(64);
    captureSpy.mockRestore();
  });

  test('an out-of-range feature scale does not become the click', async () => {
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('region'));
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(Buffer.from('screen'));
    const template = {
      x: 90,
      y: 70,
      confidence: 0.91,
      method: 'template' as const,
      scale: 0.7,
      bounds: { x: 50, y: 30, width: 80, height: 80 },
    };
    const feature = {
      x: 18,
      y: 238,
      confidence: 0.83,
      method: 'feature' as const,
      scale: 4.34,
      homography_ok: true,
      inliers: 20,
      bounds: { x: 0, y: 200, width: 40, height: 40 },
    };
    const expected = { x: 40, y: 30 };
    const event = {
      t_ms: 0,
      type: 'mouse' as const,
      btn: 'left' as const,
      x: expected.x,
      y: expected.y,
      rel_x: 0,
      rel_y: 0,
      duration_ms: 0,
      human_override: false,
      img_patch_b64: Buffer.from('template').toString('base64'),
    };
    const run = async (matches: Array<typeof template | typeof feature>, bestMatch: typeof template | typeof feature) => {
      const engine = new PlaybackEngine({
        inputPlayer: {} as any,
        imageService: {
          matchImage: jest.fn().mockResolvedValue({
            success: true,
            matches,
            bestMatch,
            processingTimeMs: 8,
          }),
        } as any,
        windowManager: {
          getTargetBounds: () => ({ x: 500, y: 200, width: 520, height: 360 }),
          getTargetBoundsAsync: async () => ({ x: 500, y: 200, width: 520, height: 360 }),
        } as any,
      }) as any;
      engine.config = {
        ...config,
        target: 'Terminal',
        useImageMatching: true,
        useRelativeCoords: false,
        imageMatchThreshold: 0.6,
      };
      engine.status = engine.createStatus('playing');
      const result = await engine.resolveSmartClick(event, expected);
      return { result, engine };
    };

    const kept = await run([feature, template], feature);
    expect(kept.result).toEqual({ x: 590, y: 270 });
    expect(kept.engine.getStatus().smartClickLastMethod).toBe('template');
    expect(kept.engine.getStatus().smartClickLastScale).toBeCloseTo(0.7);

    const rejected = await run([feature], feature);
    expect(rejected.result).toEqual(expected);
    expect(rejected.engine.getStatus().successfulMatches).toBe(0);

    captureSpy.mockRestore();
    screenSpy.mockRestore();
  });

  test('recorded text moves the click before the image budget is gone', async () => {
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('region'));
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(Buffer.from('screen'));
    let now = 0;
    const matchImage = jest.fn(async () => {
      now += 90;
      return { success: true, matches: [], bestMatch: null, processingTimeMs: 90 };
    });
    const ocrImage = jest.fn().mockResolvedValue({
      success: true,
      processingTimeMs: 12,
      items: [
        {
          text: 'Submit',
          confidence: 91,
          bounds: { x: 40, y: 30, width: 80, height: 20 },
        },
      ],
    });
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: { matchImage, ocrImage } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 500, y: 200, width: 800, height: 600 }),
        getTargetBoundsAsync: async () => ({ x: 500, y: 200, width: 800, height: 600 }),
      } as any,
      clock: {
        now: () => now,
        setTimeout: (handler, timeout) => setTimeout(handler, timeout),
        clearTimeout: (handle) => clearTimeout(handle),
      },
    }) as any;
    engine.config = {
      ...config,
      target: 'Terminal',
      useImageMatching: true,
      useRelativeCoords: false,
      imageMatchThreshold: 0.6,
      retryCount: 0,
    };
    engine.status = engine.createStatus('playing');
    const expected = { x: 40, y: 30 };

    const result = await engine.resolveSmartClick(
      {
        t_ms: 0,
        type: 'mouse',
        btn: 'left',
        x: expected.x,
        y: expected.y,
        rel_x: 0,
        rel_y: 0,
        duration_ms: 0,
        human_override: false,
        img_patch_b64: Buffer.from('template').toString('base64'),
        metadata: {
          ocr_primary_text_normalized: 'submit',
          ocr_anchor_norm_x: 0.25,
          ocr_anchor_norm_y: -0.5,
        },
      },
      expected
    );

    expect(result).toEqual({ x: 600, y: 230 });
    expect(matchImage).toHaveBeenCalledTimes(2);
    expect(ocrImage).toHaveBeenCalledTimes(1);
    expect(engine.getStatus().smartClickLastMethod).toBe('ocr');
    expect(engine.getStatus().smartClickLastConfidence).toBeGreaterThan(0.6);
    captureSpy.mockRestore();
    screenSpy.mockRestore();
  });

  test('a nearby image match beats a different copy of the recorded text', async () => {
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('region'));
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(Buffer.from('screen'));
    const regionMatch = {
      x: 90,
      y: 70,
      confidence: 0.91,
      method: 'template' as const,
      scale: 1,
      bounds: { x: 74, y: 54, width: 32, height: 32 },
    };
    let calls = 0;
    const matchImage = jest.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return { success: true, matches: [], bestMatch: null, processingTimeMs: 8 };
      }
      return { success: true, matches: [regionMatch], bestMatch: regionMatch, processingTimeMs: 8 };
    });
    const ocrImage = jest.fn().mockResolvedValue({
      success: true,
      processingTimeMs: 12,
      items: [
        {
          text: 'Submit',
          confidence: 99,
          bounds: { x: 10, y: 10, width: 40, height: 16 },
        },
      ],
    });
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: { matchImage, ocrImage } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 500, y: 200, width: 800, height: 600 }),
        getTargetBoundsAsync: async () => ({ x: 500, y: 200, width: 800, height: 600 }),
      } as any,
    }) as any;
    engine.config = {
      ...config,
      target: 'Terminal',
      useImageMatching: true,
      useRelativeCoords: false,
      imageMatchThreshold: 0.6,
      imageSearchRadius: 320,
      retryCount: 0,
    };
    engine.status = engine.createStatus('playing');

    const result = await engine.resolveSmartClick(
      {
        t_ms: 0,
        type: 'mouse',
        btn: 'left',
        x: 40,
        y: 30,
        rel_x: 0,
        rel_y: 0,
        duration_ms: 0,
        human_override: false,
        img_patch_b64: Buffer.from('template').toString('base64'),
        metadata: {
          ocr_primary_text_normalized: 'submit',
          ocr_anchor_norm_x: 0,
          ocr_anchor_norm_y: 0,
        },
      },
      { x: 40, y: 30 }
    );

    expect(result).toEqual({ x: 90, y: 70 });
    expect(ocrImage).not.toHaveBeenCalled();
    expect(engine.getStatus().smartClickLastSource).toBe('region');
    captureSpy.mockRestore();
    screenSpy.mockRestore();
  });

  test('a context feature match runs before fullscreen spends the click budget', async () => {
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('region'));
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(Buffer.from('screen'));
    let now = 0;
    const feature = {
      x: 40,
      y: 30,
      confidence: 0.66,
      method: 'feature' as const,
      scale: 1,
      homography_ok: true,
      inliers: 12,
      bounds: { x: 20, y: 10, width: 40, height: 40 },
    };
    const matchImage = jest.fn(async (request: { method?: string }) => {
      if (request.method === 'feature') {
        return { success: true, matches: [feature], bestMatch: feature, processingTimeMs: 8 };
      }
      now += 100;
      return { success: true, matches: [], bestMatch: null, processingTimeMs: 100 };
    });
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: { matchImage } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 500, y: 200, width: 800, height: 600 }),
        getTargetBoundsAsync: async () => ({ x: 500, y: 200, width: 800, height: 600 }),
      } as any,
      clock: {
        now: () => now,
        setTimeout: (handler, timeout) => setTimeout(handler, timeout),
        clearTimeout: (handle) => clearTimeout(handle),
      },
    }) as any;
    engine.config = {
      ...config,
      target: 'Terminal',
      useImageMatching: true,
      useRelativeCoords: false,
      imageMatchThreshold: 0.6,
      retryCount: 0,
    };
    engine.status = engine.createStatus('playing');

    const result = await engine.resolveSmartClick(
      {
        t_ms: 0,
        type: 'mouse',
        btn: 'left',
        x: 40,
        y: 30,
        rel_x: 0,
        rel_y: 0,
        duration_ms: 0,
        human_override: false,
        img_patch_b64: Buffer.from('template').toString('base64'),
        img_context_b64: Buffer.from('context').toString('base64'),
      },
      { x: 40, y: 30 }
    );

    expect(result).toEqual({ x: 540, y: 230 });
    expect(matchImage.mock.calls.filter(call => call[0].method !== 'feature')).toHaveLength(2);
    expect(matchImage.mock.calls.some(call => call[0].method === 'feature')).toBe(true);
    expect(engine.getStatus().smartClickLastConfidence).toBeCloseTo(0.66);
    captureSpy.mockRestore();
    screenSpy.mockRestore();
  });

  test('a live window lookup inside the click budget clicks the moved window', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2020-01-01T00:00:00Z'));
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('fake'));
    const match = {
      x: 90,
      y: 70,
      confidence: 0.91,
      method: 'template' as const,
      scale: 1,
      bounds: { x: 74, y: 54, width: 32, height: 32 },
    };
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: {
        matchImage: jest.fn().mockResolvedValue({
          success: true,
          matches: [match],
          bestMatch: match,
          processingTimeMs: 5,
        }),
      } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 500, y: 200, width: 800, height: 600 }),
        getTargetBoundsAsync: () => new Promise((resolve) => {
          setTimeout(() => resolve({ x: 800, y: 100, width: 800, height: 600 }), 180);
        }),
      } as any,
    }) as any;
    engine.config = {
      ...config,
      target: 'Terminal',
      useImageMatching: true,
      useRelativeCoords: false,
      imageMatchThreshold: 0.6,
    };
    engine.status = engine.createStatus('playing');
    const pending = engine.resolveSmartClick(
      {
        t_ms: 0,
        type: 'mouse',
        btn: 'left',
        x: 40,
        y: 30,
        rel_x: 0,
        rel_y: 0,
        duration_ms: 0,
        human_override: false,
        img_patch_b64: Buffer.from('template').toString('base64'),
      },
      { x: 40, y: 30 }
    );
    await jest.advanceTimersByTimeAsync(180);
    await expect(pending).resolves.toEqual({ x: 890, y: 170 });
    expect(captureSpy.mock.calls[0][0]).toEqual(expect.objectContaining({ x: 800, y: 100 }));
    expect(engine.getStatus().smartClickLastSource).toBe('window');
    expect(engine.getStatus().smartClickLastConfidence).toBeGreaterThan(0.6);
    captureSpy.mockRestore();
    jest.useRealTimers();
  });

  test('a window lookup that misses the click budget does not search the stale rectangle', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2020-01-01T00:00:00Z'));
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('fake'));
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(Buffer.from('screen'));
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: {
        matchImage: jest.fn().mockResolvedValue({
          success: true,
          matches: [],
          bestMatch: null,
          processingTimeMs: 4,
        }),
      } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 500, y: 200, width: 800, height: 600 }),
        getTargetBoundsAsync: () => new Promise((resolve) => {
          setTimeout(() => resolve({ x: 800, y: 100, width: 800, height: 600 }), 400);
        }),
      } as any,
    }) as any;
    engine.config = {
      ...config,
      target: 'Terminal',
      useImageMatching: true,
      useRelativeCoords: false,
      imageMatchThreshold: 0.6,
    };
    engine.status = engine.createStatus('playing');
    const pending = engine.resolveSmartClick(
      {
        t_ms: 0,
        type: 'mouse',
        btn: 'left',
        x: 40,
        y: 30,
        rel_x: 0,
        rel_y: 0,
        duration_ms: 0,
        human_override: false,
        img_patch_b64: Buffer.from('template').toString('base64'),
      },
      { x: 40, y: 30 }
    );
    await jest.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toEqual({ x: 40, y: 30 });
    expect(captureSpy.mock.calls.some(call => call[0]?.x === 500 && call[0]?.y === 200)).toBe(false);
    expect(engine.getStatus().successfulMatches).toBe(0);
    captureSpy.mockRestore();
    screenSpy.mockRestore();
    jest.useRealTimers();
  });
});
