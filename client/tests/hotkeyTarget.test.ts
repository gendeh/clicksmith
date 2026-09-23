import { hotkeyTarget } from '../src/main/hotkeyTarget';

describe('hotkeyTarget', () => {
  test('uses the target the UI is showing', () => {
    expect(hotkeyTarget('Terminal', 'screen')).toBe('Terminal');
  });

  test('keeps an explicit Screen choice instead of the profile app', () => {
    expect(hotkeyTarget('screen', 'Terminal')).toBe('screen');
  });

  test('uses the profile target only when the UI has not chosen one', () => {
    expect(hotkeyTarget(null, 'Terminal')).toBe('Terminal');
    expect(hotkeyTarget('  ', 'Terminal')).toBe('Terminal');
  });

  test('defaults to screen', () => {
    expect(hotkeyTarget(null, null)).toBe('screen');
    expect(hotkeyTarget('', '')).toBe('screen');
  });
});
