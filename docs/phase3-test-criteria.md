# Phase 3 Move-On Test Criteria

This checklist validates performance/scalability upgrades introduced in Phase 3.

## Automated gates (must pass)

1. Build
- `npm run build`
- Pass condition: `client` and `backend` build cleanly.

2. Client tests
- `npm run test:client -- --runInBand`
- Pass condition: deterministic playback/recording suites pass.

3. Backend tests
- `npm run test:backend`
- Pass condition: no Phase 2 security regression.

## Manual gates (must pass)

1. Hot/cold event storage
- Record a profile with image capture enabled.
- Save profile, close app, relaunch.
- Replay same profile with SmartClick enabled.
- Pass condition:
- replay works after restart,
- profile data is preserved,
- no missing image-context errors in playback.

2. Outbox cloud sync retry
- Start app with API endpoint unreachable.
- Save profile while cloud sync opt-in is enabled.
- Bring API back online.
- Pass condition:
- operation is retried automatically,
- no local profile loss,
- retries back off (not tight-loop spam).

3. Image match cache + transport
- Replay a profile with repeated UI regions and SmartClick enabled.
- Optional: set `CLICKSMITH_IMAGE_TRANSPORT=binary`.
- Pass condition:
- no functional change in click resolution,
- reduced repeated image-match overhead on identical inputs.

4. Drift telemetry
- Run synthetic replay and inspect status/trace output.
- Pass condition:
- replay still reports drift metrics,
- no scheduler regression from worker/offload changes.

## Hard fail conditions (block completion)

1. Saved profiles lose click image context after app restart.
2. Cloud sync queue drops operations when offline.
3. Playback timing regresses beyond existing deterministic tests.
4. Any Phase 2 security gate regresses.
