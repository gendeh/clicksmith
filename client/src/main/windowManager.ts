import { desktopCapturer, screen } from 'electron';
import { execSync } from 'child_process';
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
    private readonly appLabelMap: Array<{ pattern: RegExp; label: string }> = [
        { pattern: /google chrome|chrome/i, label: 'Google Chrome' },
        { pattern: /brave/i, label: 'Brave' },
        { pattern: /arc/i, label: 'Arc' },
        { pattern: /safari/i, label: 'Safari' },
        { pattern: /firefox/i, label: 'Firefox' },
        { pattern: /visual studio code|code/i, label: 'VS Code' },
        { pattern: /terminal|iterm/i, label: 'Terminal' },
        { pattern: /steam/i, label: 'Steam' },
        { pattern: /discord/i, label: 'Discord' },
        { pattern: /finder/i, label: 'Finder' },
        { pattern: /clicksmith/i, label: 'Clicksmith' },
    ];

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

    private getNativeWindows(): WindowInfo[] {
        const listed = this.listWindows();
        return listed.filter(win => (win.title || '').trim().toLowerCase() !== 'screen');
    }

    public async listWindowsForPicker(): Promise<WindowInfo[]> {
        const native = this.listWindows();
        const meaningfulNative = native.filter(win => (win.title || '').trim().toLowerCase() !== 'screen');
        if (meaningfulNative.length > 0) {
            return [this.getFallbackWindowInfo(), ...this.toAppLevelEntries(meaningfulNative)];
        }

        try {
            const sources = await desktopCapturer.getSources({
                types: ['window'],
                thumbnailSize: { width: 0, height: 0 },
                fetchWindowIcons: false,
            });
            const fallbackBounds = this.getFallbackWindowInfo().bounds;
            const windows: WindowInfo[] = sources.map((source, index) => {
                const label = this.sanitizeDesktopSourceLabel(source.name ?? '');
                return {
                    handle: index + 1,
                    title: label,
                    className: 'DesktopCapturer',
                    processId: 0,
                    executablePath: label.toLowerCase(),
                    bounds: fallbackBounds,
                    isVisible: true,
                    isMinimized: false,
                    isFocused: false,
                };
            });
            const deduped = this.dedupeByTitle(windows);
            if (deduped.length > 0) {
                return [this.getFallbackWindowInfo(), ...deduped];
            }
        } catch {
            // Ignore and fall back to the default screen-only list.
        }

        return native;
    }

    private toAppLevelEntries(windows: WindowInfo[]): WindowInfo[] {
        const sorted = [...windows].sort((a, b) => {
            const focusScoreA = (a.isFocused ? 2 : 0) + (a.isVisible ? 1 : 0);
            const focusScoreB = (b.isFocused ? 2 : 0) + (b.isVisible ? 1 : 0);
            return focusScoreB - focusScoreA;
        });
        const entries = sorted.map((win, index) => {
            const basename = this.extractExecutableName(win.executablePath);
            const mapped = this.mapAppLabel(`${basename} ${win.className} ${win.title}`);
            const label = mapped ?? (basename || 'App Window');
            return {
                ...win,
                handle: index + 1,
                title: label,
            };
        });
        return this.dedupeByTitle(entries);
    }

    private dedupeByTitle(windows: WindowInfo[]): WindowInfo[] {
        const deduped = new Map<string, WindowInfo>();
        windows.forEach(win => {
            const title = (win.title || '').trim();
            if (!title || title.toLowerCase() === 'screen') return;
            const key = title.toLowerCase();
            if (!deduped.has(key)) deduped.set(key, win);
        });
        return Array.from(deduped.values());
    }

    private sanitizeDesktopSourceLabel(rawName: string): string {
        const text = rawName.trim();
        const mapped = this.mapAppLabel(text);
        if (mapped) return mapped;

        const segments = text.split(/\s[-—]\s/).map(item => item.trim()).filter(Boolean);
        if (segments.length > 1) {
            const tail = segments[segments.length - 1];
            const mappedTail = this.mapAppLabel(tail);
            if (mappedTail) return mappedTail;
        }

        if (/\.(md|ts|tsx|js|json|py|cpp|txt)\b/i.test(text)) {
            return 'Code Editor';
        }
        if (/[a-z0-9-]+\.[a-z]{2,}/i.test(text) || /youtube|barron|news|google|reddit/i.test(text)) {
            return 'Browser';
        }
        if (/^maxgendeh@|~|zsh|bash|terminal/i.test(text)) {
            return 'Terminal';
        }
        return 'App Window';
    }

    private mapAppLabel(text: string): string | null {
        for (const item of this.appLabelMap) {
            if (item.pattern.test(text)) return item.label;
        }
        return null;
    }

    private mapWindowToAppLabel(win: WindowInfo): string {
        const basename = this.extractExecutableName(win.executablePath);
        const mapped = this.mapAppLabel(`${basename} ${win.className} ${win.title}`);
        return mapped ?? (basename || 'App Window');
    }

    private extractExecutableName(executablePath: string): string {
        if (!executablePath || executablePath === 'unknown') return '';
        const parts = executablePath.split('/').filter(Boolean);
        const last = parts[parts.length - 1] ?? '';
        return last.replace(/\.(app|exe)$/i, '').trim();
    }

    public getTargetBounds(target: string): WindowBounds {
        const normalizedTarget = (target || '').trim().toLowerCase();
        if (!normalizedTarget || normalizedTarget === 'screen') {
            return this.getFallbackWindowInfo().bounds;
        }

        const native = this.getNativeWindows();
        if (native.length > 0) {
            const directMatch = native.find(win => {
                const title = (win.title || '').toLowerCase();
                const exe = (win.executablePath || '').toLowerCase();
                const cls = (win.className || '').toLowerCase();
                return title.includes(normalizedTarget) || exe.includes(normalizedTarget) || cls.includes(normalizedTarget);
            });
            if (directMatch) return directMatch.bounds;

            const appMatch = native.find(win => this.mapWindowToAppLabel(win).toLowerCase() === normalizedTarget);
            if (appMatch) return appMatch.bounds;

            const active = this.getActiveWindow();
            if (active && this.mapWindowToAppLabel(active).toLowerCase() === normalizedTarget) {
                return active.bounds;
            }
        }

        // macOS AppleScript fallback when node-window-manager is not installed
        const macBounds = this.getTargetBoundsViaMacOS(normalizedTarget);
        if (macBounds) return macBounds;

        return this.getFallbackWindowInfo().bounds;
    }

    /**
     * macOS fallback: use AppleScript to find a window's bounds when
     * node-window-manager is not available. Returns null if the window
     * cannot be found or we are not on macOS.
     */
    private getTargetBoundsViaMacOS(target: string): WindowBounds | null {
        if (process.platform !== 'darwin') return null;
        try {
            // AppleScript that searches all running apps for a window whose
            // process name or window title contains the target string.
            const script = `
        tell application "System Events"
          set matchedBounds to ""
          repeat with proc in (every application process whose visible is true)
            set procName to name of proc
            if procName contains "${target}" then
              try
                set win to first window of proc
                set {x, y} to position of win
                set {w, h} to size of win
                return (x as text) & "," & (y as text) & "," & (w as text) & "," & (h as text)
              end try
            end if
          end repeat
          return ""
        end tell
      `;
            const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}' 2>/dev/null`, {
                timeout: 2000,
                encoding: 'utf-8',
            }).trim();
            if (!result) return null;
            const parts = result.split(',').map(Number);
            if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) return null;
            return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
        } catch {
            return null;
        }
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
