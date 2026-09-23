#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const STATUS_URL = 'http://127.0.0.1:27737/status';
const STATUS_CMD = 'curl -sS -m 3 http://127.0.0.1:27737/status';
const CHECKOUT_PROTOCOL = '2.0.0';
const RUNS = Number(process.env.CLICKSMITH_FREEZE_RUNS || 8);
const MACRO_INDEX = Number(process.env.CLICKSMITH_MACRO_INDEX || 20);
const repoRoot = resolve(__dirname, '..');
const fixturePath = join(repoRoot, 'geode-adapter/fixtures/back-on-track-macro.json');
const artifactsDir = join(repoRoot, '.cursor/skills/verify-clicksmith/artifacts/geode-timing');

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      'X-Clicksmith-Adapter': '1',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(init.timeoutMs || 3000),
  });
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep text
  }
  return { ok: res.ok, status: res.status, body };
}

async function getStatus() {
  try {
    const result = await fetchJson(STATUS_URL);
    return result.ok && result.body && result.body.ok === true ? result.body : null;
  } catch {
    return null;
  }
}

function activateGeometryDash() {
  try {
    execFileSync('osascript', ['-e', 'tell application "Geometry Dash" to activate'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function keystroke(keyCode) {
  try {
    execFileSync(
      'osascript',
      ['-e', `tell application "System Events" to key code ${keyCode}`],
      { stdio: 'ignore' }
    );
  } catch {
    // accessibility may be denied
  }
}

async function nudgeAttempt(status) {
  activateGeometryDash();
  await sleep(200);
  if (status?.paused) {
    keystroke(53);
    await sleep(250);
    keystroke(49);
  } else {
    keystroke(49);
  }
}

async function startReplay(events) {
  return fetchJson('http://127.0.0.1:27737/replay/start', {
    method: 'POST',
    body: JSON.stringify({ events }),
    timeoutMs: 4000,
  });
}

async function waitForMacroFreeze(previous, timeoutMs) {
  const started = Date.now();
  let last = previous;
  while (Date.now() - started < timeoutMs) {
    last = (await getStatus()) || last;
    const freezeRun = Number(last.last_freeze_run_id || 0);
    const prevRun = Number(previous.last_freeze_run_id || 0);
    const index = Number(last.last_freeze_replay_index || 0);
    const tick = Number(last.last_freeze_tick || 0);
    if (freezeRun !== prevRun && index >= MACRO_INDEX && tick > 0) {
      return { ok: true, status: last, tick, index, runId: freezeRun };
    }
    if (last.paused || last.replay_state === 'armed') {
      await nudgeAttempt(last);
    }
    await sleep(80);
  }
  return { ok: false, status: last };
}

async function main() {
  mkdirSync(artifactsDir, { recursive: true });
  const status = await getStatus();
  if (!status) {
    console.log('SKIP game');
    console.log(STATUS_CMD);
    writeFileSync(
      join(artifactsDir, 'verify-skip.json'),
      JSON.stringify({ skip: 'game', command: STATUS_CMD, at: new Date().toISOString() }, null, 2)
    );
    return;
  }

  writeFileSync(join(artifactsDir, 'status-after-rebuild.json'), JSON.stringify(status, null, 2));

  if (status.protocol_version !== CHECKOUT_PROTOCOL) {
    const error = `stale_adapter_protocol: loaded ${status.protocol_version || 'missing'}, checkout ${CHECKOUT_PROTOCOL}`;
    writeFileSync(join(artifactsDir, 'verify-stale.json'), JSON.stringify({ error, status }, null, 2));
    console.error(error);
    process.exit(1);
  }

  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const events = fixture.events;
  if (!Array.isArray(events) || events.some(event => !Number.isFinite(event.t_tick))) {
    console.error('fixture events must carry t_tick');
    process.exit(1);
  }

  const runs = [];
  let previous = status;
  for (let i = 0; i < RUNS; i += 1) {
    const start = await startReplay(events);
    if (!start.ok) {
      console.error(`replay/start failed on run ${i + 1}: ${JSON.stringify(start.body)}`);
      process.exit(1);
    }
    await nudgeAttempt((await getStatus()) || previous);
    const freeze = await waitForMacroFreeze(previous, 25000);
    if (!freeze.ok) {
      const failed = {
        error: 'macro_freeze_timeout',
        run: i + 1,
        last_status: freeze.status,
        completed: runs,
      };
      writeFileSync(join(artifactsDir, 'verify-runs.json'), JSON.stringify(failed, null, 2));
      console.error(JSON.stringify(failed, null, 2));
      process.exit(1);
    }
    runs.push({
      run: i + 1,
      freeze_tick: freeze.tick,
      replay_index: freeze.index,
      replay_run_id: freeze.runId,
      protocol_version: freeze.status.protocol_version,
      version: freeze.status.version,
      build_id: freeze.status.build_id,
    });
    previous = freeze.status;
    console.log(JSON.stringify(runs[runs.length - 1]));
  }

  const ticks = runs.map(run => run.freeze_tick);
  const unique = [...new Set(ticks)];
  const spread = Math.max(...ticks) - Math.min(...ticks);
  const report = {
    ok: unique.length === 1,
    run_count: runs.length,
    freeze_tick: unique.length === 1 ? unique[0] : null,
    ticks,
    spread,
    version: previous.version,
    protocol_version: previous.protocol_version,
    build_id: previous.build_id,
    runs,
  };
  writeFileSync(join(artifactsDir, 'verify-runs.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(artifactsDir, 'status-after-verify.json'), JSON.stringify(previous, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
