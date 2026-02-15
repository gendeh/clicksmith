# Clicksmith 3-Phase Roadmap

This roadmap is ordered to balance correctness, security, and efficiency for the current codebase.

## Goal
Ship a reliable, secure, and scalable replay/recording system where:
- replay timing is deterministic,
- takeover/arm/live transitions are stable,
- renderer security boundaries are hardened,
- performance is measurable and continuously enforced.

## Rules of execution
1. Do not start the next phase until all exit criteria for the current phase pass.
2. Any regression in phase criteria blocks promotion to next phase.
3. Every phase must include automated tests and manual QA evidence.

---

## Phase 1: Deterministic Core (Correctness First)

### Scope
- Introduce a single run lifecycle state machine across recording/replay/takeover.
- Replace ad-hoc replay timing with deterministic scheduler primitives.
- Add deterministic replay/takeover test harness and property tests for event transforms.
- Add baseline observability for timing and transition correctness.

### Key implementation items
1. Lifecycle state machine
- States: `idle`, `record_armed`, `record_live`, `replay_armed`, `replay_live`, `takeover_live`, `finalizing`.
- Events: `F9`, `F10`, `attempt_boundary`, `pause`, `unpause`, `death`, `level_complete`, `takeover_click`, `save`, `discard`.
- Single owner module for state transitions (no multi-writer state changes).

2. Deterministic replay scheduler
- Monotonic clock source.
- Deadline queue with stable ordering.
- Explicit overdue policy per action class (`skip`, `late-dispatch`, or `resync`).
- Pause/unpause offset compensation.

3. Deterministic tests
- Property tests for down/up and duration conversion.
- Fixed-clock simulation tests for replay timelines.
- Takeover splice tests (segment A + segment B with no timing gap).
- Death/reset/respawn state transition tests.

4. Observability baseline
- Structured run logs with `run_id`, `attempt_id`, `event_index`.
- Emit `scheduled_t_ms`, `actual_t_ms`, `delta_ms`.
- Transition logs for all lifecycle events.

### Exit criteria (must all pass)
1. `F9/F10/takeover` lifecycle regressions: 0 known critical bugs.
2. Replay timing drift: p95 absolute delta <= 4 ms in deterministic harness.
3. Takeover splice gap: <= 1 frame equivalent at 240 Hz (<= 4.2 ms).
4. Pause/unpause resume: no cumulative drift beyond 1 frame after 10 pause cycles.
5. Automated test suite covers:
- state transitions,
- event conversion invariants,
- takeover merge invariants.

---

## Phase 2: Security and Trust Boundaries

### Scope
- Harden Electron process boundaries.
- Enforce typed IPC contracts and validation.
- Harden backend auth ownership checks and schema validation.
- Remove unsafe identity fallbacks in non-dev paths.

### Key implementation items
1. Electron hardening
- `contextIsolation: true`.
- `nodeIntegration: false`.
- Narrow preload API via `contextBridge`.
- Explicit IPC allowlist by domain (`recording`, `playback`, `profiles`, `billing`, `mods`).

2. IPC validation
- Runtime validation on all IPC request/response payloads.
- Reject malformed payloads with explicit error codes.

3. Backend trust enforcement
- Mandatory JWT verification middleware for protected endpoints.
- Ownership checks on all update/delete profile operations.
- Shared request/response schema validation.

4. API contract discipline
- Versioned API contracts.
- OpenAPI spec + generated client types.

### Exit criteria (must all pass)
1. Renderer has no direct Node/Electron privileged access outside preload bridge.
2. 100% IPC handlers validate payloads with runtime schemas.
3. All protected backend routes reject unauthenticated/unauthorized access.
4. Security smoke tests pass:
- malformed IPC payload tests,
- auth bypass tests,
- profile ownership mutation tests.
5. No high-severity findings in internal security review checklist.

---

## Phase 3: Performance and Scalability

### Scope
- Improve hot-path data/storage architecture for long runs.
- Move expensive compute off main thread.
- Optimize image matching transport and runtime behavior.
- Add robust offline-first sync foundation.

### Key implementation items
1. Data model and storage improvements
- Split event hot path from cold payloads (image patches by content hash).
- Move local persistence to indexed DB schema for profiles/events/metadata.

2. Runtime performance
- Worker-thread offload for hash/compile/analytics work.
- Keep orchestration and timing dispatch isolated from heavy computation.

3. Image pipeline optimization
- Replace base64-heavy critical path with binary-friendly transport.
- Add reusable worker pools and cache keys for repeated matches.

4. Sync engine hardening
- Outbox-based retry mechanism with backoff.
- Operation-level sync semantics and conflict policy.

5. Performance budgets and bench automation
- Benchmark command for replay fixtures.
- Track p50/p95/p99 for image match and scheduler drift.

### Exit criteria (must all pass)
1. Memory usage on long sessions reduced by at least 35% vs phase-1 baseline.
2. Replay dispatch jitter p95 improved by at least 30% vs phase-1 baseline.
3. Image matching latency p95 improved by at least 25% on fixture set.
4. Sync reliability:
- no data loss in offline/online transition tests,
- retry behavior proven under transient failures.
5. Performance dashboard shows stable budget compliance for 7 consecutive days.

---

## Suggested implementation cadence
1. Phase 1: 2-4 weeks (highest urgency).
2. Phase 2: 2-3 weeks.
3. Phase 3: 3-6 weeks (incremental rollout).

## Suggested ownership model
1. Core runtime owner: scheduler + state machine + adapter protocol.
2. Platform/security owner: Electron preload/IPC hardening + backend auth.
3. Performance/data owner: storage model + image pipeline + sync.

## Out-of-scope for this roadmap
- New product features not required for correctness/security/scale.
- UI redesign work not tied to lifecycle state clarity.
- Monetization expansion beyond existing billing integration hardening.
