type ClicksmithListener = (event: unknown, ...args: any[]) => void;

declare global {
    interface Window {
        clicksmith: {
            invoke: (channel: string, payload?: unknown) => Promise<any>;
            send: (channel: string, payload?: unknown) => void;
            on: (channel: string, listener: ClicksmithListener) => void;
            once: (channel: string, listener: ClicksmithListener) => void;
            removeListener: (channel: string, listener: ClicksmithListener) => void;
            removeAllListeners: (channel: string) => void;
        };
    }
}

export {};
