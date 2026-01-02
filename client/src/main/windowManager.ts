import { screen } from 'electron';
import { WindowBounds, WindowInfo } from '../types';

type NativeWindow = {
  getTitle?: () => string;
  getClassName?: () => string;
  getProcessId?: () => number;
  getBounds?: () => { x: number; y: number; width: number; height: number };
  isVisible?: () => boolean;
  isMinimized?: () => boolean;
  isFocused?: () => boolean;
  path?: string;
  title?: string;
};

export class WindowManager {
  private nativeManager: any | null = null;

  constructor() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      this.nativeManager = require('node-window-manager');
    } catch (error) {
      this.nativeManager = null;
    }
  }

  public listWindows(): WindowInfo[] {
    if (this.nativeManager?.windowManager?.getWindows) {
      const windows = this.nativeManager.windowManager.getWindows() as NativeWindow[];
      return windows.map((win, index) => this.toWindowInfo(win, index));
    }

    return [this.getFallbackWindowInfo()];
  }

  public getTargetBounds(target: string): WindowBounds {
    const match = this.listWindows().find(win => win.title.includes(target) || win.executablePath.includes(target));
    return match?.bounds ?? this.getFallbackWindowInfo().bounds;
  }

  public getActiveWindow(): WindowInfo | null {
    if (this.nativeManager?.windowManager?.getActiveWindow) {
      const active = this.nativeManager.windowManager.getActiveWindow() as NativeWindow | null;
      return active ? this.toWindowInfo(active, 0) : null;
    }
    return this.getFallbackWindowInfo();
  }

  private toWindowInfo(win: NativeWindow, index: number): WindowInfo {
    const bounds = win.getBounds?.() ?? { x: 0, y: 0, width: 0, height: 0 };
    return {
      handle: index,
      title: win.getTitle?.() ?? win.title ?? 'Unknown',
      className: win.getClassName?.() ?? 'Unknown',
      processId: win.getProcessId?.() ?? 0,
      executablePath: win.path ?? 'unknown',
      bounds,
      isVisible: win.isVisible?.() ?? true,
      isMinimized: win.isMinimized?.() ?? false,
      isFocused: win.isFocused?.() ?? false,
    };
  }

  private getFallbackWindowInfo(): WindowInfo {
    const primary = screen.getPrimaryDisplay();
    const bounds = {
      x: primary.bounds.x,
      y: primary.bounds.y,
      width: primary.bounds.width,
      height: primary.bounds.height,
    };
    return {
      handle: 0,
      title: 'Screen',
      className: 'Screen',
      processId: 0,
      executablePath: 'screen',
      bounds,
      isVisible: true,
      isMinimized: false,
      isFocused: true,
    };
  }
}
