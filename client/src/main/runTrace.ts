import { RunLifecycleTransition } from './runLifecycle';

export interface DispatchEntry {
    runId: string;
    attemptId: number;
    eventIndex: number;
    scheduledMs: number;
    actualMs: number;
    deltaMs: number;
    action: string;
}

export class RunTraceLogger {
    public logTransition(transition: RunLifecycleTransition): void {
        if (!transition.changed) return;
        const note = transition.event.note ? ` (${transition.event.note})` : '';
        console.debug(
            `[RunTrace] ${transition.prev} → ${transition.next} via ${transition.event.type}${note} [run=${transition.runId} attempt=${transition.attemptId}]`
        );
    }

    public logDispatch(entry: DispatchEntry): void {
        console.debug(
            `[RunTrace] dispatch #${entry.eventIndex} ${entry.action} scheduled=${entry.scheduledMs.toFixed(1)}ms actual=${entry.actualMs.toFixed(1)}ms Δ=${entry.deltaMs.toFixed(1)}ms [run=${entry.runId} attempt=${entry.attemptId}]`
        );
    }
}
