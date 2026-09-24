import { ROBOT_KEY_NAMES } from '../types/input';
import type { MouseButton } from '../types';

export class InputPlayer {
    private _robot: any = null;
    private _robotInstance: any;
    private keyAliases: Record<string, string> = {
        ctrl: 'control',
        control: 'control',
        alt: 'alt',
        option: 'alt',
        shift: 'shift',
        meta: 'command',
        cmd: 'command',
        command: 'command',
        esc: 'escape',
        escape: 'escape',
        enter: 'enter',
        return: 'enter',
        backspace: 'backspace',
        delete: 'delete',
        tab: 'tab',
        space: 'space',
        up: 'up',
        down: 'down',
        left: 'left',
        right: 'right',
        home: 'home',
        end: 'end',
        pageup: 'pageup',
        pagedown: 'pagedown',
        capslock: 'capslock',
    };

    private gamepadOutput: {
        button: (pad: number, index: number, down: boolean) => boolean;
        axis: (pad: number, index: number, value: number) => boolean;
    } | null;

    constructor(robotInstance?: any, gamepadOutput?: InputPlayer['gamepadOutput']) {
        this._robotInstance = robotInstance ?? null;
        this.gamepadOutput = gamepadOutput ?? null;
    }

    private get robot(): any {
        if (!this._robot) {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            this._robot = this._robotInstance || require('robotjs');
        }
        return this._robot;
    }

    public moveMouse(x: number, y: number) {
        this.robot.moveMouse(Math.round(x), Math.round(y));
    }

    public mouseDown(button: MouseButton) {
        try {
            this.robot.mouseToggle('down', button);
            return true;
        } catch {
            return false;
        }
    }

    public mouseUp(button: MouseButton) {
        try {
            this.robot.mouseToggle('up', button);
            return true;
        } catch {
            return false;
        }
    }

    public scroll(dx: number, dy: number) {
        try {
            if (typeof this.robot.scrollMouse !== 'function') return false;
            this.robot.scrollMouse(Math.round(dx), Math.round(dy));
            return true;
        } catch {
            return false;
        }
    }

    public gamepadButton(pad: number, index: number, down: boolean) {
        const output = this.gamepadOutput;
        if (!output) return false;
        return output.button(pad, index, down);
    }

    public gamepadAxis(pad: number, index: number, value: number) {
        const output = this.gamepadOutput;
        if (!output) return false;
        return output.axis(pad, index, value);
    }

    public async clickWithDuration(button: MouseButton, durationMs: number) {
        this.mouseDown(button);
        if (durationMs > 0) {
            await this.sleepPrecise(durationMs);
        }
        this.mouseUp(button);
    }

    public keyDown(key: string) {
        const normalized = this.normalizeKey(key);
        if (!normalized) return false;
        try {
            this.robot.keyToggle(normalized, 'down');
            return true;
        } catch {
            return false;
        }
    }

    public keyUp(key: string) {
        const normalized = this.normalizeKey(key);
        if (!normalized) return false;
        try {
            this.robot.keyToggle(normalized, 'up');
            return true;
        } catch {
            return false;
        }
    }

    public keyTap(key: string) {
        const normalized = this.normalizeKey(key);
        if (!normalized) return false;
        try {
            this.robot.keyTap(normalized);
            return true;
        } catch {
            return false;
        }
    }

    public async wait(durationMs: number) {
        await this.sleepPrecise(durationMs);
    }

    private normalizeKey(key: string): string | null {
        if (!key) return null;
        const lower = key.toLowerCase();
        if (this.keyAliases[lower]) {
            return this.keyAliases[lower];
        }
        if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) {
            return lower;
        }
        if (ROBOT_KEY_NAMES.has(lower)) {
            return lower;
        }
        if (lower.length === 1) {
            return lower;
        }
        return null;
    }

    private async sleepPrecise(durationMs: number) {
        if (durationMs <= 0) return;
        const targetNs = BigInt(Math.round(durationMs * 1_000_000));
        const start = process.hrtime.bigint();

        while (true) {
            const elapsedNs = process.hrtime.bigint() - start;
            const remainingNs = targetNs - elapsedNs;
            if (remainingNs <= 0n) break;
            const remainingMs = Number(remainingNs) / 1_000_000;
            if (remainingMs > 6) {
                await new Promise(resolve => setTimeout(resolve, Math.max(1, remainingMs - 3)));
            } else if (remainingMs > 1) {
                await new Promise(resolve => setTimeout(resolve, 1));
            } else {
                // Busy wait for sub-millisecond precision.
            }
        }
    }
}
