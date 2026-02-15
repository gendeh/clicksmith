# Phase 1 Move-On Test Criteria

This checklist is the gate to move from Phase 1 (deterministic core) to Phase 2.

## Explicit Step 1-4 Gate (must pass in order)

### Step 1) Protocol handshake hard gate
1. Run: `curl -s http://127.0.0.1:27737/status`
2. Confirm payload includes:
- `protocol_version` with major `1`
- `capabilities` contains `status`, `record`, `replay`
- `record_state`, `replay_state`, `paused`, `takeover_armed`
3. In Clicksmith, open Mods section and verify adapter connection is `connected`.

Pass condition:
- Client accepts adapter only when status contract is valid.
- Invalid/missing contract fields result in `unreachable` with a protocol error.

### Step 2) Deterministic attempt-boundary replay contract
1. Arm replay with `F10` during an active attempt.
2. Stay in the same attempt for ~2s.
3. Confirm no replay inputs fire yet.
4. Die/reset into next attempt.

Pass condition:
- Replay begins only on the next attempt boundary.
- No pre-boundary dispatch is observed.

### Step 3) Pause/unpause semantics contract
1. Start replay.
2. Pause with `Esc`, wait 1-2s, resume.
3. Repeat 10 times in one run.

Pass condition:
- While paused: replay remains active but dispatch is frozen.
- On resume: replay continues (does not mode-flip to recording).
- No cumulative timing drift beyond 1 frame at 240 Hz.

### Step 4) Takeover contract hardening
1. Start replay and let it run live.
2. Trigger takeover by manual click.
3. Stop with `F9`, save, replay merged profile.

Pass condition:
- Takeover is accepted only during replay `live`.
- Resume/pause clicks do not trigger takeover.
- Segment B begins at takeover boundary with no silent gap.

## Automated gates (must pass)

1. Build
- Command: `cd client && npm run build`
- Pass condition: TypeScript and renderer builds succeed with no errors.

2. Unit/integration tests
- Command: `cd client && npm test -- --runInBand`
- Pass condition: all tests pass.

3. Lifecycle state machine coverage
- Test file: `client/tests/runLifecycle.test.ts`
- Pass condition:
- `arm_record -> attempt_boundary -> record_live`
- `record_live -> stop_record -> finalizing -> finalize_done -> idle`
- `arm_replay -> attempt_boundary -> replay_live -> death -> idle`
- `replay_live -> takeover_click -> takeover_live`
- pause/unpause toggles `paused` while staying in live state.

## Manual runtime gates (must pass)

Run stack:
1. `cd geode-adapter && export CMAKE_OSX_ARCHITECTURES="arm64;x86_64" && geode build`
2. `cd client && npm run build && npm run start`

### A) Recording arm/live behavior
1. Enter level.
2. Press `F9` before first gameplay click.
3. Die/reset once.
4. Verify recording remains armed (does not silently cancel).
5. On next attempt, first real input should switch recording to live.

Pass condition:
- Recording does not auto-cancel on arm boundary transitions.
- Live capture starts at attempt boundary and records expected clicks.

### B) Replay arm/live behavior
1. Select a known-good profile.
2. Press `F10` to arm replay.
3. Reset/start attempt.
4. Verify replay starts from attempt boundary and runs through events.
5. Die during replay.

Pass condition:
- Replay stops on death.
- Replay does not auto-switch into recording unless takeover was explicitly triggered.

### C) Takeover splice behavior
1. Start replay (`F10`) and let it run.
2. Click manually to trigger takeover.
3. Continue manually for a segment.
4. Press `F9` to stop and finalize takeover recording.
5. Save profile and replay new profile from start.

Pass condition:
- Segment B starts exactly at takeover click boundary.
- No dead air gap between segment A and segment B.
- Final profile is saved and replayable from level start.

### D) Pause/unpause timing stability
1. Start replay.
2. Pause/unpause the game 10 times during one attempt.
3. Compare event timing before and after pause cycles.

Pass condition:
- No visible cumulative drift after repeated pause/unpause cycles.
- Scheduler state remains replay-live (no unexpected mode flips).

### E) Structured trace sanity
1. Run client from terminal and perform one record + replay + takeover cycle.
2. Verify `[run-trace]` logs appear for:
- lifecycle transitions
- playback dispatch entries with `runId`, `attemptId`, `eventIndex`, `deltaMs`

Pass condition:
- Trace stream is complete enough to diagnose timing and state transitions.

## Hard fail conditions (block Phase 2)

1. Replay fires events before attempt boundary.
2. Recording gets stuck and cannot be stopped.
3. Takeover merge introduces a persistent multi-second gap.
4. Death or pause causes incorrect automatic mode switch (replay -> record without explicit takeover).
5. Build/test suite regresses.
