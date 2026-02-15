import { RunLifecycleTransition } from './runLifecycle';

export interface DispatchTrace {
  runId: string;
  attemptId: number;
  eventIndex: number;
  scheduledMs: number;
  actualMs: number;
  deltaMs: number;
  action: string;
}

export class RunTraceLogger {
  public logTransition(transition: RunLifecycleTransition) {
    const payload = {
      type: 'lifecycle_transition',
      ts: transition.event.atMs,
      event: transition.event.type,
      note: transition.event.note,
      prevState: transition.prev.state,
      nextState: transition.next.state,
      runId: transition.next.runId,
      attemptId: transition.next.attemptId,
      paused: transition.next.paused,
      changed: transition.changed,
    };
    console.info(`[run-trace] ${JSON.stringify(payload)}`);
  }

  public logDispatch(trace: DispatchTrace) {
    const payload = {
      type: 'playback_dispatch',
      ts: Date.now(),
      runId: trace.runId,
      attemptId: trace.attemptId,
      eventIndex: trace.eventIndex,
      scheduled_t_ms: trace.scheduledMs,
      actual_t_ms: trace.actualMs,
      delta_ms: trace.deltaMs,
      action: trace.action,
    };
    console.info(`[run-trace] ${JSON.stringify(payload)}`);
  }
}
