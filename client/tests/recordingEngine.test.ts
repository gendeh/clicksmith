import { RecordingEngine } from '../src/main/recordingEngine';
import { RecordingConfig } from '../src/types';
import { MockInputHook } from '../src/main/inputHooks';

describe('RecordingEngine', () => {
  let engine: RecordingEngine;
  const mockConfig: RecordingConfig = {
    target: 'notepad.exe',
    captureImages: false,
    imagePatchSize: 128,
    minEventInterval: 10,
    recordKeyboard: true,
    recordMouse: true,
    stopHotkey: 'F9',
    takeoverHotkey: 'F11'
  };

  beforeEach(() => {
    engine = new RecordingEngine({
      inputHook: new MockInputHook(),
      windowManager: { getTargetBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) } as any,
    });
  });

  afterEach(async () => {
    await engine.stop();
  });

  test('should start recording', async () => {
    const result = await engine.start(mockConfig);
    expect(result.success).toBe(true);
  });

  test('should not start if already recording', async () => {
    await engine.start(mockConfig);
    const result = await engine.start(mockConfig);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Already recording');
  });

  test('should stop recording and return profile', async () => {
    await engine.start(mockConfig);
    
    // Simulate some time passing
    await new Promise(resolve => setTimeout(resolve, 10));
    
    const result = await engine.stop();
    expect(result.success).toBe(true);
    expect(result.profile).toBeDefined();
    expect(result.profile.events).toEqual([]); // Empty because we haven't simulated events
    expect(result.profile.duration).toBeGreaterThan(0);
  });
});
