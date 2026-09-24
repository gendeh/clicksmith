import { closeSync, constants, openSync, readdirSync, readSync } from 'fs';

export type GamepadSample = {
  pad: number;
  kind: 'button' | 'axis';
  index: number;
  value: number;
};

export interface GamepadSource {
  start: () => void;
  stop: () => void;
  poll: () => GamepadSample[];
}

export function decodeJsEvents(buffer: Buffer, pad: number): GamepadSample[] {
  const samples: GamepadSample[] = [];
  for (let offset = 0; offset + 8 <= buffer.length; offset += 8) {
    const value = buffer.readInt16LE(offset + 4);
    const type = buffer.readUInt8(offset + 6);
    const index = buffer.readUInt8(offset + 7);
    if ((type & 0x80) !== 0) continue;
    const kind = type & 0x7f;
    if (kind === 0x01) {
      samples.push({ pad, kind: 'button', index, value: value ? 1 : 0 });
    } else if (kind === 0x02) {
      const normalized = Math.max(-1, Math.min(1, value / 32767));
      samples.push({ pad, kind: 'axis', index, value: normalized });
    }
  }
  return samples;
}

export class LinuxJoystickSource implements GamepadSource {
  private fds: Array<{ fd: number; pad: number }> = [];

  public start() {
    this.stop();
    let names: string[] = [];
    try {
      names = readdirSync('/dev/input').filter(name => /^js\d+$/.test(name)).sort();
    } catch {
      return;
    }
    names.forEach((name, pad) => {
      try {
        const fd = openSync(`/dev/input/${name}`, constants.O_RDONLY | constants.O_NONBLOCK);
        this.fds.push({ fd, pad });
      } catch {
        return;
      }
    });
  }

  public stop() {
    for (const entry of this.fds) {
      try {
        closeSync(entry.fd);
      } catch {
        // already closed
      }
    }
    this.fds = [];
  }

  public poll(): GamepadSample[] {
    const samples: GamepadSample[] = [];
    const buf = Buffer.alloc(64 * 8);
    for (const entry of this.fds) {
      try {
        const read = readSync(entry.fd, buf, 0, buf.length, null);
        if (read > 0) {
          samples.push(...decodeJsEvents(buf.subarray(0, read), entry.pad));
        }
      } catch (error: unknown) {
        const code = (error as { code?: string }).code;
        if (code === 'EAGAIN' || code === 'EWOULDBLOCK') continue;
      }
    }
    return samples;
  }
}
