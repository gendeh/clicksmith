#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const heap = process.argv.includes('--heap');
const out =
  process.env.CLICKSMITH_REPRO_OUT ??
  path.join(root, '.cursor/skills/verify-clicksmith/artifacts/repro-takeover/report.json');

const result = spawnSync(
  'npm',
  ['--prefix', 'client', 'test', '--', '--testPathPattern=takeoverAppend', '--watchman=false'],
  {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLICKSMITH_REPRO: '1',
      CLICKSMITH_REPRO_OUT: out,
      CLICKSMITH_REPRO_HEAP: heap ? '1' : '',
    },
  }
);

process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

if (!existsSync(out)) {
  console.error(`repro report missing at ${out}`);
  process.exit(1);
}

const report = JSON.parse(readFileSync(out, 'utf8'));
console.log(JSON.stringify({ ok: report.report?.gapMs === 0, path: out, ...report }, null, 2));
