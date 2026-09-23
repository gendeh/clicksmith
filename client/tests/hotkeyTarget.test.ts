import fs from 'fs';
import path from 'path';
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

  test('an unsaved replay follows the UI target', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/main/main.ts'), 'utf8');
    const start = source.indexOf('draftQuickReplayPending ? lastDraftProfile');
    const end = source.indexOf('let profileId = lastProfileId', start);
    const draftReplay = source.slice(start, end);
    expect(draftReplay).toContain('hotkeyTarget(selectedUiTarget, draftProfile.target_app)');
    expect(draftReplay).toContain('target: playTarget');
    expect(draftReplay).not.toContain('target: draftProfile.target_app');
  });
});
