#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { openSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const defaultRunRoot = join('/tmp', 'clicksmith-verify');
const artifactsRoot = resolve(here, '../artifacts');

function usage() {
  console.log(`control-clicksmith <command>

Commands:
  launch [--lane all|api|ui]
  doctor
  cleanup
  http GET|POST|PUT|DELETE <url> [--body JSON]
  drive manager-controls [--headed]
  screenshot --path <file>
`);
}

function runDir() {
  return process.env.CLICKSMITH_VERIFY_DIR || join(defaultRunRoot, process.env.CLICKSMITH_VERIFY_RUN_ID || 'default');
}

function statePath() {
  return join(runDir(), 'state.json');
}

function readState() {
  if (!existsSync(statePath())) {
    throw new Error(`No verify instance at ${runDir()}. Run: control-clicksmith launch`);
  }
  return JSON.parse(readFileSync(statePath(), 'utf8'));
}

function writeState(state) {
  mkdirSync(runDir(), { recursive: true });
  writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

function ports() {
  const base = Number(process.env.CLICKSMITH_VERIFY_PORT_BASE || '13000');
  return {
    backend: Number(process.env.CLICKSMITH_BACKEND_PORT || base),
    image: Number(process.env.CLICKSMITH_IMAGE_PORT || base + 10),
    renderer: Number(process.env.CLICKSMITH_RENDERER_PORT || base + 20),
  };
}

async function waitFor(url, timeoutMs = 30000) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return;
      last = `${res.status} ${res.statusText}`;
    } catch (error) {
      last = error.message;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}: ${last}`);
}

function spawnLogged(command, args, options) {
  mkdirSync(runDir(), { recursive: true });
  const logFile = join(runDir(), `${options.logName}.log`);
  const fd = openSync(logFile, 'a');
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  return { pid: child.pid, logFile };
}

async function launch(lane) {
  const assigned = ports();
  const state = {
    lane,
    createdAt: new Date().toISOString(),
    pids: [],
    urls: {
      backend: `http://127.0.0.1:${assigned.backend}`,
      image: `http://127.0.0.1:${assigned.image}`,
      renderer: `http://127.0.0.1:${assigned.renderer}`,
    },
  };

  if (lane === 'all' || lane === 'api') {
    state.pids.push(
      spawnLogged('npx', ['ts-node', '--transpile-only', 'src/index.ts'], {
        cwd: join(repoRoot, 'backend'),
        env: {
          ...process.env,
          PORT: String(assigned.backend),
          IMAGE_SERVICE_URL: `http://127.0.0.1:${assigned.image}`,
          CLIENT_URL: `http://127.0.0.1:${assigned.renderer}`,
        },
        logName: 'backend',
      })
    );
    state.pids.push(
      spawnLogged('python3', ['-m', 'flask', '--app', 'app.main', 'run', '--host', '127.0.0.1', '--port', String(assigned.image)], {
        cwd: join(repoRoot, 'image-service'),
        env: { ...process.env, PORT: String(assigned.image), PYTHONPATH: join(repoRoot, 'image-service') },
        logName: 'image-service',
      })
    );
    await waitFor(`${state.urls.backend}/health`);
    await waitFor(`${state.urls.image}/health`);
  }

  if (lane === 'all' || lane === 'ui') {
    state.pids.push(
      spawnLogged('npx', ['vite', '--config', 'vite.renderer.config.ts', '--host', '127.0.0.1', '--port', String(assigned.renderer), '--strictPort'], {
        cwd: join(repoRoot, 'client'),
        env: { ...process.env, VITE_CLICKSMITH_VERIFY: 'true' },
        logName: 'renderer',
      })
    );
    await waitFor(state.urls.renderer);
  }

  writeState(state);
  console.log(JSON.stringify(state, null, 2));
}

