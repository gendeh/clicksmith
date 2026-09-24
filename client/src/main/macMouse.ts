import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const MAC_MOUSE_SOURCE = `
#include <CoreGraphics/CoreGraphics.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static CGPoint current_pos(void) {
    CGEventRef event = CGEventCreate(NULL);
    CGPoint point = CGEventGetLocation(event);
    CFRelease(event);
    return point;
}

static CGMouseButton button_from(const char *name) {
    if (name && strcmp(name, "right") == 0) return kCGMouseButtonRight;
    if (name && strcmp(name, "middle") == 0) return kCGMouseButtonCenter;
    return kCGMouseButtonLeft;
}

static CGEventType down_type(CGMouseButton button) {
    if (button == kCGMouseButtonRight) return kCGEventRightMouseDown;
    if (button == kCGMouseButtonCenter) return kCGEventOtherMouseDown;
    return kCGEventLeftMouseDown;
}

static CGEventType up_type(CGMouseButton button) {
    if (button == kCGMouseButtonRight) return kCGEventRightMouseUp;
    if (button == kCGMouseButtonCenter) return kCGEventOtherMouseUp;
    return kCGEventLeftMouseUp;
}

static void post(CGEventType type, CGPoint point, CGMouseButton button) {
    CGEventRef event = CGEventCreateMouseEvent(NULL, type, point, button);
    if (!event) return;
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
}

int main(int argc, char **argv) {
    if (argc < 2) return 2;
    if (strcmp(argv[1], "pos") == 0) {
        CGPoint point = current_pos();
        printf("%.2f %.2f\\n", point.x, point.y);
        return 0;
    }
    if (strcmp(argv[1], "move") == 0 && argc >= 4) {
        post(kCGEventMouseMoved, CGPointMake(atof(argv[2]), atof(argv[3])), kCGMouseButtonLeft);
        return 0;
    }
    if ((strcmp(argv[1], "down") == 0 || strcmp(argv[1], "up") == 0) && argc >= 3) {
        CGMouseButton button = button_from(argv[2]);
        CGPoint point = current_pos();
        CGEventType type = strcmp(argv[1], "down") == 0 ? down_type(button) : up_type(button);
        post(type, point, button);
        return 0;
    }
    return 2;
}
`;

let compiledPath: string | null = null;

export function macMouseBinary(): string {
    if (compiledPath && existsSync(compiledPath)) return compiledPath;
    const hash = createHash('sha256').update(MAC_MOUSE_SOURCE).digest('hex').slice(0, 12);
    const dir = join(tmpdir(), 'clicksmith-mac-mouse');
    const binary = join(dir, `mac-mouse-${hash}`);
    if (!existsSync(binary)) {
        mkdirSync(dir, { recursive: true });
        const source = join(dir, `mac-mouse-${hash}.c`);
        writeFileSync(source, MAC_MOUSE_SOURCE);
        execFileSync('clang', ['-framework', 'CoreGraphics', '-framework', 'CoreFoundation', '-o', binary, source], { stdio: 'ignore' });
    }
    compiledPath = binary;
    return binary;
}

export function runMacMouse(args: string[]): string {
    return execFileSync(macMouseBinary(), args, { encoding: 'utf8' });
}
