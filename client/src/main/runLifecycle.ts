export type RunLifecycleState =
  | 'idle'
  | 'record_armed'
  | 'record_live'
  | 'replay_armed'
  | 'replay_live'
  | 'takeover_live'
  | 'finalizing';

export type RunLifecycleEventType =
  | 'arm_record'
  | 'arm_replay'
  | 'attempt_boundary'
  | 'takeover_click'
  | 'death'
  | 'level_complete'
  | 'pause'
  | 'unpause'
  | 'stop_record'
  | 'stop_replay'
  | 'finalize_done'
  | 'cancel';

export interface RunLifecycleEvent {
  type: RunLifecycleEventType;
  atMs: number;
  note?: string;
}

export interface RunLifecycleSnapshot {
  state: RunLifecycleState;
  runId: string;
  attemptId: number;
  paused: boolean;
}

export interface RunLifecycleTransition {
  event: RunLifecycleEvent;
  prev: RunLifecycleSnapshot;
  next: RunLifecycleSnapshot;
  changed: boolean;
}

type MutableLifecycle = {
  state: RunLifecycleState;
  runId: string;
  attemptId: number;
  paused: boolean;
};

function makeRunId(nowMs: number): string {
  const rand = Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, '0');
  return `run-${nowMs}-${rand}`;
}

export class RunLifecycleManager {
  private current: MutableLifecycle = {
    state: 'idle',
    runId: makeRunId(Date.now()),
    attemptId: 0,
    paused: false,
  };

  public getSnapshot(): RunLifecycleSnapshot {
    return {
      state: this.current.state,
      runId: this.current.runId,
      attemptId: this.current.attemptId,
      paused: this.current.paused,
    };
  }

  public apply(event: RunLifecycleEvent): RunLifecycleTransition {
    const prev = this.getSnapshot();
    const next = this.reduce(prev, event);
    this.current = {
      state: next.state,
      runId: next.runId,
      attemptId: next.attemptId,
      paused: next.paused,
    };
    return {
      event,
      prev,
      next,
      changed:
        prev.state !== next.state ||
        prev.runId !== next.runId ||
        prev.attemptId !== next.attemptId ||
        prev.paused !== next.paused,
    };
  }

  private reduce(state: RunLifecycleSnapshot, event: RunLifecycleEvent): RunLifecycleSnapshot {
    const next: RunLifecycleSnapshot = { ...state };

    switch (event.type) {
      case 'arm_record': {
        if (state.state === 'record_armed') {
          next.state = 'idle';
          return next;
        }
        if (state.state === 'record_live' || state.state === 'takeover_live') {
          next.state = 'finalizing';
          return next;
        }
        next.state = 'record_armed';
        next.runId = makeRunId(event.atMs);
        next.attemptId = 0;
        next.paused = false;
        return next;
      }
      case 'arm_replay': {
        if (state.state === 'replay_armed') {
          next.state = 'idle';
          return next;
        }
        if (state.state === 'replay_live') {
          next.state = 'idle';
          next.paused = false;
          return next;
        }
        next.state = 'replay_armed';
        next.runId = makeRunId(event.atMs);
        next.attemptId = 0;
        next.paused = false;
        return next;
      }
      case 'attempt_boundary': {
        next.attemptId = state.attemptId + 1;
        next.paused = false;
        if (state.state === 'record_armed') {
          next.state = 'record_live';
        } else if (state.state === 'replay_armed') {
          next.state = 'replay_live';
        }
        return next;
      }
      case 'takeover_click': {
        if (state.state === 'replay_live' || state.state === 'replay_armed') {
          next.state = 'takeover_live';
          next.paused = false;
        }
        return next;
      }
      case 'pause': {
        if (state.state === 'replay_live' || state.state === 'record_live' || state.state === 'takeover_live') {
          next.paused = true;
        }
        return next;
      }
      case 'unpause': {
        next.paused = false;
        return next;
      }
      case 'death':
      case 'level_complete': {
        next.paused = false;
        if (state.state === 'record_live' || state.state === 'takeover_live') {
          next.state = 'finalizing';
        } else if (state.state === 'replay_live') {
          next.state = 'idle';
        }
        return next;
      }
      case 'stop_record': {
        if (state.state === 'record_armed') {
          next.state = 'idle';
        } else if (state.state === 'record_live' || state.state === 'takeover_live') {
          next.state = 'finalizing';
        }
        next.paused = false;
        return next;
      }
      case 'stop_replay': {
        if (state.state === 'replay_live' || state.state === 'replay_armed') {
          next.state = 'idle';
        }
        next.paused = false;
        return next;
      }
      case 'cancel': {
        next.state = 'idle';
        next.paused = false;
        return next;
      }
      case 'finalize_done': {
        if (state.state === 'finalizing') {
          next.state = 'idle';
        }
        next.paused = false;
        return next;
      }
      default:
        return next;
    }
  }
}
