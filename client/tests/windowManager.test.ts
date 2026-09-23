import { WindowManager } from '../src/main/windowManager';

const mockOsascriptStdout = { value: '' };

jest.mock('child_process', () => ({
  exec: (
    _command: string,
    options: { timeout?: number } | ((err: Error | null, result: { stdout: string }) => void),
    callback?: (err: Error | null, result: { stdout: string }) => void
  ) => {
    const cb = typeof options === 'function' ? options : callback;
    cb?.(null, { stdout: mockOsascriptStdout.value });
  },
}));

describe('WindowManager live bounds', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockOsascriptStdout.value = '';
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  test('a failed live lookup does not return the cached window', async () => {
    const manager = new WindowManager();
    (manager as any).nativeLoadAttempted = true;
    (manager as any).nativeManager = null;

    mockOsascriptStdout.value = '800,100,800,600\n';
    await expect(manager.getTargetBoundsAsync('Terminal')).resolves.toEqual({
      x: 800,
      y: 100,
      width: 800,
      height: 600,
    });

    mockOsascriptStdout.value = '\n';
    await expect(manager.getTargetBoundsAsync('Terminal')).resolves.toBeNull();
  });
});
