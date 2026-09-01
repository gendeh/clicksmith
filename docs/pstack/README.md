# Clicksmith factory: 1000 PRs from first principles

This is the operating manual for scaling Clicksmith with Cloud Agents. It is not a prompt pack. The constraint is trust, not tokens.

## Direct answers

**Is a feature map the first thing?** Yes for product work, because an agent that can click still does not know what the app is. A Slack screenshot that says "left sidebar is laggy" is useless until the agent has a user-POV map: how to reach the feature, which handle to drive, what observable state counts as proof. Lauren Tan's first Cursor skill after joining was not a better prompt. It was eyes (control the live app) plus a feature map.

**Is that enough to reach 1000 PRs a month?** No. A feature map without a machine that boots the app still makes you the inner loop: you screenshot, paste, wait. 1000 PRs/month is ~33 merged PRs/day. That only works if the human is out of record → fix → prove → merge. The other first step, in parallel, is a Cloud Agent environment: dependencies installed, services up, verify renderer reachable, secrets not in git.

**What the Environment panel is.** Cursor Cloud Agents boot an isolated Ubuntu VM. The screenshot you saw (`gendeh/clicksmith`, empty Install/Start) is the dashboard-managed environment for this repo. Install runs once per environment build and snapshots the disk. Start runs on every agent boot and must bring up backend, image-service, and the verify renderer. Secrets stay in that panel, never in `environment.json`. After this change is saved, new agents skip "it doesn't build on my machine."

The rest of this document is the factory that sits on top of those two primitives.

## First principles

Throughput is not "how much the model writes." Throughput is:

```text
merged PRs / month
  = (trusted parallel agents)
  × (complete loops per agent per day)
  × 30
  × (merge yield)
```

Each term fails for a different reason:

| Term | Failure mode | Fix |
| --- | --- | --- |
| Trusted parallel agents | You watch one agent because the last one lied | Runtime proof + CI that makes the wrong path fail |
| Complete loops / day | Agent stops to ask you to run the app | Cloud environment + verify skill + never-block-on-the-human |
| Merge yield | 40 PRs open, 4 are correct | Feature map, boundary CI, blinded evals, small PRs |

Agents always take the shortest path. Encode the correct path as the shortest one: types, directory boundaries, red CI, a driver they can run without you.

Soft layers (rules, PR comments, style guides) leak. Anything you have typed three times in review becomes a lint, a test, or an impossible state.

## What Clicksmith actually is

Four processes, not one app:

1. **Electron main** (`client/src/main`) — recording/playback engines, IPC, Geode HTTP client, profile store. Native addons: `uiohook-napi`, `robotjs`, `screenshot-desktop`.
2. **Electron renderer** (`client/src/renderer`) — Profile Manager + overlay React UI. Must not import main.
3. **Express API** (`backend`) — profiles, auth stubs, Stripe, `/health`. In-memory mock DB in Cloud Agents.
4. **Flask image-service** (`image-service`) — OpenCV `/match` and `/ocr`.

Optional fifth: **Geode adapter** inside Geometry Dash on `127.0.0.1:27737`.

Linux Cloud Agents can run 2–4 (renderer via Vite, not Electron). They cannot run native hooks or Geometry Dash. Pretending otherwise produces fake green.

So the factory has lanes. Every task names one. Every PR's proof is from that lane. Skips are explicit.

```text
ui       verify renderer + data-testid     cloud yes
api      HTTP contracts                    cloud yes
desktop  real Electron + OS hooks          cloud SKIP
game     Geode + Geometry Dash             cloud SKIP
```

