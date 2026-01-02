declare module 'uiohook-napi' {
  export const uIOhook: {
    on: (event: string, handler: (event: any) => void) => void;
    start: () => void;
    stop: () => void;
    removeAllListeners: () => void;
  };
}

declare module 'robotjs' {
  const robot: {
    moveMouse: (x: number, y: number) => void;
    mouseToggle: (state: 'down' | 'up', button: 'left' | 'right' | 'middle') => void;
    keyToggle: (key: string, state: 'down' | 'up') => void;
    keyTap: (key: string) => void;
  };
  export = robot;
}

declare module 'screenshot-desktop' {
  function screenshot(options?: { format?: string }): Promise<Buffer | string>;
  export default screenshot;
}
