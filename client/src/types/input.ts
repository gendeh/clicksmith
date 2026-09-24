import type { MouseButton } from './index';

export const POINTER_MOVE_MIN_DISTANCE_PX = 4;
export const GAMEPAD_AXIS_DEADZONE = 0.12;

export const UIOHOOK_WHEEL_VERTICAL = 3;
export const UIOHOOK_WHEEL_HORIZONTAL = 4;

const UIOHOOK_KEY_NAMES: Record<number, string> = {
  1: 'escape',
  2: '1',
  3: '2',
  4: '3',
  5: '4',
  6: '5',
  7: '6',
  8: '7',
  9: '8',
  10: '9',
  11: '0',
  12: '-',
  13: '=',
  14: 'backspace',
  15: 'tab',
  16: 'q',
  17: 'w',
  18: 'e',
  19: 'r',
  20: 't',
  21: 'y',
  22: 'u',
  23: 'i',
  24: 'o',
  25: 'p',
  26: '[',
  27: ']',
  28: 'enter',
  29: 'control',
  30: 'a',
  31: 's',
  32: 'd',
  33: 'f',
  34: 'g',
  35: 'h',
  36: 'j',
  37: 'k',
  38: 'l',
  39: ';',
  40: "'",
  41: '`',
  42: 'shift',
  43: '\\',
  44: 'z',
  45: 'x',
  46: 'c',
  47: 'v',
  48: 'b',
  49: 'n',
  50: 'm',
  51: ',',
  52: '.',
  53: '/',
  54: 'shift',
  56: 'alt',
  57: 'space',
  58: 'capslock',
  59: 'f1',
  60: 'f2',
  61: 'f3',
  62: 'f4',
  63: 'f5',
  64: 'f6',
  65: 'f7',
  66: 'f8',
  67: 'f9',
  68: 'f10',
  69: 'numlock',
  71: 'numpad_7',
  72: 'numpad_8',
  73: 'numpad_9',
  74: '-',
  75: 'numpad_4',
  76: 'numpad_5',
  77: 'numpad_6',
  78: '+',
  79: 'numpad_1',
  80: 'numpad_2',
  81: 'numpad_3',
  82: 'numpad_0',
  83: '.',
  87: 'f11',
  88: 'f12',
  3612: 'enter',
  3613: 'control',
  3637: '/',
  3639: 'printscreen',
  3640: 'alt',
  3675: 'command',
  3676: 'command',
  57415: 'home',
  57416: 'up',
  57417: 'pageup',
  57419: 'left',
  57421: 'right',
  57423: 'end',
  57424: 'down',
  57425: 'pagedown',
  57426: 'insert',
  57427: 'delete',
};

export const ROBOT_KEY_NAMES = new Set<string>([
  'backspace',
  'delete',
  'enter',
  'tab',
  'escape',
  'up',
  'down',
  'right',
  'left',
  'home',
  'end',
  'pageup',
  'pagedown',
  'command',
  'alt',
  'control',
  'shift',
  'right_shift',
  'space',
  'printscreen',
  'insert',
  'menu',
  'capslock',
  'numlock',
  'audio_mute',
  'audio_vol_down',
  'audio_vol_up',
  'audio_play',
  'audio_stop',
  'audio_pause',
  'audio_prev',
  'audio_next',
  'numpad_0',
  'numpad_1',
  'numpad_2',
  'numpad_3',
  'numpad_4',
  'numpad_5',
  'numpad_6',
  'numpad_7',
  'numpad_8',
  'numpad_9',
]);

export function mapPointerButton(button: number | undefined): MouseButton | null {
  switch (button) {
    case 1:
      return 'left';
    case 2:
      return 'right';
    case 3:
      return 'middle';
    case 4:
      return 'back';
    case 5:
      return 'forward';
    default:
      return null;
  }
}

export function mapHookKey(event: { keycode: number; keychar?: number }): string {
  const named = UIOHOOK_KEY_NAMES[event.keycode];
  if (named) return named;
  if (event.keychar && event.keychar > 31 && event.keychar < 127) {
    return String.fromCharCode(event.keychar).toLowerCase();
  }
  return `key_${event.keycode}`;
}

export function wheelDeltas(
  direction: number | undefined,
  rotation: number | undefined
): { dx: number; dy: number } | null {
  const amount = rotation ?? 0;
  if (!amount) return null;
  if (direction === UIOHOOK_WHEEL_HORIZONTAL) return { dx: amount, dy: 0 };
  if (direction === undefined || direction === UIOHOOK_WHEEL_VERTICAL) return { dx: 0, dy: amount };
  return null;
}

export function pointerMovedEnough(
  from: { x: number; y: number } | null,
  to: { x: number; y: number },
  elapsedMs: number,
  minIntervalMs: number
): boolean {
  if (!from) return false;
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  if (distance < 1) return false;
  if (distance >= POINTER_MOVE_MIN_DISTANCE_PX) return true;
  return elapsedMs >= minIntervalMs && distance >= 1;
}

const INPUT_LABELS: Record<string, [string, string]> = {
  mouse: ['pointer click', 'pointer clicks'],
  keyboard: ['key', 'keys'],
  move: ['pointer move', 'pointer moves'],
  wheel: ['scroll', 'scrolls'],
  gamepad: ['gamepad input', 'gamepad inputs'],
};

const INPUT_ORDER = ['mouse', 'keyboard', 'move', 'wheel', 'gamepad'];

export function summarizeRecordedInputs(events: Array<{ type: string }>): string {
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  }
  if (counts.size === 0) return 'No inputs captured.';
  const parts: string[] = [];
  for (const type of INPUT_ORDER) {
    const count = counts.get(type);
    if (!count) continue;
    const labels = INPUT_LABELS[type];
    parts.push(`${count} ${count === 1 ? labels[0] : labels[1]}`);
    counts.delete(type);
  }
  for (const [type, count] of counts) {
    parts.push(`${count} ${type}`);
  }
  return parts.join(', ');
}
