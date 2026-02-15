import { v4 as uuidv4 } from 'uuid';

export type RunLifecycleEventType =
    | 'arm_record'
    | 'arm_replay'
    | 'attempt_boundary'
    | 'stop_record'
    | 'stop_replay'
    | 'finalize_done'
    | 'takeover_click'
    | 'pause'
    | 'unpause';

type RunLifecycleState =
    | 'idle'
    | 'record_armed'
    | 'recording'
    | 'record_live'
    | 'replay_armed'
    | 'replaying'
    | 'paused'
    | 'takeover_live'
    | 'finalizing';

export interface RunLifecycleEvent {
    type: RunLifecycleEventType;
    atMs: number;
    note?: string;
}

export interface RunLifecycleSnapshot {
    state: RunLifecycleState;
    runId: string;
    attemptId: number;
}

export interface RunLifecycleTransition {
    changed: boolean;
    prev: RunLifecycleState;
    next: RunLifecycleState;
    event: RunLifecycleEvent;
    runId: string;
    attemptId: number;
}

export class RunLifecycleManager {
    private state: RunLifecycleState = 'idle';
    private runId: string = uuidv4();
    private attemptId = 0;

    public getSnapshot(): RunLifecycleSnapshot {
        return { state: this.state, runId: this.runId, attemptId: this.attemptId };
    }

    public apply(event: RunLifecycleEvent): RunLifecycleTransition {
        const prev = this.state;
        const next = this.transition(event.type);
        const changed = prev !== next;
        if (changed) {
            this.state = next;
        }
        return {
            changed,
            prev,
            next,
            event,
            runId: this.runId,
            attemptId: this.attemptId,
        };
    }

    private transition(type: RunLifecycleEventType): RunLifecycleState {
        switch (type) {
            case 'arm_record':
                this.runId = uuidv4();
                this.attemptId = 0;
                return 'record_armed';
            case 'arm_replay':
                this.runId = uuidv4();
                this.attemptId = 0;
                return 'replay_armed';
            case 'attempt_boundary':
                this.attemptId += 1;
                if (this.state === 'record_armed') return 'recording';
                if (this.state === 'replay_armed') return 'replaying';
                return this.state;
            case 'stop_record':
            case 'stop_replay':
            case 'finalize_done':
                return 'idle';
            case 'takeover_click':
                return 'idle';
            case 'pause':
                return 'paused';
            case 'unpause':
                if (this.state === 'paused') return 'replaying';
                return this.state;
            default:
                return this.state;
        }
    }
}
