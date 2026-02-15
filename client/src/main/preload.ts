import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

type Listener = (event: IpcRendererEvent, ...args: any[]) => void;

const clicksmithBridge = {
    invoke(channel: string, payload?: unknown) {
        return ipcRenderer.invoke(channel, payload);
    },
    send(channel: string, payload?: unknown) {
        ipcRenderer.send(channel, payload);
    },
    on(channel: string, listener: Listener) {
        ipcRenderer.on(channel, listener);
    },
    once(channel: string, listener: Listener) {
        ipcRenderer.once(channel, listener);
    },
    removeListener(channel: string, listener: Listener) {
        ipcRenderer.removeListener(channel, listener);
    },
    removeAllListeners(channel: string) {
        ipcRenderer.removeAllListeners(channel);
    },
};

contextBridge.exposeInMainWorld('clicksmith', clicksmithBridge);
