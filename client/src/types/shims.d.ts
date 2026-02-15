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

type ClicksmithInvokeChannel =
  | 'recording:start'
  | 'recording:stop'
  | 'recording:pause'
  | 'recording:event'
  | 'recording:status'
  | 'playback:start'
  | 'playback:stop'
  | 'playback:pause'
  | 'playback:takeover'
  | 'playback:status'
  | 'playback:select'
  | 'profile:list'
  | 'profile:get'
  | 'profile:save'
  | 'profile:save-draft'
  | 'profile:delete'
  | 'profile:discard-draft'
  | 'profile:export'
  | 'profile:import'
  | 'profile:save-request'
  | 'window:list'
  | 'window:focus'
  | 'window:capture'
  | 'auth:login'
  | 'auth:logout'
  | 'auth:status'
  | 'billing:checkout'
  | 'settings:get'
  | 'settings:set'
  | 'subscription:get'
  | 'subscription:set'
  | 'eula:accept'
  | 'run:complete'
  | 'overlay:show'
  | 'overlay:hide'
  | 'overlay:toggle'
  | 'mods:list'
  | 'mods:probe'
  | 'mods:launch'
  | 'mods:open-doc'
  | 'mods:open-url'
  | 'app:quit'
  | 'app:minimize'
  | 'app:version';

type ClicksmithListenChannel =
  | 'recording:status'
  | 'playback:status'
  | 'run:complete'
  | 'profile:save-request'
  | 'profile:saved';

type ClicksmithSendChannel = 'overlay:set-interactive' | 'overlay:show' | 'overlay:hide' | 'app:minimize' | 'app:quit';

interface Window {
  clicksmith: {
    invoke: (channel: ClicksmithInvokeChannel, payload?: unknown) => Promise<any>;
    on: (channel: ClicksmithListenChannel, listener: (...args: any[]) => void) => () => void;
    removeAllListeners: (channel: ClicksmithListenChannel) => void;
    send: (channel: ClicksmithSendChannel, payload?: unknown) => void;
  };
}
