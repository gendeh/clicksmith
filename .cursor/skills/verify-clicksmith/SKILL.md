---
name: verify-clicksmith
description: Drive Clicksmith the way a user does — Electron manager UI (verify renderer), overlay, backend API, and image-service. Use when proving a UI, profile, settings, overlay, API, or SmartClick change, or when a Cloud Agent needs launch/doctor/drive/evidence/cleanup.
---

# Verify Clicksmith

Clicksmith is an overlay-first input recorder. Users touch three surfaces. Pick the lane the change actually lives in. Never report a desktop-only or Geometry Dash path as verified from a Linux Cloud Agent.

| Lane | Surface | Cloud Agent | Proof |
| --- | --- | --- | --- |
| `ui` | Profile Manager + overlay renderer at the Vite URL | Yes, via the verify bridge | Playwright or computer-use against `data-testid` handles |
| `api` | Express backend `:3000` and Flask image-service `:5001` | Yes | HTTP request + response body |
| `desktop` | Real Electron + OS hooks (`uiohook-napi`, `robotjs`) | No | Native record/playback on macOS/Windows |
| `game` | Geode adapter talking to Geometry Dash on `127.0.0.1:27737` | No | Adapter `/status` while GD is running |

The verify renderer is the real React manager, not a separate mock app. `VITE_CLICKSMITH_VERIFY=true` installs an in-page IPC bridge only when `window.clicksmith` is missing, so Electron preload still wins on desktop. Native mouse/keyboard injection is out of scope for lane `ui`.

Put `control-clicksmith` on `PATH` after `npm --prefix .cursor/skills/verify-clicksmith install`.

```bash
node .cursor/skills/verify-clicksmith/scripts/control-clicksmith.mjs
```

Evidence lives in `.cursor/skills/verify-clicksmith/artifacts/`. Cleanup must not delete that directory.

## Launch

Isolated run (preferred for parallel agents):

```bash
export CLICKSMITH_VERIFY_RUN_ID="$RANDOM"
export CLICKSMITH_VERIFY_DIR="/tmp/clicksmith-verify/$CLICKSMITH_VERIFY_RUN_ID"
export CLICKSMITH_VERIFY_PORT_BASE=$((13000 + RANDOM % 1000))
node .cursor/skills/verify-clicksmith/scripts/control-clicksmith.mjs launch --lane all
```

Default cloud boot already starts backend `http://127.0.0.1:3000`, image-service `http://127.0.0.1:5001`, and the verify renderer `http://127.0.0.1:5173`. Reuse those URLs when `CLICKSMITH_VERIFY_DIR` is unset and doctor against the default ports. Do not launch a second copy on the same ports.

`launch` refuses to start when `state.json` already exists in the run dir or when any assigned port is held by a process it did not start. A 200 from a stale server is not your instance. Treat that refusal as the signal: `cleanup` your own run, or pick another `CLICKSMITH_VERIFY_PORT_BASE`. PIDs are written to `state.json` before health waits, so a failed launch is still cleanable.

Ready checks:

- Backend: `GET /health` returns `{"status":"ok"}`
- Image service: `GET /health` returns `{"status":"ok","service":"image-service"}`
- Renderer: `GET /` returns HTML containing `Clicksmith` and the page shows `[data-testid="app-shell"]`

Overlay URL: `http://127.0.0.1:<renderer>/#/overlay` — must show `[data-testid="overlay-root"]`.

EULA gate URL: `http://127.0.0.1:<renderer>/?eula=required` — must show `[data-testid="eula-modal"]`.

Teardown: `node .cursor/skills/verify-clicksmith/scripts/control-clicksmith.mjs cleanup` kills only the PIDs recorded in `$CLICKSMITH_VERIFY_DIR/state.json`. Never `pkill -f vite` or `pkill -f flask`.

## Doctor

Run this first whenever anything looks off:

```bash
node .cursor/skills/verify-clicksmith/scripts/control-clicksmith.mjs doctor
```

A healthy instance reports `ok: true` for every URL in the launch state. If doctor fails, read `$CLICKSMITH_VERIFY_DIR/*.log`, fix launch, and doctor again before driving. Never drive an instance you did not health-check since it last did something.

If this process did not start the instance (cloud `start` script did), doctor the default ports:

```bash
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:5001/health
curl -fsS http://127.0.0.1:5173/ | grep -q Clicksmith
```

## Drive

Read `.cursor/skills/verify-clicksmith/features/README.md`, then the matching feature file. Drive every listed entry point for the feature you claim, or report the skipped entry with the unmet precondition. One convenient path is not coverage.

Stable handles are `data-testid` attributes in `client/src/renderer/App.tsx`. Prefer those over CSS class names, DOM position, or coordinates.

Playwright (scripted, CI and Cloud Agent):

```bash
node .cursor/skills/verify-clicksmith/scripts/control-clicksmith.mjs drive manager-controls
```

Computer-use (Cloud Agent browser): open the renderer URL, wait for `[data-testid="app-shell"]`, then follow the feature file.

HTTP lane:

```bash
node .cursor/skills/verify-clicksmith/scripts/control-clicksmith.mjs http GET http://127.0.0.1:3000/health
node .cursor/skills/verify-clicksmith/scripts/control-clicksmith.mjs http POST http://127.0.0.1:3000/api/v1/profiles --body '{"name":"Verify API","target_app":"synthetic","created_at":"2026-01-01T00:00:00Z","events":[],"success_metric":{"furthest_frame":0,"score":0},"version":1,"notes":""}'
```

Do not use internal setters, Jest spies, or test-only endpoints as proof of a user-facing change. Jest engine tests with `MockInputHook` are necessary but not sufficient for manager UI changes.

## Evidence

Proof standards:

- Exercise the real user path for that lane.
- Capture the action and the resulting state, not only the final screen.
- UI proof: screenshot with the Clicksmith chrome visible, plus the assertion that failed or passed (`chip-rec` text, profile name, modal presence).
- HTTP proof: method, URL, status, and response body. For mutations, follow with a GET of the stored value.
- Side effects: a saved profile must reappear after reload or in `GET /api/v1/profiles`.
- Desktop/game lanes: if the machine cannot open Electron or Geometry Dash, write `SKIP desktop` or `SKIP game` with the attempted command and the unmet precondition. Do not substitute lane `ui` proof.

Artifact location: `.cursor/skills/verify-clicksmith/artifacts/<feature-id>/`. Keep `proof.json` plus screenshots or HTTP dumps. These files survive cleanup.

## Cleanup

```bash
node .cursor/skills/verify-clicksmith/scripts/control-clicksmith.mjs cleanup
```

Removes the run directory and the processes this run started. Leaves `.cursor/skills/verify-clicksmith/artifacts/` in place. If you used the cloud-boot instance on 3000/5001/5173, do not kill it unless this run started it.

## Helpers

| Command | Meaning |
| --- | --- |
| `... launch --lane all` | Backend + image-service + verify renderer |
| `... launch --lane api` | HTTP services only |
| `... launch --lane ui` | Verify renderer only |
| `... doctor` | Read-only health of the recorded instance |
| `... drive manager-controls` | Record → save modal → persist profile |
| `... http METHOD URL [--body JSON]` | Raw HTTP |
| `... screenshot --path FILE` | Full-page renderer screenshot |
| `... cleanup` | Kill recorded PIDs only |

After `npm --prefix .cursor/skills/verify-clicksmith install`, Playwright Chromium must be present (`npx --prefix .cursor/skills/verify-clicksmith playwright install chromium`). Cloud install does that once.
