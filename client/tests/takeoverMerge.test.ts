import { mergeTakeoverEvents } from '../src/main/takeoverMerge';
import { Profile, RecordedEvent } from '../src/types';

function makeBaseProfile(events: RecordedEvent[]): Profile {
  return {
    id: 'base',
    name: 'Base',
    target_app: 'Geometry Dash',
    created_at: new Date().toISOString(),
    events,
    success_metric: { furthest_frame: 0, score: 0 },
    version: 1,
    notes: '',
  };
}

describe('mergeTakeoverEvents', () => {
  test('splices takeover segment exactly at takeover boundary', () => {
    const base = makeBaseProfile([
      {
        t_ms: 100,
        type: 'mouse',
        btn: 'left',
        x: 1,
        y: 1,
        rel_x: 0,
        rel_y: 0,
        duration_ms: 0,
        human_override: false,
      },
      {
        t_ms: 130,
        type: 'mouse',
        btn: 'left',
        x: 1,
        y: 1,
        rel_x: 0,
        rel_y: 0,
        duration_ms: 40,
        human_override: false,
      },
    ]);

    const takeoverEvents: RecordedEvent[] = [
      {
        t_ms: 0,
        type: 'mouse',
        btn: 'left',
        x: 2,
        y: 2,
        rel_x: 0,
        rel_y: 0,
        duration_ms: 0,
        human_override: false,
      },
      {
        t_ms: 20,
        type: 'mouse',
        btn: 'left',
        x: 2,
        y: 2,
        rel_x: 0,
        rel_y: 0,
        duration_ms: 0,
        human_override: false,
      },
    ];

    const merged = mergeTakeoverEvents(base, 150, takeoverEvents);
    const takeoverStart = merged.find(event => event.metadata?.takeover_segment);
    expect(takeoverStart?.t_ms).toBe(150);
    expect(merged[1].duration_ms).toBe(20);
  });

  test('result is sorted and preserves chronology', () => {
    const base = makeBaseProfile([
      {
        t_ms: 10,
        type: 'mouse',
        btn: 'left',
        x: 1,
        y: 1,
        rel_x: 0,
        rel_y: 0,
        duration_ms: 0,
        human_override: false,
      },
    ]);
    const takeoverEvents: RecordedEvent[] = [
      {
        t_ms: 60,
        type: 'mouse',
        btn: 'left',
        x: 1,
        y: 1,
        rel_x: 0,
        rel_y: 0,
        duration_ms: 0,
        human_override: false,
      },
      {
        t_ms: 0,
        type: 'mouse',
        btn: 'left',
        x: 1,
        y: 1,
        rel_x: 0,
        rel_y: 0,
        duration_ms: 0,
        human_override: false,
      },
    ];
    const merged = mergeTakeoverEvents(base, 200, takeoverEvents);
    for (let i = 1; i < merged.length; i += 1) {
      expect(merged[i].t_ms).toBeGreaterThanOrEqual(merged[i - 1].t_ms);
    }
  });
});
