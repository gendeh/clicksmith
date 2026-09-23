import { desktopCapturer, screen } from 'electron';
import { exec } from 'child_process';
import { promisify } from 'util';
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
    private static readonly TARGET_BOUNDS_CACHE_TTL_MS = 1200;
    private nativeManager: any | null = null;
    private nativeLoadAttempted = false;
    private readonly execAsync = promisify(exec);
    private readonly targetBoundsCache = new Map<string, { bounds: WindowBounds; ts: number }>();
    private readonly targetBoundsInflight = new Map<string, Promise<WindowBounds | null>>();
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

    constructor() {}

    private ensureNativeManager() {
        if (this.nativeManager || this.nativeLoadAttempted) return;
        this.nativeLoadAttempted = true;
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            this.nativeManager = require('node-window-manager');
        } catch {
            this.nativeManager = null;
        }
    }

    public listWindows(): WindowInfo[] {
        this.ensureNativeManager();
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

    private isDirectTargetMatch(win: WindowInfo, normalizedTarget: string): boolean {
        const title = (win.title || '').toLowerCase();
        const exe = (win.executablePath || '').toLowerCase();
        const cls = (win.className || '').toLowerCase();
        return (
            title.includes(normalizedTarget) ||
            exe.includes(normalizedTarget) ||
            cls.includes(normalizedTarget)
        );
    }

    private isAppLabelMatch(win: WindowInfo, normalizedTarget: string): boolean {
        return this.mapWindowToAppLabel(win).toLowerCase() === normalizedTarget;
    }

    private pickBestWindowCandidate(candidates: WindowInfo[]): WindowInfo | null {
        if (candidates.length === 0) return null;
        const sorted = [...candidates].sort((a, b) => {
            const scoreA =
                (a.isFocused ? 8 : 0) +
                (a.isVisible ? 4 : 0) +
                (!a.isMinimized ? 2 : 0) +
                Math.min(1, (a.bounds.width * a.bounds.height) / 1_000_000);
            const scoreB =
                (b.isFocused ? 8 : 0) +
                (b.isVisible ? 4 : 0) +
                (!b.isMinimized ? 2 : 0) +
                Math.min(1, (b.bounds.width * b.bounds.height) / 1_000_000);
            return scoreB - scoreA;
        });
        return sorted[0] ?? null;
    }

    private cacheTargetBounds(normalizedTarget: string, bounds: WindowBounds) {
        this.targetBoundsCache.set(normalizedTarget, { bounds, ts: Date.now() });
    }

    private getCachedTargetBounds(normalizedTarget: string): WindowBounds | null {
        const entry = this.targetBoundsCache.get(normalizedTarget);
        if (!entry) return null;
        if (Date.now() - entry.ts > WindowManager.TARGET_BOUNDS_CACHE_TTL_MS) {
            return null;
        }
        return entry.bounds;
    }

    private getLastKnownTargetBounds(normalizedTarget: string): WindowBounds | null {
        return this.targetBoundsCache.get(normalizedTarget)?.bounds ?? null;
    }

    private getImmediateTargetBoundsFromNative(normalizedTarget: string): WindowBounds | null {
        const native = this.getNativeWindows();
        if (!native.length) return null;

        const active = this.getActiveWindow();
        if (active) {
            const activeDirect = this.isDirectTargetMatch(active, normalizedTarget);
            const activeApp = this.isAppLabelMatch(active, normalizedTarget);
            if (activeDirect || activeApp) return active.bounds;
        }

        const directCandidates = native.filter(win => this.isDirectTargetMatch(win, normalizedTarget));
        const directBest = this.pickBestWindowCandidate(directCandidates);
        if (directBest) return directBest.bounds;

        const appCandidates = native.filter(win => this.isAppLabelMatch(win, normalizedTarget));
        const appBest = this.pickBestWindowCandidate(appCandidates);
        if (appBest) return appBest.bounds;

        return null;
    }

    public async getTargetBoundsAsync(target: string): Promise<WindowBounds | null> {
        const normalizedTarget = (target || '').trim().toLowerCase();
        if (!normalizedTarget || normalizedTarget === 'screen') {
            return this.getFallbackWindowInfo().bounds;
        }

        const immediate = this.getImmediateTargetBoundsFromNative(normalizedTarget);
        if (immediate) {
            this.cacheTargetBounds(normalizedTarget, immediate);
            return immediate;
        }

        const inflight = this.targetBoundsInflight.get(normalizedTarget);
        if (inflight) return inflight;

        const request = (async () => {
            try {
                const macBounds = await this.getTargetBoundsViaMacOSAsync(normalizedTarget);
                if (macBounds) {
                    this.cacheTargetBounds(normalizedTarget, macBounds);
                    return macBounds;
                }
                return null;
            } finally {
                this.targetBoundsInflight.delete(normalizedTarget);
            }
        })();

        this.targetBoundsInflight.set(normalizedTarget, request);
        return request;
    }

    public getKnownTargetBounds(target: string): WindowBounds | null {
        const normalizedTarget = (target || '').trim().toLowerCase();
        if (!normalizedTarget || normalizedTarget === 'screen') {
            return this.getFallbackWindowInfo().bounds;
        }
        return (
            this.getImmediateTargetBoundsFromNative(normalizedTarget) ??
            this.getLastKnownTargetBounds(normalizedTarget)
        );
    }

    public getTargetBounds(target: string): WindowBounds {
        const normalizedTarget = (target || '').trim().toLowerCase();
        if (!normalizedTarget || normalizedTarget === 'screen') {
            return this.getFallbackWindowInfo().bounds;
        }

        const immediate = this.getImmediateTargetBoundsFromNative(normalizedTarget);
        if (immediate) {
            this.cacheTargetBounds(normalizedTarget, immediate);
            return immediate;
        }

        const known =
            this.getCachedTargetBounds(normalizedTarget) ?? this.getLastKnownTargetBounds(normalizedTarget);
        if (known) {
            void this.getTargetBoundsAsync(normalizedTarget).catch(() => null);
            return known;
        }

        void this.getTargetBoundsAsync(normalizedTarget).catch(() => null);

        return this.getFallbackWindowInfo().bounds;
    }

    /**
     * macOS fallback: use AppleScript to find a window's bounds when
     * node-window-manager is not available. Returns null if the window
     * cannot be found or we are not on macOS.
     */
    private async getTargetBoundsViaMacOSAsync(target: string): Promise<WindowBounds | null> {
        if (process.platform !== 'darwin') return null;
        const candidates = this.getMacProcessNameCandidates(target);
        for (const candidate of candidates) {
            try {
                const escapedTarget = candidate.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                // AppleScript fallback that finds a matching process by name
                // (exact first, then contains) and then prefers AXMain/AXFocused window.
                const script = `
        tell application "System Events"
          set targetName to "${escapedTarget}"
          set matchedProc to missing value
          repeat with proc in (every application process whose visible is true)
            set procName to (name of proc) as text
            ignoring case
              if procName is equal to targetName then
                set matchedProc to proc
                exit repeat
              end if
            end ignoring
          end repeat

          if matchedProc is missing value then
          repeat with proc in (every application process whose visible is true)
            set procName to (name of proc) as text
            ignoring case
              if procName contains targetName then
                set matchedProc to proc
                exit repeat
              end if
            end ignoring
          end repeat
          end if

          if matchedProc is missing value then
            return ""
          end if

          set win to missing value
          try
            set win to first window of matchedProc whose value of attribute "AXMain" is true
          on error
            try
              set win to first window of matchedProc whose value of attribute "AXFocused" is true
            on error
              try
                set win to window 1 of matchedProc
              on error
                return ""
              end try
            end try
          end try

          if win is missing value then
            return ""
          end if

          set {x, y} to position of win
          set {w, h} to size of win
          return (x as text) & "," & (y as text) & "," & (w as text) & "," & (h as text)
        end tell
      `;
                const { stdout } = await this.execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
                    timeout: 1200,
                });
                const result = stdout.trim();
                if (!result) continue;
                const parts = result.split(',').map(Number);
                if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) continue;
                return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
            } catch {
                continue;
            }
        }
        return null;
    }

    private getMacProcessNameCandidates(target: string): string[] {
        const normalized = target.trim().toLowerCase();
        const candidates = new Set<string>([normalized]);
        if (normalized.includes('terminal') || normalized.includes('iterm')) {
            candidates.add('iterm2');
            candidates.add('iterm');
            candidates.add('terminal');
        }
        if (normalized === 'code editor' || normalized.includes('vscode') || normalized.includes('visual studio code')) {
            candidates.add('visual studio code');
            candidates.add('code');
        }
        if (normalized === 'browser') {
            candidates.add('google chrome');
            candidates.add('safari');
            candidates.add('firefox');
            candidates.add('brave browser');
            candidates.add('arc');
        }
        return Array.from(candidates);
    }

    public getActiveWindow(): WindowInfo | null {
        this.ensureNativeManager();
        if (this.nativeManager?.windowManager?.getActiveWindow) {
            const active = this.nativeManager.windowManager.getActiveWindow() as NativeWindow | null;
            return active ? this.toWindowInfo(active, 0) : null;
        }
        return this.getFallbackWindowInfo();
    }

    public getPreferredTarget(): string {
        const active = this.getActiveWindow();
        if (!active) return 'screen';
        const label = this.mapWindowToAppLabel(active).trim();
        if (label && label.toLowerCase() !== 'screen') {
            return label;
        }
        const title = (active.title || '').trim();
        if (title) return title;
        return 'screen';
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
        const displays = screen.getAllDisplays();
        const primary = screen.getPrimaryDisplay();
        const minX = displays.length
            ? Math.min(...displays.map(display => display.bounds.x))
            : primary.bounds.x;
        const minY = displays.length
            ? Math.min(...displays.map(display => display.bounds.y))
            : primary.bounds.y;
        const maxX = displays.length
            ? Math.max(...displays.map(display => display.bounds.x + display.bounds.width))
            : primary.bounds.x + primary.bounds.width;
        const maxY = displays.length
            ? Math.max(...displays.map(display => display.bounds.y + display.bounds.height))
            : primary.bounds.y + primary.bounds.height;
        const bounds = {
            x: minX,
            y: minY,
            width: Math.max(1, maxX - minX),
            height: Math.max(1, maxY - minY),
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