async function doctor() {
  const state = readState();
  const checks = [];
  for (const [name, url] of Object.entries(state.urls)) {
    if (state.lane === 'ui' && name !== 'renderer') continue;
    if (state.lane === 'api' && name === 'renderer') continue;
    try {
      const res = await fetch(name === 'renderer' ? url : `${url}/health`, { signal: AbortSignal.timeout(5000) });
      const body = name === 'renderer' ? await res.text() : await res.json();
      checks.push({ name, ok: res.ok, url, body: typeof body === 'string' ? body.slice(0, 120) : body });
    } catch (error) {
      checks.push({ name, ok: false, url, error: error.message });
    }
  }
  const failed = checks.filter(check => !check.ok);
  const report = { runDir: runDir(), checks, ok: failed.length === 0 };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

function cleanup() {
  if (!existsSync(statePath())) {
    console.log(JSON.stringify({ ok: true, skipped: 'no-instance' }));
    return;
  }
  const state = readState();
  for (const proc of state.pids) {
    try {
      process.kill(-proc.pid, 'SIGTERM');
    } catch {
      try {
        process.kill(proc.pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
  }
  rmSync(runDir(), { recursive: true, force: true });
  console.log(JSON.stringify({ ok: true, removed: state.pids.map(proc => proc.pid) }));
}

async function http(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body,
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep text
  }
  const result = { ok: res.ok, status: res.status, body: parsed };
  console.log(JSON.stringify(result, null, 2));
  if (!res.ok) process.exit(1);
}

async function screenshot(pathArg) {
  const { chromium } = await import('playwright');
  const state = readState();
  mkdirSync(dirname(pathArg), { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
  await page.goto(state.urls.renderer, { waitUntil: 'domcontentloaded' });
  await page.screenshot({ path: pathArg, fullPage: true });
  await browser.close();
  console.log(JSON.stringify({ ok: true, path: pathArg }));
}

async function driveManagerControls(headed) {
  const { chromium } = await import('playwright');
  const state = readState();
  mkdirSync(artifactsRoot, { recursive: true });
  const shotDir = join(artifactsRoot, 'manager-controls');
  mkdirSync(shotDir, { recursive: true });
  const browser = await chromium.launch({ headless: !headed });
  const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
  await page.goto(state.urls.renderer, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="app-shell"]').waitFor({ timeout: 15000 });
  await page.screenshot({ path: join(shotDir, 'idle.png'), fullPage: true });

  const recChip = page.locator('[data-testid="chip-rec"]');
  const recText = (await recChip.innerText()).toLowerCase();
  if (!recText.includes('idle')) {
    throw new Error(`Expected REC chip idle before recording, got ${JSON.stringify(await recChip.innerText())}`);
  }
  await page.locator('[data-testid="btn-record"]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="chip-rec"]')?.textContent?.toLowerCase().includes('live'));
  await page.screenshot({ path: join(shotDir, 'recording.png'), fullPage: true });
  await page.locator('[data-testid="btn-record"]').click();
  await page.locator('[data-testid="save-run-modal"]').waitFor();
  await page.locator('[data-testid="save-run-name"]').fill('Verify Manager Run');
  await page.locator('[data-testid="save-run-confirm"]').click();
  await page.locator('[data-testid="save-run-modal"]').waitFor({ state: 'detached' });
  await page.getByText('Verify Manager Run').waitFor();
  await page.screenshot({ path: join(shotDir, 'saved.png'), fullPage: true });
  const proof = {
    feature: 'manager-controls',
    url: state.urls.renderer,
    recChip: await recChip.innerText(),
    profileVisible: true,
    artifacts: [
      join(shotDir, 'idle.png'),
      join(shotDir, 'recording.png'),
      join(shotDir, 'saved.png'),
    ],
  };
  writeFileSync(join(shotDir, 'proof.json'), JSON.stringify(proof, null, 2));
  await browser.close();
  console.log(JSON.stringify(proof, null, 2));
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const [command, ...rest] = args._;

try {
  if (command === 'launch') {
    await launch(args.lane || 'all');
  } else if (command === 'doctor') {
    await doctor();
  } else if (command === 'cleanup') {
    cleanup();
  } else if (command === 'http') {
    await http(rest[0], rest[1], args.body);
  } else if (command === 'drive' && rest[0] === 'manager-controls') {
    await driveManagerControls(Boolean(args.headed));
  } else if (command === 'screenshot') {
    if (!args.path) throw new Error('--path is required');
    await screenshot(args.path);
  } else {
    usage();
    process.exit(command ? 1 : 0);
  }
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
