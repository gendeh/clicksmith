import fs from 'fs';
import path from 'path';
import { Profile, RecordedEvent } from '../src/types';
import { mergeTakeoverEvents, reportTakeoverAppend } from '../src/domain/takeoverAppend';

function event(partial: Pick<RecordedEvent, 't_ms' | 'type'> & Partial<RecordedEvent>): RecordedEvent {
  return {
    x: 0,
    y: 0,
    rel_x: 0,
    rel_y: 0,
    duration_ms: 16,
    human_override: false,
    ...partial,
  };
}

function profile(events: RecordedEvent[]): Profile {
  return {
    id: 'base',
    name: 'Base',
    target_app: 'Minecraft',
    created_at: '2026-01-01T00:00:00Z',
    events,
    success_metric: { furthest_frame: 0, score: 0 },
    version: 1,
    notes: '',
  };
}

describe('takeover append', () => {
  const base = profile([
    event({ t_ms: 0, type: 'mouse', btn: 'left' }),
    event({ t_ms: 80, type: 'keyboard', key: 'w', duration_ms: 200, metadata: { action: 'down' } }),
    event({ t_ms: 400, type: 'keyboard', key: 'space' }),
  ]);

  test('keeps the head, clips a hold at the grab, and appends your click and key on the boundary', () => {
    const human = [
      event({ t_ms: 0, type: 'mouse', btn: 'right', human_override: false }),
      event({ t_ms: 40, type: 'keyboard', key: 'e' }),
    ];
    const merged = mergeTakeoverEvents(base, 120, human);
    const report = reportTakeoverAppend(base.events.length, merged, 120);

    expect(merged.map(item => [item.t_ms, item.type, item.key ?? item.btn, item.human_override])).toEqual([
      [0, 'mouse', 'left', false],
      [80, 'keyboard', 'w', false],
      [120, 'mouse', 'right', true],
      [160, 'keyboard', 'e', true],
    ]);
    expect(merged.find(item => item.key === 'w')?.metadata).toMatchObject({ release_t_ms: 120 });
    expect(report).toEqual({
      kept: 2,
      replaced: 1,
      appended: 2,
      takeoverStartMs: 120,
      gapMs: 0,
    });
  });

  test('drops the macro tail when the grab is at the first event', () => {
    const merged = mergeTakeoverEvents(base, 0, [event({ t_ms: 0, type: 'keyboard', key: 'f' })]);
    expect(merged).toEqual([
      expect.objectContaining({ t_ms: 0, key: 'f', human_override: true }),
    ]);
    expect(reportTakeoverAppend(base.events.length, merged, 0).gapMs).toBe(0);
  });

  test('writes the merged profile for the API lane when asked', () => {
    const out = process.env.CLICKSMITH_API_FIXTURE;
    const merged = mergeTakeoverEvents(base, 120, [
      event({ t_ms: 0, type: 'mouse', btn: 'right' }),
      event({ t_ms: 40, type: 'keyboard', key: 'e' }),
    ]);
    const report = reportTakeoverAppend(base.events.length, merged, 120);
    if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(
      out,
      JSON.stringify({
        name: 'Minecraft wheel grab',
        target_app: 'Minecraft',
        created_at: '2026-01-01T00:00:00Z',
        events: merged,
        success_metric: { furthest_frame: 0, score: 0 },
        version: 1,
        notes: '',
        metadata: {
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          version: 1,
          total_duration_ms: 184,
          event_count: merged.length,
          override_count: report.appended,
          tags: ['takeover'],
          custom: { game_id: 'minecraft', takeover_start_ms: 120 },
        },
      })
    );
    }
    expect(report.gapMs).toBe(0);
    expect(report.appended).toBe(2);
  });
});

const runRepro = process.env.CLICKSMITH_REPRO === '1';

(runRepro ? test : test.skip)('writes a takeover timeline and optional heap snapshot', () => {
  const baseEvents = Array.from({ length: 5000 }, (_, index) =>
    event({ t_ms: index * 10, type: index % 2 === 0 ? 'mouse' : 'keyboard', btn: 'left', key: 'space' })
  );
  const human = [
    event({ t_ms: 0, type: 'mouse', btn: 'left' }),
    event({ t_ms: 25, type: 'keyboard', key: 'e' }),
  ];
  const started = process.hrtime.bigint();
  const merged = mergeTakeoverEvents(profile(baseEvents), 1000, human);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const report = reportTakeoverAppend(baseEvents.length, merged, 1000);
  const outPath =
    process.env.CLICKSMITH_REPRO_OUT ??
    path.resolve(__dirname, '../../.cursor/skills/verify-clicksmith/artifacts/repro-takeover/report.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const payload: Record<string, unknown> = {
    elapsedMs,
    report,
    head: merged.slice(0, 3).map(item => ({ t_ms: item.t_ms, human_override: item.human_override })),
    tail: merged.slice(-2).map(item => ({ t_ms: item.t_ms, human_override: item.human_override, key: item.key })),
  };
  if (process.env.CLICKSMITH_REPRO_HEAP === '1') {
    const v8 = require('v8') as typeof import('v8');
    const heapPath = path.join(path.dirname(outPath), 'takeover.heapsnapshot');
    v8.writeHeapSnapshot(heapPath);
    payload.heapSnapshot = heapPath;
  }
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  expect(report.gapMs).toBe(0);
  expect(report.appended).toBe(2);
});