This is the Clicksmith analogue of Dune (Lauren's Electron shell): make illegal mixing fail in CI, and make the cloud-verifiable surface large enough that most PRs do not need a gaming PC.

## The trust stack (build in this order)

Do not skip layers. Each layer only pays off if the one below it holds.

### Layer 0 — Cloud environment

Done means a fresh Cloud Agent can, with no extra prompts:

- install Node deps (client with `--ignore-scripts` so Linux does not compile `robotjs`)
- install `image-service/requirements.txt`
- install Playwright Chromium for `verify-clicksmith`
- start backend `:3000`, image-service `:5001`, verify renderer `:5173`
- pass `control-clicksmith doctor`

Scripts: `scripts/cloud-install.sh`, `scripts/cloud-start.sh`. Save them in the Environment panel. New agents boot from a successful environment build, not from a 20-minute install.

Secrets that belong in the panel when you add them, not in git: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `FIREBASE_SERVICE_ACCOUNT`. They are optional for the mock-DB verify lane.

### Layer 1 — Eyes + feature map

The project-local skill is `.cursor/skills/verify-clicksmith/`. It is committed because Cloud Agents do not reliably load the pstack plugin.

The map is `.cursor/skills/verify-clicksmith/features/`. Each file is user-POV: how to get there, how to drive it, what proof looks like, what will waste a run.

The driver is `node .cursor/skills/verify-clicksmith/scripts/control-clicksmith.mjs`. It launches isolated ports, doctors, drives `manager-controls`, and writes artifacts that survive cleanup.

The verify renderer is the real React app with an in-page IPC bridge (`client/src/renderer/verifyBridge.ts`) used only when Electron preload is absent. That is how Cloud Agents click Record without `uiohook`. It proves the UI contract. It does not prove native injection. The map says so.

Keep the map honest with `/maintain-verification-skill` (pstack) or a scheduled agent that re-reads source and re-drives every feature.

### Layer 2 — Hard architecture

Already true, now enforced:

- Renderer must not import `client/src/main`.
- Main must not import renderer.
- `nodeIntegration: true` is forbidden.

`bash scripts/check-boundaries.sh` runs on every PR.

Next encodings, when a review comment repeats:

- Ban `useEffect` for IPC subscriptions only if you replace them with a single subscription module (do not ban blindly; this UI is event-shaped).
- Make illegal playback states unrepresentable in `PlaybackStatus` instead of scattering `if (playing)` guards.
- Split `client/src/main/main.ts` when a PR cannot land without touching Geode, IPC, and hotkeys at once. That file is the serial bottleneck for 1000 PRs. Slice by protocol: IPC registry, local engines, mod adapter, hotkeys.

### Layer 3 — CI as red lights

CI now runs:

- boundary check
- backend Jest
- client Jest with native modules mocked (engines, not OS hooks)
- image-service pytest
- live verify: launch + doctor + drive `manager-controls`
- Windows package (desktop artifact, not cloud proof)

A Cloud Agent that "forgets" to verify still turns the build red if the manager flow breaks.

### Layer 4 — Playbooks, not vibes

Install pstack in Cursor: `/add-plugin pstack`, then `/setup-pstack`. Start real work with `/poteto-mode`.

Cloud Agents often cannot see that plugin. They still have:

- `.cursor/skills/clicksmith-factory/SKILL.md`
- `.cursor/rules/clicksmith-factory.mdc` (always applied)
- this document

One owner per PR. `/goal` for the finish condition. `/loop` overnight. `/swarm` for coverage across packages. `/interrogate` before merge. `/no-comments` on product diffs.

Finish conditions are observables ("chip-rec reads Live, then save modal, then profile name survives reload"), never "work for four hours."

### Layer 5 — Evals on the factory

Models game tests they can see. Blind the workers:

1. Copy a case from `docs/pstack/evals/cases/` into an obscure temp dir name.
2. Spawn a worker that only gets the user prompt and the repo.
3. Score with a different model family against the rubric in `docs/pstack/evals/README.md`.
4. Fail the factory, not the worker, when evidence is missing.

Run this when you change the verify skill, the feature map, or the always-on rule.

## Math for 1000 PRs

Assume 20 weekday agent-hours of wall clock (overnight + day).

| Mix | PRs/day | Notes |
| --- | --- | --- |
| You watch every diff | 2–4 | No factory |
| One trusted agent, you merge | 8–12 | Feature map + env |
| 8 parallel agents, you merge | 20–30 | Need CI + slices |
| 8 parallel, merge-when-green on `ui`/`api` | 33+ | Human only on desktop/game and architecture PRs |

1000/month is 33/day. That is an 8-agent factory with ~4 verified merges per agent per day, or fewer agents with longer overnight loops. It is not 1000 unique product features. Lauren's 1000 included debt paydown, evals, and mechanical slices. Budget the same: a large fraction should be "make the next agent faster" (split `main.ts`, add a handle, encode a review comment).

Work that will not parallelize until sliced:

- `client/src/main/main.ts` Geode state machine
- anything that needs Geometry Dash
- installer / native addon upgrades

Work that will:

- renderer UI
- backend routes
- image-service match methods
- feature-map upkeep
- engine unit tests behind `MockInputHook`
- docs that agents actually read (this file, the map)

## Step-by-step: first week

1. Save the Cloud Agent environment (Install/Start from `scripts/cloud-install.sh` and `scripts/cloud-start.sh`). Confirm a new agent can `curl` `:3000/health`, `:5001/health`, and load `:5173` with `[data-testid="app-shell"]`.
2. Install pstack locally. Keep the committed skills; they are the cloud fallback.
3. Run one complete loop yourself: `/poteto-mode` (or `clicksmith-factory`) on a tiny `ui` bug. Demand `artifacts/manager-controls/proof.json`. Merge only with that.
4. Run the blinded eval `docs/pstack/evals/cases/manager-record-save.md`. If the worker reports success without artifacts, the factory is not ready. Fix the skill, not the prompt.
5. Open four Cloud Agents on independent `ui`/`api` tasks. Different `CLICKSMITH_VERIFY_DIR` if they launch their own stack; otherwise share the boot instance read-only and write in worktrees.
6. Encode the first repeated review comment as CI.
7. Only then raise concurrency.

## Step-by-step: a single PR

1. Name the lane and the feature file.
2. Reproduce or specify the observable.
3. Change the smallest code that makes that observable true.
4. Drive the feature file. Keep artifacts.
5. `bash scripts/check-boundaries.sh` and the package tests for the lane.
6. `/interrogate` or a second model on the diff.
7. PR body: lane, feature ID, artifact paths, SKIPs. No "should be fixed."

## Step-by-step: overnight

```text
/poteto-mode I am stepping away.
Finish condition: every open ui/api bug in $LIST has a merged or merge-ready PR,
each with verify-clicksmith artifacts for its feature file.
One PR per bug. Do not touch desktop/game lanes.
If doctor fails, stop that PR and explain. Do not ask me to run the app.
/loop until the finish condition or a real dead end.
```

## What not to do

- Do not scale agents before doctor is boringly green.
- Do not let agents "verify" Geode from a screenshot of Settings copy.
- Do not add comments that quote chat ("Lauren said never do this"). Types and tests only.
- Do not plan for two weeks instead of landing the verify loop. The best spec is a driver that already fails.

## File index

| Path | Role |
| --- | --- |
| `.cursor/skills/verify-clicksmith/` | Launch, doctor, drive, evidence |
| `.cursor/skills/verify-clicksmith/features/` | User-POV map |
| `.cursor/skills/clicksmith-factory/` | Playbook when pstack is missing |
| `.cursor/rules/clicksmith-factory.mdc` | Always-on constraints |
| `scripts/cloud-install.sh` / `scripts/cloud-start.sh` | Environment panel |
| `scripts/check-boundaries.sh` | Renderer/main isolation |
| `docs/pstack/evals/` | Blinded factory tests |
