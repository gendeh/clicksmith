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

    await jest.advanceTimersByTimeAsync(500);
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

    engine.config = { ...config, useImageMatching: true, useRelativeCoords: false, imageSearchRadius: 64 };
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
    let now = 5_000;
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: { matchImage } as any,
      windowManager: { getTargetBounds: () => null } as any,
      clock: {
        now: () => now,
        setTimeout: (handler: () => void, timeout: number) => setTimeout(handler, timeout),
        clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
      },
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
    expect(matchImage.mock.calls[0][0].maxBudgetMs).toBe(260);
    regionSpy.mockRestore();
    screenSpy.mockRestore();
  });

  test('a screen target clicks the recorded word when the patch is gone', async () => {
    const regionSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('region'));
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(Buffer.from('screen'));
    const ocrImage = jest.fn().mockResolvedValue({
      success: true,
      processingTimeMs: 12,
      items: [
        {
          text: 'Submit',
          confidence: 96,
          bounds: { x: 200, y: 80, width: 80, height: 20 },
        },
      ],
    });
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: {
        matchImage: jest.fn().mockResolvedValue({
          success: false,
          matches: [],
          bestMatch: null,
          processingTimeMs: 4,
        }),
        ocrImage,
      } as any,
      windowManager: { getTargetBounds: () => null, getTargetBoundsAsync: async () => null } as any,
    }) as any;
    engine.config = {
      ...config,
      target: 'screen',
      useImageMatching: true,
      useRelativeCoords: false,
      imageMatchThreshold: 0.6,
      retryCount: 0,
    };
    engine.status = engine.createStatus('playing');

    const result = await engine.resolveSmartClick(
      {
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
        metadata: { ocr_primary_text_normalized: 'submit' },
      },
      { x: 40, y: 30 }
    );

    expect(ocrImage).toHaveBeenCalledTimes(1);
    expect(ocrImage.mock.calls[0][0].image).toBe(Buffer.from('region').toString('base64'));
    expect(regionSpy).toHaveBeenCalledTimes(1);
    const captured = regionSpy.mock.calls[0][0];
    expect(captured.width).toBeLessThanOrEqual(640);
    expect(captured.height).toBeLessThanOrEqual(640);
    expect(captured.x).toBeLessThanOrEqual(240);
    expect(captured.x + captured.width).toBeGreaterThanOrEqual(240);
    expect(captured.y).toBeLessThanOrEqual(90);
    expect(captured.y + captured.height).toBeGreaterThanOrEqual(90);
    expect(screenSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ x: 240, y: 90 });
    expect(engine.getStatus().smartClickLastMethod).toBe('ocr');
    expect(engine.getStatus().smartClickLastSource).toBe('region');
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
    await jest.advanceTimersByTimeAsync(500);
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
    await jest.advanceTimersByTimeAsync(500);
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
      const matchImage = jest.fn(async (request: { method?: string; threshold?: number; minScale?: number; maxScale?: number }) => {
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
    expect(accepted.featureRequest?.minScale).toBeCloseTo(0.7);
    expect(accepted.featureRequest?.maxScale).toBeCloseTo(1.4);
    expect(accepted.result).toEqual({ x: 540, y: 230 });
    expect(accepted.engine.getStatus().smartClickLastConfidence).toBeCloseTo(0.66);

    const rejected = await run(0.55);
    expect(rejected.result).toEqual(expected);
    expect(rejected.engine.getStatus().successfulMatches).toBe(0);

    regionSpy.mockRestore();
    screenSpy.mockRestore();
  });

  test('a feature match without homography stays on the recorded point', async () => {
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

    expect(result).toEqual({ x: 40, y: 30 });
    expect(engine.getStatus().smartClickLastConfidence).toBeUndefined();
    expect(engine.getStatus().successfulMatches).toBe(0);
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

  test('a slow window lookup leaves the full match budget', async () => {
    let now = 5_000;
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('fake'));
    const match = {
      x: 90,
      y: 70,
      confidence: 0.91,
      method: 'template' as const,
      scale: 1,
      bounds: { x: 74, y: 54, width: 32, height: 32 },
    };
    const matchImage = jest.fn().mockResolvedValue({
      success: true,
      matches: [match],
      bestMatch: match,
      processingTimeMs: 5,
    });
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: { matchImage } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 500, y: 200, width: 800, height: 600 }),
        getTargetBoundsAsync: async () => {
          now += 180;
          return { x: 800, y: 100, width: 800, height: 600 };
        },
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
    };
    engine.status = engine.createStatus('playing');

    const result = await engine.resolveSmartClick(
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
      { x: 40, y: 30 }
    );

    expect(result).toEqual({ x: 890, y: 170 });
    expect(matchImage.mock.calls[0][0].maxBudgetMs).toBe(260);
    captureSpy.mockRestore();
  });

  test('a window match slower than 80ms still clicks the patch', async () => {
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('window'));
    const match = {
      x: 90,
      y: 70,
      confidence: 0.91,
      method: 'template' as const,
      scale: 1,
      bounds: { x: 74, y: 54, width: 32, height: 32 },
    };
    const matchImage = jest.fn().mockResolvedValue({
      success: true,
      matches: [match],
      bestMatch: match,
      processingTimeMs: 140,
    });
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: { matchImage } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 800, y: 100, width: 800, height: 600 }),
        getTargetBoundsAsync: async () => ({ x: 800, y: 100, width: 800, height: 600 }),
      } as any,
    }) as any;
    engine.config = {
      ...config,
      target: 'Terminal',
      useImageMatching: true,
      useRelativeCoords: true,
      imageMatchThreshold: 0.6,
    };
    engine.status = engine.createStatus('playing');

    const result = await engine.resolveSmartClick(
      {
        t_ms: 0,
        type: 'mouse',
        btn: 'left',
        x: 540,
        y: 230,
        rel_x: 0.05,
        rel_y: 0.05,
        duration_ms: 0,
        human_override: false,
        img_patch_b64: Buffer.from('template').toString('base64'),
      },
      { x: 540, y: 230 }
    );

    const request = matchImage.mock.calls[0][0];
    expect(request.maxBudgetMs).toBeGreaterThanOrEqual(140);
    expect(request.timeoutMs).toBeGreaterThanOrEqual(140);
    expect(result).toEqual({ x: 890, y: 170 });
    captureSpy.mockRestore();
  });

  test('a template miss that spends the image budget still clicks recorded text', async () => {
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('region'));
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(Buffer.from('screen'));
    let now = 0;
    const matchImage = jest.fn(async (request: { maxBudgetMs?: number; timeoutMs?: number }) => {
      now += request.maxBudgetMs ?? 0;
      return {
        success: false,
        matches: [],
        bestMatch: null,
        processingTimeMs: request.maxBudgetMs ?? 0,
        error: 'The operation was aborted',
      };
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
        setTimeout: (handler: () => void, timeout: number) => setTimeout(handler, timeout),
        clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
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
        metadata: {
          ocr_primary_text_normalized: 'submit',
          ocr_anchor_norm_x: 0.25,
          ocr_anchor_norm_y: -0.5,
        },
      },
      { x: 40, y: 30 }
    );

    expect(matchImage).toHaveBeenCalledTimes(1);
    expect(matchImage.mock.calls[0][0].maxBudgetMs).toBe(140);
    expect(matchImage.mock.calls[0][0].timeoutMs).toBe(140);
    expect(ocrImage).toHaveBeenCalledTimes(1);
    expect(ocrImage.mock.calls[0][0].timeoutMs).toBeGreaterThanOrEqual(120);
    expect(result).toEqual({ x: 600, y: 230 });
    expect(engine.getStatus().smartClickLastMethod).toBe('ocr');
    expect(engine.getStatus().smartClickLastConfidence).toBeGreaterThan(0.6);
    captureSpy.mockRestore();
    screenSpy.mockRestore();
  });

  test('a template miss that overruns the image cap still gives the word its reserve', async () => {
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('region'));
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(Buffer.from('screen'));
    let now = 0;
    const matchImage = jest.fn(async () => {
      now += 180;
      return {
        success: false,
        matches: [],
        bestMatch: null,
        processingTimeMs: 180,
        error: 'The operation was aborted',
      };
    });
    const ocrImage = jest.fn().mockResolvedValue({
      success: true,
      processingTimeMs: 90,
      items: [
        {
          text: 'Submit',
          confidence: 96,
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
        setTimeout: (handler: () => void, timeout: number) => setTimeout(handler, timeout),
        clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
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
        type: 'mouse' as const,
        btn: 'left' as const,
        x: 40,
        y: 30,
        rel_x: 0,
        rel_y: 0,
        duration_ms: 0,
        human_override: false,
        img_patch_b64: Buffer.from('template').toString('base64'),
        metadata: { ocr_primary_text_normalized: 'submit' },
      },
      { x: 40, y: 30 }
    );

    expect(ocrImage).toHaveBeenCalledTimes(1);
    expect(ocrImage.mock.calls[0][0].timeoutMs).toBeGreaterThanOrEqual(120);
    expect(result).toEqual({ x: 580, y: 240 });
    expect(engine.getStatus().smartClickLastMethod).toBe('ocr');
    captureSpy.mockRestore();
    screenSpy.mockRestore();
  });

  test('a 140ms window hit with recorded text still clicks the patch', async () => {
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('window'));
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(Buffer.from('screen'));
    let now = 0;
    const match = {
      x: 90,
      y: 70,
      confidence: 0.91,
      method: 'template' as const,
      scale: 1,
      bounds: { x: 74, y: 54, width: 32, height: 32 },
    };
    const matchImage = jest.fn(async (_request: { maxBudgetMs?: number; timeoutMs?: number }) => {
      now += 140;
      return { success: true, matches: [match], bestMatch: match, processingTimeMs: 140 };
    });
    const ocrImage = jest.fn();
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: { matchImage, ocrImage } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 800, y: 100, width: 800, height: 600 }),
        getTargetBoundsAsync: async () => ({ x: 800, y: 100, width: 800, height: 600 }),
      } as any,
      clock: {
        now: () => now,
        setTimeout: (handler: () => void, timeout: number) => setTimeout(handler, timeout),
        clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
      },
    }) as any;
    engine.config = {
      ...config,
      target: 'Terminal',
      useImageMatching: true,
      useRelativeCoords: true,
      imageMatchThreshold: 0.6,
      retryCount: 0,
    };
    engine.status = engine.createStatus('playing');

    const result = await engine.resolveSmartClick(
      {
        t_ms: 0,
        type: 'mouse',
        btn: 'left',
        x: 540,
        y: 230,
        rel_x: 0.05,
        rel_y: 0.05,
        duration_ms: 0,
        human_override: false,
        img_patch_b64: Buffer.from('template').toString('base64'),
        metadata: {
          ocr_primary_text_normalized: 'submit',
        },
      },
      { x: 540, y: 230 }
    );

    const request = matchImage.mock.calls[0][0];
    expect(request.maxBudgetMs).toBe(140);
    expect(request.timeoutMs).toBeGreaterThanOrEqual(140);
    expect(ocrImage).not.toHaveBeenCalled();
    expect(result).toEqual({ x: 890, y: 170 });
    captureSpy.mockRestore();
    screenSpy.mockRestore();
  });

  test('capturing the window does not spend the match budget', async () => {
    let now = 5_000;
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockImplementation(async () => {
      now += 200;
      return Buffer.from('window');
    });
    const match = {
      x: 90,
      y: 70,
      confidence: 0.91,
      method: 'template' as const,
      scale: 1,
      bounds: { x: 74, y: 54, width: 32, height: 32 },
    };
    const matchImage = jest.fn().mockResolvedValue({
      success: true,
      matches: [match],
      bestMatch: match,
      processingTimeMs: 20,
    });
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: { matchImage } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 800, y: 100, width: 800, height: 600 }),
        getTargetBoundsAsync: async () => ({ x: 800, y: 100, width: 800, height: 600 }),
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
      useRelativeCoords: true,
      imageMatchThreshold: 0.6,
    };
    engine.status = engine.createStatus('playing');

    const result = await engine.resolveSmartClick(
      {
        t_ms: 0,
        type: 'mouse',
        btn: 'left',
        x: 540,
        y: 230,
        rel_x: 0.05,
        rel_y: 0.05,
        duration_ms: 0,
        human_override: false,
        img_patch_b64: Buffer.from('template').toString('base64'),
      },
      { x: 540, y: 230 }
    );

    const request = matchImage.mock.calls[0][0];
    expect(request.maxBudgetMs).toBeGreaterThanOrEqual(140);
    expect(request.timeoutMs).toBeGreaterThanOrEqual(140);
    expect(result).toEqual({ x: 890, y: 170 });
    captureSpy.mockRestore();
  });

  test('a missed image match clicks the relative point in the live window', async () => {
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('region'));
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
        getTargetBoundsAsync: async () => ({ x: 800, y: 100, width: 800, height: 600 }),
      } as any,
    }) as any;
    engine.config = {
      ...config,
      target: 'Terminal',
      useImageMatching: true,
      useRelativeCoords: true,
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
        rel_x: 0.05,
        rel_y: 0.05,
        duration_ms: 0,
        human_override: false,
        img_patch_b64: Buffer.from('template').toString('base64'),
      },
      { x: 40, y: 30 }
    );

    expect(result).toEqual({ x: 840, y: 130 });
    expect(engine.getStatus().smartClickLastSource).toBe('expected_fallback');
    captureSpy.mockRestore();
    screenSpy.mockRestore();
  });

  test('a visual match beats the relative point in the live window', async () => {
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
        getTargetBoundsAsync: async () => ({ x: 800, y: 100, width: 800, height: 600 }),
      } as any,
    }) as any;
    engine.config = {
      ...config,
      target: 'Terminal',
      useImageMatching: true,
      useRelativeCoords: true,
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
        rel_x: 0.05,
        rel_y: 0.05,
        duration_ms: 0,
        human_override: false,
        img_patch_b64: Buffer.from('template').toString('base64'),
      },
      { x: 40, y: 30 }
    );

    expect(result).toEqual({ x: 890, y: 170 });
    expect(engine.getStatus().smartClickLastSource).toBe('window');
    expect(engine.getStatus().smartClickLastConfidence).toBeGreaterThan(0.6);
    captureSpy.mockRestore();
  });

  test('a nearby search after a window miss stays inside the live window', async () => {
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('region'));
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(Buffer.from('screen'));
    const match = {
      x: 100,
      y: 100,
      confidence: 0.91,
      method: 'template' as const,
      scale: 1,
      bounds: { x: 84, y: 84, width: 32, height: 32 },
    };
    let calls = 0;
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: {
        matchImage: jest.fn(async () => {
          calls += 1;
          if (calls === 1) {
            return { success: true, matches: [], bestMatch: null, processingTimeMs: 4 };
          }
          return { success: true, matches: [match], bestMatch: match, processingTimeMs: 4 };
        }),
      } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
        getTargetBoundsAsync: async () => ({ x: 400, y: 300, width: 800, height: 600 }),
      } as any,
    }) as any;
    engine.config = {
      ...config,
      target: 'Terminal',
      useImageMatching: true,
      useRelativeCoords: true,
      imageMatchThreshold: 0.6,
      imageSearchRadius: 100,
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
        rel_x: 0.1,
        rel_y: 0.1,
        duration_ms: 0,
        human_override: false,
        img_patch_b64: Buffer.from('template').toString('base64'),
      },
      { x: 40, y: 30 }
    );

    expect(result).toEqual({ x: 480, y: 360 });
    expect(engine.getStatus().smartClickLastSource).toBe('region');
    expect(engine.getStatus().smartClickLastConfidence).toBeGreaterThan(0.6);
    expect(captureSpy.mock.calls[1][0]).toEqual(expect.objectContaining({ x: 380, y: 260 }));
    captureSpy.mockRestore();
    screenSpy.mockRestore();
  });

  test('an anchor learned in a moved window follows the next live window', async () => {
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('region'));
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(Buffer.from('screen'));
    const hit = {
      x: 90,
      y: 70,
      confidence: 0.91,
      method: 'template' as const,
      scale: 1,
      bounds: { x: 74, y: 54, width: 32, height: 32 },
    };
    let bounds = { x: 200, y: 80, width: 800, height: 600 };
    let matchImageCalls = 0;
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: {
        matchImage: jest.fn(async () => {
          matchImageCalls += 1;
          if (matchImageCalls === 1) {
            return { success: true, matches: [hit], bestMatch: hit, processingTimeMs: 4 };
          }
          return { success: true, matches: [], bestMatch: null, processingTimeMs: 4 };
        }),
      } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
        getTargetBoundsAsync: async () => bounds,
      } as any,
    }) as any;
    engine.config = {
      ...config,
      target: 'Terminal',
      useImageMatching: true,
      useRelativeCoords: true,
      imageMatchThreshold: 0.6,
      retryCount: 0,
    };
    engine.status = engine.createStatus('playing');
    const event = {
      t_ms: 0,
      type: 'mouse' as const,
      btn: 'left' as const,
      x: 40,
      y: 30,
      rel_x: 0.05,
      rel_y: 0.05,
      duration_ms: 0,
      human_override: false,
      img_patch_b64: Buffer.from('template').toString('base64'),
    };

    const first = await engine.resolveSmartClick(event, { x: 40, y: 30 });
    expect(first).toEqual({ x: 290, y: 150 });
    expect(engine.getStatus().smartClickAnchorDx).toBe(50);
    expect(engine.getStatus().smartClickAnchorDy).toBe(40);

    bounds = { x: 400, y: 100, width: 800, height: 600 };
    const second = await engine.resolveSmartClick(event, { x: 40, y: 30 });
    expect(second).toEqual({ x: 490, y: 170 });
    captureSpy.mockRestore();
    screenSpy.mockRestore();
  });

  test('a word click remembers where the label moved for the next miss', async () => {
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('region'));
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(Buffer.from('screen'));
    let bounds = { x: 500, y: 200, width: 800, height: 600 };
    let ocrCalls = 0;
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: {
        matchImage: jest.fn().mockResolvedValue({
          success: false,
          matches: [],
          bestMatch: null,
          processingTimeMs: 4,
        }),
        ocrImage: jest.fn(async () => {
          ocrCalls += 1;
          if (ocrCalls > 1) {
            return { success: true, items: [], processingTimeMs: 4 };
          }
          return {
            success: true,
            processingTimeMs: 12,
            items: [
              {
                text: 'Submit',
                confidence: 96,
                bounds: { x: 160, y: 70, width: 80, height: 20 },
              },
            ],
          };
        }),
      } as any,
      windowManager: {
        getTargetBounds: () => bounds,
        getTargetBoundsAsync: async () => bounds,
      } as any,
    }) as any;
    engine.config = {
      ...config,
      target: 'Terminal',
      useImageMatching: true,
      useRelativeCoords: true,
      imageMatchThreshold: 0.6,
      retryCount: 0,
    };
    engine.status = engine.createStatus('playing');
    const event = {
      t_ms: 0,
      type: 'mouse' as const,
      btn: 'left' as const,
      x: 40,
      y: 30,
      rel_x: 0.05,
      rel_y: 0.05,
      duration_ms: 0,
      human_override: false,
      img_patch_b64: Buffer.from('template').toString('base64'),
      metadata: { ocr_primary_text_normalized: 'submit' },
    };

    const first = await engine.resolveSmartClick(event, { x: 40, y: 30 });
    expect(first).toEqual({ x: 700, y: 280 });
    expect(engine.getStatus().smartClickAnchorDx).toBe(160);
    expect(engine.getStatus().smartClickAnchorDy).toBe(50);

    bounds = { x: 800, y: 100, width: 800, height: 600 };
    const second = await engine.resolveSmartClick(event, { x: 40, y: 30 });
    expect(second).toEqual({ x: 1000, y: 180 });
    captureSpy.mockRestore();
    screenSpy.mockRestore();
  });

  test('a click waits for the window lookup before falling back to the anchor', async () => {
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
        matchImage: () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  success: true,
                  matches: [match],
                  bestMatch: match,
                  processingTimeMs: 5,
                }),
              90
            );
          }),
      } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
        getTargetBoundsAsync: () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ x: 200, y: 80, width: 800, height: 600 }), 190);
          }),
      } as any,
    }) as any;
    engine.smartClickAnchor = { dx: 400, dy: 250 };
    engine.smartClickAnchorTrust = 3;
    engine.config = {
      ...config,
      target: 'Terminal',
      useImageMatching: true,
      useRelativeCoords: false,
      imageMatchThreshold: 0.6,
    };
    engine.status = engine.createStatus('playing');
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
    const expected = { x: 40, y: 30 };
    const inflight = engine.resolveSmartClick(event, expected);
    engine.smartClickPromises.set(0, inflight);
    engine.smartClickTelemetry.set(0, { open: true });
    const pending = engine.getSmartClickCoords(0, event, expected);
    await jest.advanceTimersByTimeAsync(280);
    await expect(pending).resolves.toEqual({ x: 290, y: 150 });
    expect(engine.getStatus().smartClickLastSource).toBe('window');
    expect(engine.getStatus().smartClickLastConfidence).toBeGreaterThan(0.6);
    captureSpy.mockRestore();
    jest.useRealTimers();
  });

  test('playback start uses a live window that arrives after 160ms', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2020-01-01T00:00:00Z'));
    const moves: Array<{ x: number; y: number }> = [];
    const engine = new PlaybackEngine({
      inputPlayer: {
        moveMouse: (x: number, y: number) => moves.push({ x, y }),
        mouseDown: () => undefined,
        mouseUp: () => undefined,
        keyDown: () => undefined,
        keyUp: () => undefined,
      } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 500, y: 200, width: 800, height: 600 }),
        getTargetBoundsAsync: () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ x: 800, y: 100, width: 800, height: 600 }), 180);
          }),
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
        },
      ],
    };
    const startPromise = engine.start(
      {
        ...config,
        target: 'Terminal',
        useImageMatching: false,
        useRelativeCoords: true,
      },
      profile
    );
    await jest.advanceTimersByTimeAsync(200);
    await startPromise;
    await jest.advanceTimersByTimeAsync(50);
    expect(moves[0]).toEqual({ x: 840, y: 130 });
    await engine.stop();
    jest.useRealTimers();
  });

  test('a slow window lookup still clicks recorded text before the click wait ends', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2020-01-01T00:00:00Z'));
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('region'));
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(Buffer.from('screen'));
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: {
        matchImage: () =>
          new Promise((resolve) => {
            setTimeout(
              () => resolve({ success: true, matches: [], bestMatch: null, processingTimeMs: 90 }),
              90
            );
          }),
        ocrImage: (_request: { timeoutMs?: number }) =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  success: true,
                  processingTimeMs: 80,
                  items: [
                    {
                      text: 'Submit',
                      confidence: 91,
                      bounds: { x: 40, y: 30, width: 80, height: 20 },
                    },
                  ],
                }),
              80
            );
          }),
      } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 500, y: 200, width: 800, height: 600 }),
        getTargetBoundsAsync: () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ x: 800, y: 100, width: 800, height: 600 }), 190);
          }),
      } as any,
    }) as any;
    engine.smartClickAnchor = { dx: 0, dy: 0 };
    engine.smartClickAnchorTrust = 3;
    engine.config = {
      ...config,
      target: 'Terminal',
      useImageMatching: true,
      useRelativeCoords: false,
      imageMatchThreshold: 0.6,
      retryCount: 0,
    };
    engine.status = {
      ...engine.createStatus('playing'),
      smartClickLastScale: 1.4,
    };
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
      metadata: {
        ocr_primary_text_normalized: 'submit',
        ocr_anchor_norm_x: 0.25,
        ocr_anchor_norm_y: -0.5,
      },
    };
    const expected = { x: 40, y: 30 };
    const inflight = engine.resolveSmartClick(event, expected);
    engine.smartClickPromises.set(0, inflight);
    engine.smartClickTelemetry.set(0, { open: true });
    const pending = engine.getSmartClickCoords(0, event, expected);
    await jest.advanceTimersByTimeAsync(460);
    await expect(pending).resolves.toEqual({ x: 900, y: 130 });
    expect(engine.getStatus().smartClickLastSource).toBe('window');
    expect(engine.getStatus().smartClickLastMethod).toBe('ocr');
    expect(engine.getStatus().smartClickLastConfidence).toBeGreaterThan(0.6);
    expect(engine.getStatus().smartClickLastScale).toBeUndefined();
    captureSpy.mockRestore();
    screenSpy.mockRestore();
    jest.useRealTimers();
  });

  test('the first click does not wait past the match deadline', async () => {
    jest.useFakeTimers();
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      windowManager: { getTargetBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) } as any,
    }) as any;
    engine.status = {
      ...engine.createStatus('playing'),
      smartClickLastConfidence: 1,
      smartClickLastSource: 'window',
      smartClickLastDHashDistance: 0,
      smartClickLastScale: 1.4,
    };
    engine.smartClickPromises.set(0, new Promise(() => {}));
    engine.smartClickTelemetry.set(0, { open: true });
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
      img_patch_b64: 'patch',
    };
    const pending = engine.getSmartClickCoords(0, event, { x: 40, y: 30 });
    await jest.advanceTimersByTimeAsync(460);
    await expect(pending).resolves.toEqual({ x: 40, y: 30 });
    expect(engine.smartClickTelemetry.get(0).open).toBe(false);
    expect(engine.getStatus().smartClickLastSource).toBe('expected_fallback');
    expect(engine.getStatus().smartClickLastConfidence).toBeUndefined();
    expect(engine.getStatus().smartClickLastDHashDistance).toBeUndefined();
    expect(engine.getStatus().smartClickLastScale).toBeUndefined();
    jest.useRealTimers();
  });

  test('a timed-out match clicks the relative point in the live window', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2020-01-01T00:00:00Z'));
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('region'));
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(Buffer.from('screen'));
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: {
        matchImage: () => new Promise(() => {}),
      } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 500, y: 200, width: 800, height: 600 }),
        getTargetBoundsAsync: () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ x: 800, y: 100, width: 800, height: 600 }), 190);
          }),
      } as any,
    }) as any;
    engine.config = {
      ...config,
      target: 'Terminal',
      useImageMatching: true,
      useRelativeCoords: true,
      imageMatchThreshold: 0.6,
      retryCount: 0,
    };
    engine.status = engine.createStatus('playing');
    const event = {
      t_ms: 0,
      type: 'mouse' as const,
      btn: 'left' as const,
      x: 40,
      y: 30,
      rel_x: 0.05,
      rel_y: 0.05,
      duration_ms: 0,
      human_override: false,
      img_patch_b64: Buffer.from('template').toString('base64'),
    };
    const stale = { x: 540, y: 230 };
    const inflight = engine.resolveSmartClick(event, stale);
    engine.smartClickPromises.set(0, inflight);
    engine.smartClickTelemetry.set(0, { open: true });
    const pending = engine.getSmartClickCoords(0, event, stale);
    await jest.advanceTimersByTimeAsync(460);
    await expect(pending).resolves.toEqual({ x: 840, y: 130 });
    expect(engine.getStatus().smartClickLastSource).toBe('expected_fallback');
    captureSpy.mockRestore();
    screenSpy.mockRestore();
    jest.useRealTimers();
  });

  test('anchor ranking follows the live window when the caller point is stale', async () => {
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('region'));
    const decoy = {
      x: 0,
      y: 170,
      confidence: 0.72,
      method: 'template' as const,
      scale: 1,
      bounds: { x: 0, y: 154, width: 32, height: 32 },
    };
    const truth = {
      x: 90,
      y: 70,
      confidence: 0.7,
      method: 'template' as const,
      scale: 1,
      bounds: { x: 74, y: 54, width: 32, height: 32 },
    };
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: {
        matchImage: jest.fn().mockResolvedValue({
          success: true,
          matches: [decoy, truth],
          bestMatch: decoy,
          processingTimeMs: 5,
        }),
      } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 500, y: 200, width: 800, height: 600 }),
        getTargetBoundsAsync: async () => ({ x: 800, y: 100, width: 800, height: 600 }),
      } as any,
    }) as any;
    engine.config = {
      ...config,
      target: 'Terminal',
      useImageMatching: true,
      useRelativeCoords: true,
      imageMatchThreshold: 0.6,
      retryCount: 0,
    };
    engine.status = engine.createStatus('playing');
    engine.smartClickAnchor = { dx: 50, dy: 40 };
    engine.smartClickAnchorTrust = 4;

    const result = await engine.resolveSmartClick(
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
      { x: 540, y: 230 }
    );

    expect(result).toEqual({ x: 890, y: 170 });
    captureSpy.mockRestore();
  });

  test('a window miss searches around the anchored point in the live window', async () => {
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('region'));
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(Buffer.from('screen'));
    const match = {
      x: 80,
      y: 80,
      confidence: 0.91,
      method: 'template' as const,
      scale: 1,
      bounds: { x: 64, y: 64, width: 32, height: 32 },
    };
    let calls = 0;
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: {
        matchImage: jest.fn(async () => {
          calls += 1;
          if (calls === 1) {
            return { success: true, matches: [], bestMatch: null, processingTimeMs: 4 };
          }
          return { success: true, matches: [match], bestMatch: match, processingTimeMs: 4 };
        }),
      } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
        getTargetBoundsAsync: async () => ({ x: 400, y: 300, width: 800, height: 600 }),
      } as any,
    }) as any;
    engine.config = {
      ...config,
      target: 'Terminal',
      useImageMatching: true,
      useRelativeCoords: true,
      imageMatchThreshold: 0.6,
      imageSearchRadius: 80,
      retryCount: 0,
    };
    engine.status = engine.createStatus('playing');
    engine.smartClickAnchor = { dx: 180, dy: 0 };
    engine.smartClickAnchorTrust = 4;

    const result = await engine.resolveSmartClick(
      {
        t_ms: 0,
        type: 'mouse',
        btn: 'left',
        x: 40,
        y: 30,
        rel_x: 0.1,
        rel_y: 0.1,
        duration_ms: 0,
        human_override: false,
        img_patch_b64: Buffer.from('template').toString('base64'),
      },
      { x: 40, y: 30 }
    );

    expect(captureSpy.mock.calls[1][0]).toEqual(expect.objectContaining({ x: 580, y: 280 }));
    expect(result).toEqual({ x: 660, y: 360 });
    expect(engine.getStatus().smartClickLastSource).toBe('region');
    captureSpy.mockRestore();
    screenSpy.mockRestore();
  });

  test('an unknown relative point stays on the recorded absolute click', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2020-01-01T00:00:00Z'));
    const moves: Array<{ x: number; y: number }> = [];
    const engine = new PlaybackEngine({
      inputPlayer: {
        moveMouse: (x: number, y: number) => moves.push({ x, y }),
        mouseDown: () => undefined,
        mouseUp: () => undefined,
        keyDown: () => undefined,
        keyUp: () => undefined,
      } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
        getTargetBoundsAsync: async () => ({ x: 800, y: 100, width: 800, height: 600 }),
      } as any,
    });
    const profile: Profile = {
      ...baseProfile,
      events: [
        {
          t_ms: 0,
          type: 'mouse',
          btn: 'left',
          x: 540,
          y: 230,
          rel_x: Number.NaN,
          rel_y: Number.NaN,
          duration_ms: 0,
          human_override: false,
        },
      ],
    };

    await engine.start({ ...config, target: 'Terminal', useRelativeCoords: true, useImageMatching: false }, profile);
    await jest.advanceTimersByTimeAsync(50);

    expect(moves[0]).toEqual({ x: 540, y: 230 });
    jest.useRealTimers();
  });

  test('a failed window lookup does not map the click onto the desktop', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2020-01-01T00:00:00Z'));
    const moves: Array<{ x: number; y: number }> = [];
    const engine = new PlaybackEngine({
      inputPlayer: {
        moveMouse: (x: number, y: number) => moves.push({ x, y }),
        mouseDown: () => undefined,
        mouseUp: () => undefined,
        keyDown: () => undefined,
        keyUp: () => undefined,
      } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
        getTargetBoundsAsync: async () => null,
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
          x: 540,
          y: 230,
          rel_x: 0.05,
          rel_y: 0.05,
          duration_ms: 0,
          human_override: false,
        },
      ],
    };

    await engine.start(
      { ...config, target: 'Terminal', useRelativeCoords: true, useImageMatching: false },
      profile
    );
    await jest.advanceTimersByTimeAsync(50);

    expect(moves[0]).toEqual({ x: 540, y: 230 });
    jest.useRealTimers();
  });

  test('a failed lookup keeps the last known window', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2020-01-01T00:00:00Z'));
    const moves: Array<{ x: number; y: number }> = [];
    const engine = new PlaybackEngine({
      inputPlayer: {
        moveMouse: (x: number, y: number) => moves.push({ x, y }),
        mouseDown: () => undefined,
        mouseUp: () => undefined,
        keyDown: () => undefined,
        keyUp: () => undefined,
      } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
        getKnownTargetBounds: () => ({ x: 800, y: 100, width: 800, height: 600 }),
        getTargetBoundsAsync: async () => null,
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
          x: 540,
          y: 230,
          rel_x: 0.05,
          rel_y: 0.05,
          duration_ms: 0,
          human_override: false,
        },
      ],
    };

    await engine.start(
      { ...config, target: 'Terminal', useRelativeCoords: true, useImageMatching: false },
      profile
    );
    await jest.advanceTimersByTimeAsync(50);

    expect(moves[0]).toEqual({ x: 840, y: 130 });
    jest.useRealTimers();
  });

  test('image matching does not replace the live window with the desktop', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2020-01-01T00:00:00Z'));
    const moves: Array<{ x: number; y: number }> = [];
    const engine = new PlaybackEngine({
      inputPlayer: {
        moveMouse: (x: number, y: number) => moves.push({ x, y }),
        mouseDown: () => undefined,
        mouseUp: () => undefined,
        keyDown: () => undefined,
        keyUp: () => undefined,
      } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
        getKnownTargetBounds: () => null,
        getTargetBoundsAsync: async () => ({ x: 800, y: 100, width: 800, height: 600 }),
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
          x: 540,
          y: 230,
          rel_x: 0.05,
          rel_y: 0.05,
          duration_ms: 0,
          human_override: false,
        },
      ],
    };

    await engine.start(
      { ...config, target: 'Terminal', useRelativeCoords: true, useImageMatching: true },
      profile
    );
    await jest.advanceTimersByTimeAsync(50);

    expect(moves[0]).toEqual({ x: 840, y: 130 });
    jest.useRealTimers();
  });

  test('a repeating patch keeps the click on the recorded point', async () => {
    const sharp = require('sharp');
    const fs = require('fs');
    const path = require('path');
    const windowPng = fs.readFileSync(path.join(__dirname, 'fixtures/periodic-window.png'));
    const patch = await sharp(windowPng).extract({ left: 48, top: 40, width: 96, height: 96 }).png().toBuffer();
    const recordedHash = await computeDHash(patch);
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(windowPng);
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(windowPng);
    const truth = {
      x: 96,
      y: 88,
      confidence: 1,
      method: 'template' as const,
      scale: 1,
      bounds: { x: 48, y: 40, width: 96, height: 96 },
    };
    const decoy = {
      x: 266,
      y: 198,
      confidence: 0.85,
      method: 'template' as const,
      scale: 1,
      bounds: { x: 218, y: 150, width: 96, height: 96 },
    };
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: {
        matchImage: jest.fn().mockResolvedValue({
          success: true,
          matches: [truth, decoy],
          bestMatch: truth,
          processingTimeMs: 12,
        }),
      } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 260, y: 160, width: 400, height: 280 }),
        getTargetBoundsAsync: async () => ({ x: 260, y: 160, width: 400, height: 280 }),
      } as any,
    }) as any;
    engine.config = {
      ...config,
      target: 'Pattern',
      useImageMatching: true,
      useRelativeCoords: true,
      imageMatchThreshold: 0.6,
      retryCount: 0,
    };
    engine.status = engine.createStatus('playing');
    const event = {
      t_ms: 0,
      type: 'mouse' as const,
      btn: 'left' as const,
      x: 196,
      y: 168,
      rel_x: 96 / 400,
      rel_y: 88 / 280,
      duration_ms: 0,
      human_override: false,
      img_patch_b64: patch.toString('base64'),
      metadata: { img_dhash: recordedHash },
    };

    const result = await engine.resolveSmartClick(event, { x: 196, y: 168 });

    expect(result).toEqual({ x: 356, y: 248 });
    expect(engine.getStatus().smartClickLastSource).toBe('window');
    expect(engine.getStatus().smartClickLastConfidence).toBeGreaterThan(0.6);
    captureSpy.mockRestore();
    screenSpy.mockRestore();
  });

  test('equal copies click the one at the recorded point', async () => {
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('region'));
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(Buffer.from('screen'));
    const nearer = {
      x: 160,
      y: 30,
      confidence: 0.95,
      method: 'template' as const,
      scale: 1,
      bounds: { x: 112, y: 0, width: 96, height: 96 },
    };
    const farther = {
      x: 40,
      y: 30,
      confidence: 0.95,
      method: 'template' as const,
      scale: 1,
      bounds: { x: 0, y: 0, width: 96, height: 96 },
    };
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: {
        matchImage: jest.fn().mockResolvedValue({
          success: true,
          matches: [farther, nearer],
          bestMatch: farther,
          processingTimeMs: 8,
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
      retryCount: 0,
    };
    engine.status = engine.createStatus('playing');
    const result = await engine.resolveSmartClick(
      {
        t_ms: 0,
        type: 'mouse' as const,
        btn: 'left' as const,
        x: 660,
        y: 230,
        rel_x: 0,
        rel_y: 0,
        duration_ms: 0,
        human_override: false,
        img_patch_b64: Buffer.from('patch').toString('base64'),
      },
      { x: 660, y: 230 }
    );
    expect(result).toEqual({ x: 660, y: 230 });
    captureSpy.mockRestore();
    screenSpy.mockRestore();
  });

  test('a clearly stronger copy beats the nearer one', async () => {
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(Buffer.from('region'));
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(Buffer.from('screen'));
    const nearer = {
      x: 160,
      y: 30,
      confidence: 0.9,
      method: 'template' as const,
      scale: 1,
      bounds: { x: 112, y: 0, width: 96, height: 96 },
    };
    const stronger = {
      x: 40,
      y: 30,
      confidence: 0.96,
      method: 'template' as const,
      scale: 1,
      bounds: { x: 0, y: 0, width: 96, height: 96 },
    };
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: {
        matchImage: jest.fn().mockResolvedValue({
          success: true,
          matches: [nearer, stronger],
          bestMatch: nearer,
          processingTimeMs: 8,
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
      retryCount: 0,
    };
    engine.status = engine.createStatus('playing');
    const result = await engine.resolveSmartClick(
      {
        t_ms: 0,
        type: 'mouse' as const,
        btn: 'left' as const,
        x: 660,
        y: 230,
        rel_x: 0,
        rel_y: 0,
        duration_ms: 0,
        human_override: false,
        img_patch_b64: Buffer.from('patch').toString('base64'),
      },
      { x: 660, y: 230 }
    );
    expect(result).toEqual({ x: 540, y: 230 });
    captureSpy.mockRestore();
    screenSpy.mockRestore();
  });

  test('a 0.66 match on the recorded patch still clicks', async () => {
    const sharp = require('sharp');
    const fs = require('fs');
    const path = require('path');
    const windowPng = fs.readFileSync(path.join(__dirname, 'fixtures/periodic-window.png'));
    const patch = await sharp(windowPng).extract({ left: 48, top: 40, width: 96, height: 96 }).png().toBuffer();
    const recordedHash = await computeDHash(patch);
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(windowPng);
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(windowPng);
    const truth = {
      x: 96,
      y: 88,
      confidence: 0.66,
      method: 'template' as const,
      scale: 1,
      bounds: { x: 48, y: 40, width: 96, height: 96 },
    };
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: {
        matchImage: jest.fn().mockResolvedValue({
          success: true,
          matches: [truth],
          bestMatch: truth,
          processingTimeMs: 12,
        }),
      } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 260, y: 160, width: 400, height: 280 }),
        getTargetBoundsAsync: async () => ({ x: 260, y: 160, width: 400, height: 280 }),
      } as any,
    }) as any;
    engine.config = {
      ...config,
      target: 'Pattern',
      useImageMatching: true,
      useRelativeCoords: true,
      imageMatchThreshold: 0.6,
      retryCount: 0,
    };
    engine.status = engine.createStatus('playing');

    const result = await engine.resolveSmartClick(
      {
        t_ms: 0,
        type: 'mouse',
        btn: 'left',
        x: 196,
        y: 168,
        rel_x: 96 / 400,
        rel_y: 88 / 280,
        duration_ms: 0,
        human_override: false,
        img_patch_b64: patch.toString('base64'),
        metadata: { img_dhash: recordedHash },
      },
      { x: 196, y: 168 }
    );

    expect(result).toEqual({ x: 356, y: 248 });
    expect(engine.getStatus().smartClickLastConfidence).toBeCloseTo(0.66);
    captureSpy.mockRestore();
    screenSpy.mockRestore();
  });

  test('a modest match of a different patch stays on the recorded point', async () => {
    const sharp = require('sharp');
    const checker = Buffer.alloc(96 * 96 * 3);
    for (let y = 0; y < 96; y += 1) {
      for (let x = 0; x < 96; x += 1) {
        const on = ((x >> 3) ^ (y >> 3)) & 1;
        const i = (y * 96 + x) * 3;
        checker[i] = checker[i + 1] = checker[i + 2] = on ? 255 : 0;
      }
    }
    const stripes = Buffer.alloc(200 * 200 * 3);
    for (let y = 0; y < 200; y += 1) {
      for (let x = 0; x < 200; x += 1) {
        const on = x % 12 < 6;
        const i = (y * 200 + x) * 3;
        stripes[i] = on ? 240 : 20;
        stripes[i + 1] = on ? 40 : 180;
        stripes[i + 2] = on ? 40 : 60;
      }
    }
    const patch = await sharp(checker, { raw: { width: 96, height: 96, channels: 3 } }).png().toBuffer();
    const search = await sharp(stripes, { raw: { width: 200, height: 200, channels: 3 } }).png().toBuffer();
    const recordedHash = await computeDHash(patch);
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(search);
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(search);
    const recorded = { x: 400, y: 400 };
    const run = async (match: { confidence: number; scale: number }) => {
      const engine = new PlaybackEngine({
        inputPlayer: {} as any,
        imageService: {
          matchImage: jest.fn().mockResolvedValue({
            success: true,
            matches: [
              {
                x: 100,
                y: 40,
                confidence: match.confidence,
                method: 'template' as const,
                scale: match.scale,
                bounds: { x: 52, y: 0, width: 96, height: 96 },
              },
            ],
            bestMatch: {
              x: 100,
              y: 40,
              confidence: match.confidence,
              method: 'template' as const,
              scale: match.scale,
              bounds: { x: 52, y: 0, width: 96, height: 96 },
            },
            processingTimeMs: 12,
          }),
        } as any,
        windowManager: { getTargetBounds: () => null, getTargetBoundsAsync: async () => null } as any,
      }) as any;
      engine.config = {
        ...config,
        target: 'screen',
        useImageMatching: true,
        useRelativeCoords: false,
        imageMatchThreshold: 0.6,
        imageSearchRadius: 100,
        retryCount: 0,
      };
      engine.status = engine.createStatus('playing');
      const result = await engine.resolveSmartClick(
        {
          t_ms: 0,
          type: 'mouse' as const,
          btn: 'left' as const,
          x: recorded.x,
          y: recorded.y,
          rel_x: 0,
          rel_y: 0,
          duration_ms: 0,
          human_override: false,
          img_patch_b64: patch.toString('base64'),
          metadata: { img_dhash: recordedHash, recorded_match_scale: 1 },
        },
        recorded
      );
      return { result, status: engine.getStatus() };
    };

    const weak = await run({ confidence: 0.68, scale: 1 });
    expect(weak.result).toEqual(recorded);
    expect(weak.status.smartClickLastSource).toBe('expected_fallback');
    expect(weak.status.smartClickLastConfidence).toBeUndefined();
    expect(weak.status.successfulMatches).toBe(0);

    const scaled = await run({ confidence: 0.66, scale: 0.7 });
    expect(scaled.result).toEqual(recorded);
    expect(scaled.status.smartClickLastSource).toBe('expected_fallback');
    expect(scaled.status.successfulMatches).toBe(0);

    const almost = await run({ confidence: 0.9, scale: 1 });
    expect(almost.result).toEqual(recorded);
    expect(almost.status.smartClickLastSource).toBe('expected_fallback');

    const strong = await run({ confidence: 0.95, scale: 1 });
    expect(strong.result).toEqual({ x: 400, y: 340 });
    expect(strong.status.smartClickLastConfidence).toBeCloseTo(0.95);
    captureSpy.mockRestore();
    screenSpy.mockRestore();
  });

  test('a screen target uses the context image when the small patch is gone', async () => {
    const sharp = require('sharp');
    const checker = Buffer.alloc(96 * 96 * 3);
    const stripes = Buffer.alloc(200 * 200 * 3);
    for (let y = 0; y < 96; y += 1) {
      for (let x = 0; x < 96; x += 1) {
        const on = ((x >> 3) ^ (y >> 3)) & 1;
        const i = (y * 96 + x) * 3;
        checker[i] = checker[i + 1] = checker[i + 2] = on ? 255 : 0;
      }
    }
    for (let y = 0; y < 200; y += 1) {
      for (let x = 0; x < 200; x += 1) {
        const on = x % 12 < 6;
        const i = (y * 200 + x) * 3;
        stripes[i] = on ? 240 : 20;
        stripes[i + 1] = on ? 40 : 180;
        stripes[i + 2] = on ? 40 : 60;
      }
    }
    const patch = await sharp(checker, { raw: { width: 96, height: 96, channels: 3 } }).png().toBuffer();
    const context = await sharp(stripes, { raw: { width: 200, height: 200, channels: 3 } })
      .extract({ left: 20, top: 20, width: 96, height: 96 })
      .png()
      .toBuffer();
    const search = await sharp(stripes, { raw: { width: 200, height: 200, channels: 3 } }).png().toBuffer();
    const recordedHash = await computeDHash(patch);
    const captureSpy = jest.spyOn(screenCapture, 'captureRegion').mockResolvedValue(search);
    const screenSpy = jest.spyOn(screenCapture, 'captureScreen').mockResolvedValue(search);
    const impostor = {
      x: 100,
      y: 40,
      confidence: 0.68,
      method: 'template' as const,
      scale: 1,
      bounds: { x: 52, y: 0, width: 96, height: 96 },
    };
    const feature = {
      x: 40,
      y: 100,
      confidence: 0.8,
      method: 'feature' as const,
      scale: 1,
      homography_ok: true,
      inliers: 12,
      bounds: { x: 0, y: 52, width: 96, height: 96 },
    };
    const matchImage = jest.fn(async (request: { method?: string; template?: string; searchArea?: string; maxBudgetMs?: number }) => {
      if (request.method === 'feature') {
        return { success: true, matches: [feature], bestMatch: feature, processingTimeMs: 20 };
      }
      return { success: true, matches: [impostor], bestMatch: impostor, processingTimeMs: 40 };
    });
    const engine = new PlaybackEngine({
      inputPlayer: {} as any,
      imageService: { matchImage } as any,
      windowManager: { getTargetBounds: () => null, getTargetBoundsAsync: async () => null } as any,
    }) as any;
    engine.config = {
      ...config,
      target: 'screen',
      useImageMatching: true,
      useRelativeCoords: false,
      imageMatchThreshold: 0.6,
      imageSearchRadius: 100,
      retryCount: 0,
    };
    engine.status = engine.createStatus('playing');
    const recorded = { x: 400, y: 400 };
    const result = await engine.resolveSmartClick(
      {
        t_ms: 0,
        type: 'mouse' as const,
        btn: 'left' as const,
        x: recorded.x,
        y: recorded.y,
        rel_x: 0,
        rel_y: 0,
        duration_ms: 0,
        human_override: false,
        img_patch_b64: patch.toString('base64'),
        img_context_b64: context.toString('base64'),
        metadata: { img_dhash: recordedHash, recorded_match_scale: 1 },
      },
      recorded
    );
    expect(result).toEqual({ x: 340, y: 400 });
    expect(engine.getStatus().smartClickLastMethod).toBe('feature');
    expect(engine.getStatus().smartClickLastSource).toBe('region');
    expect(engine.getStatus().smartClickLastConfidence).toBeGreaterThan(0.6);
    expect(screenSpy).not.toHaveBeenCalled();
    expect(captureSpy).toHaveBeenCalledTimes(1);
    const featureCall = matchImage.mock.calls.find(call => call[0].method === 'feature');
    expect(featureCall?.[0].template).toBe(context.toString('base64'));
    expect(featureCall?.[0].searchArea).toBe(search.toString('base64'));
    expect(featureCall?.[0].maxBudgetMs).toBeGreaterThanOrEqual(80);
    captureSpy.mockRestore();
    screenSpy.mockRestore();
  });

  test('posting a SmartClick does not mark its release as late', async () => {
    jest.useFakeTimers();
    let now = 1_000_000;
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
    const clicks: Array<{ x: number; y: number }> = [];
    const engine = new PlaybackEngine({
      clock: {
        now: () => now,
        setTimeout: (handler, timeout) => setTimeout(handler, timeout ?? 0),
        clearTimeout: (timer) => clearTimeout(timer),
      },
      inputPlayer: {
        moveMouse: (x: number, y: number) => {
          now += 30;
          clicks.push({ x, y });
        },
        mouseDown: () => {
          now += 30;
        },
        mouseUp: () => {
          now += 1;
        },
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
        getTargetBoundsAsync: async () => ({ x: 500, y: 200, width: 800, height: 600 }),
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

    const started = engine.start(
      {
        ...config,
        target: 'Terminal',
        useImageMatching: true,
        useRelativeCoords: false,
        imageMatchThreshold: 0.6,
        timingTolerance: 20,
      },
      profile
    );
    await jest.advanceTimersByTimeAsync(500);
    await started;

    expect(clicks[0]).toEqual({ x: 590, y: 270 });
    expect(engine.getStatus().lastError).toBeUndefined();
    captureSpy.mockRestore();
    screenSpy.mockRestore();
    jest.useRealTimers();
  });

  test('snap off keeps a desktop click on its recorded millisecond', async () => {
    const pending = new Map<number, number>();
    let id = 0;
    const clock = {
      now: () => 5000,
      setTimeout: (_handler: () => void, timeout: number) => {
        id += 1;
        pending.set(id, timeout);
        return id as unknown as NodeJS.Timeout;
      },
      clearTimeout: (handle: NodeJS.Timeout) => {
        pending.delete(handle as unknown as number);
      },
    };
    const engine = new PlaybackEngine({
      inputPlayer: {
        moveMouse() {},
        mouseDown() {},
        mouseUp() {},
        keyDown() {},
        keyUp() {},
      } as any,
      windowManager: {
        getTargetBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
        getTargetBoundsAsync: async () => null,
      } as any,
      clock,
    });
    const profile: Profile = {
      ...baseProfile,
      events: [
        {
          t_ms: 10,
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

    await engine.start({ ...config, snapToHz: 0, snapMode: 'duration-lock' }, profile);
    expect([...pending.values()]).toEqual([8]);

    await engine.stop();
    await engine.start({ ...config, snapToHz: 240, snapMode: 'duration-lock' }, profile);
    const snapped = [...pending.values()];
    expect(snapped).toHaveLength(1);
    expect(snapped[0]).toBeCloseTo(2000 / 240 - 2, 5);
  });
});
