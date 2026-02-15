import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

const IPC_CHANNELS = {
  RECORDING_START: 'recording:start',
  RECORDING_STOP: 'recording:stop',
  RECORDING_PAUSE: 'recording:pause',
  RECORDING_EVENT: 'recording:event',
  RECORDING_STATUS: 'recording:status',
  PLAYBACK_START: 'playback:start',
  PLAYBACK_STOP: 'playback:stop',
  PLAYBACK_PAUSE: 'playback:pause',
  PLAYBACK_TAKEOVER: 'playback:takeover',
  PLAYBACK_STATUS: 'playback:status',
  PLAYBACK_SELECT: 'playback:select',
  PROFILE_LIST: 'profile:list',
  PROFILE_GET: 'profile:get',
  PROFILE_SAVE: 'profile:save',
  PROFILE_SAVE_DRAFT: 'profile:save-draft',
  PROFILE_DELETE: 'profile:delete',
  PROFILE_DISCARD_DRAFT: 'profile:discard-draft',
  PROFILE_EXPORT: 'profile:export',
  PROFILE_IMPORT: 'profile:import',
  PROFILE_SAVE_REQUEST: 'profile:save-request',
  WINDOW_LIST: 'window:list',
  WINDOW_FOCUS: 'window:focus',
  WINDOW_CAPTURE: 'window:capture',
  AUTH_LOGIN: 'auth:login',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_STATUS: 'auth:status',
  BILLING_CHECKOUT: 'billing:checkout',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SUBSCRIPTION_GET: 'subscription:get',
  SUBSCRIPTION_SET: 'subscription:set',
  EULA_ACCEPT: 'eula:accept',
  RUN_COMPLETE: 'run:complete',
  OVERLAY_SHOW: 'overlay:show',
  OVERLAY_HIDE: 'overlay:hide',
  OVERLAY_TOGGLE: 'overlay:toggle',
  MODS_LIST: 'mods:list',
  MODS_PROBE: 'mods:probe',
  MODS_LAUNCH: 'mods:launch',
  MODS_OPEN_DOC: 'mods:open-doc',
  MODS_OPEN_URL: 'mods:open-url',
  APP_QUIT: 'app:quit',
  APP_MINIMIZE: 'app:minimize',
  APP_VERSION: 'app:version',
} as const;

type AllowedInvokeChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
type AllowedSendChannel =
  | typeof IPC_CHANNELS.OVERLAY_SHOW
  | typeof IPC_CHANNELS.OVERLAY_HIDE
  | typeof IPC_CHANNELS.APP_MINIMIZE
  | typeof IPC_CHANNELS.APP_QUIT
  | 'overlay:set-interactive';
type AllowedListenChannel =
  | typeof IPC_CHANNELS.RECORDING_STATUS
  | typeof IPC_CHANNELS.PLAYBACK_STATUS
  | typeof IPC_CHANNELS.RUN_COMPLETE
  | typeof IPC_CHANNELS.PROFILE_SAVE_REQUEST
  | 'profile:saved';

const allowedInvoke = new Set<string>(Object.values(IPC_CHANNELS));
const allowedSend = new Set<string>([
  IPC_CHANNELS.OVERLAY_SHOW,
  IPC_CHANNELS.OVERLAY_HIDE,
  IPC_CHANNELS.APP_MINIMIZE,
  IPC_CHANNELS.APP_QUIT,
  'overlay:set-interactive',
]);
const allowedListen = new Set<string>([
  IPC_CHANNELS.RECORDING_STATUS,
  IPC_CHANNELS.PLAYBACK_STATUS,
  IPC_CHANNELS.RUN_COMPLETE,
  IPC_CHANNELS.PROFILE_SAVE_REQUEST,
  'profile:saved',
]);

const api = {
  invoke(channel: AllowedInvokeChannel, payload?: unknown) {
    if (!allowedInvoke.has(channel)) {
      throw new Error(`E_IPC_CHANNEL_NOT_ALLOWED:${channel}`);
    }
    return ipcRenderer.invoke(channel, payload);
  },
  send(channel: AllowedSendChannel, payload?: unknown) {
    if (!allowedSend.has(channel)) {
      throw new Error(`E_IPC_CHANNEL_NOT_ALLOWED:${channel}`);
    }
    ipcRenderer.send(channel, payload);
  },
  on(channel: AllowedListenChannel, listener: (...args: any[]) => void) {
    if (!allowedListen.has(channel)) {
      throw new Error(`E_IPC_CHANNEL_NOT_ALLOWED:${channel}`);
    }
    const wrapped = (_event: IpcRendererEvent, ...args: any[]) => listener(_event, ...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  removeAllListeners(channel: AllowedListenChannel) {
    if (!allowedListen.has(channel)) {
      throw new Error(`E_IPC_CHANNEL_NOT_ALLOWED:${channel}`);
    }
    ipcRenderer.removeAllListeners(channel);
  },
};

contextBridge.exposeInMainWorld('clicksmith', api);
