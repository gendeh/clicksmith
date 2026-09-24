#!/usr/bin/env node
import http from 'node:http';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function startSyntheticAdapter({ id, name, game, port = 0 }) {
  let replayEvents = [];
  let recording = false;
  let takeoverStartMs = null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/status') {
        send(res, 200, {
          ok: true,
          id,
          name,
          game,
          version: '0.1.0',
          capabilities: ['record', 'replay', 'takeover'],
          tick_hz: 0,
          replay_active: replayEvents.length > 0 && !recording,
          record_active: recording,
          takeover_armed: takeoverStartMs !== null && !recording,
        });
        return;
      }

      const body = req.method === 'POST' ? await readBody(req) : {};

      if (req.method === 'POST' && url.pathname === '/replay/start') {
        replayEvents = Array.isArray(body.events) ? body.events : [];
        recording = false;
        takeoverStartMs = null;
        send(res, 200, { ok: true, state: 'playing' });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/replay/stop') {
        replayEvents = [];
        recording = false;
        takeoverStartMs = null;
        send(res, 200, { ok: true, state: 'stopped' });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/replay/takeover') {
        takeoverStartMs = typeof body.start_ms === 'number' ? body.start_ms : 120;
        recording = true;
        send(res, 200, { ok: true, state: 'recording', start_ms: takeoverStartMs });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/record/start') {
        recording = true;
        takeoverStartMs = null;
        send(res, 200, { ok: true, state: 'armed' });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/record/stop') {
        const events = recording
          ? [
              { t_ms: 0, button: 'left', down: true },
              { t_ms: 40, button: 'e', down: true },
            ]
          : [];
        const startMs = takeoverStartMs;
        recording = false;
        takeoverStartMs = null;
        send(res, 200, {
          ok: true,
          events,
          start_ms: startMs,
          duration_ms: 64,
          tick_hz: 0,
        });
        return;
      }

      send(res, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      send(res, 400, { ok: false, error: error instanceof Error ? error.message : 'bad_request' });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('adapter_listen_failed'));
        return;
      }
      resolve({
        id,
        port: address.port,
        url: `http://127.0.0.1:${address.port}`,
        close() {
          return new Promise(done => server.close(() => done()));
        },
      });
    });
  });
}

const isCli = process.argv[1] && process.argv[1].endsWith('synthetic-adapter.mjs');
if (isCli) {
  const args = process.argv.slice(2);
  const readFlag = name => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const port = Number(readFlag('--port') || 0);
  const adapter = await startSyntheticAdapter({
    id: readFlag('--id') || 'minecraft-os',
    name: readFlag('--name') || 'Minecraft authoring',
    game: readFlag('--game') || 'Minecraft',
    port,
  });
  console.log(JSON.stringify({ ok: true, url: adapter.url, id: adapter.id }));
}
