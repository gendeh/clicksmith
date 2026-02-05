import { EventEmitter } from 'events';

export type HookEventName = 'mousedown' | 'mouseup' | 'mousemove' | 'keydown' | 'keyup';

export interface HookMouseEvent {
  time?: number;
  x: number;
  y: number;
  button?: number;
  clicks?: number;
  altKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

export interface HookKeyEvent {
  time?: number;
  keycode: number;
  rawcode?: number;
  keychar?: number;
  altKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

export type HookEvent = HookMouseEvent | HookKeyEvent;

export interface InputHook {
  start: () => void;
  stop: () => void;
  on: (event: HookEventName, handler: (event: HookEvent) => void) => void;
  removeAllListeners: () => void;
}

export function createDefaultInputHook(): InputHook {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { uIOhook } = require('uiohook-napi');
  return uIOhook as InputHook;
}

export class MockInputHook extends EventEmitter implements InputHook {
  public start() {
    return;
  }

  public stop() {
    return;
  }
}
