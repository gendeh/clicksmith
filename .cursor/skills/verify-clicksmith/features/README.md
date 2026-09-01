# Clicksmith verification map

This directory is the maintained source for verifying user-facing Clicksmith behavior. Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Use a verify instance this run started, or the Cloud Agent boot instance on `http://127.0.0.1:3000` (backend), `http://127.0.0.1:5001` (image-service), and `http://127.0.0.1:5173` (verify renderer).
- Run doctor and require every URL for the chosen lane to answer.
- Never drive a second instance on the same ports.
- Lane `ui` requires `[data-testid="app-shell"]`. If `[data-testid="startup-error"]` is present, the IPC bridge failed; stop and fix launch.
- Lane `desktop` needs a packaged or `electron .` session on macOS/Windows with OS input permission. Linux Cloud Agents skip it.
- Lane `game` needs Geometry Dash plus the Geode adapter listening on `127.0.0.1:27737`. Cloud Agents skip it.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Prefer `data-testid` handles. Do not click by CSS class or bounding-box coordinates.
- Treat every command as literal.
- Restore seeded profiles after a mutation. Do not remove proof artifacts during cleanup.
- A cloud run that cannot reach a lane reports `SKIP <lane>` instead of borrowing a different lane's proof.

## Proof and skip reporting

- Capture the user action and the resulting state.
- UI proof includes a screenshot with the Clicksmith identity visible and the observed `data-testid` text.
- HTTP proof includes status code and body, plus a follow-up read for writes.
- Record the feature ID and entry point with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features`
2. `How to get to it (user POV)`
3. `Driving it with control-clicksmith`
4. `Gotchas`

## Features

Cloud-verifiable:

- [Manager controls](./manager-controls.md) covers record, play, takeover, and target selection in the Profile Manager.
- [Profiles](./profiles.md) covers library selection, save-from-draft, and delete.
- [Settings](./settings.md) covers SmartClick, Geode, and cloud-sync toggles.
- [EULA gate](./eula-gate.md) covers first-run policy acceptance.
- [Overlay](./overlay.md) covers the always-on-top overlay bar.
- [Backend profiles](./backend-profiles.md) covers HTTP create/list/get/delete.
- [Image matching](./image-matching.md) covers SmartClick `/match`.

Desktop or game only — skip on Cloud Agents:

- [Local record and playback](./local-record-playback.md) covers OS-level hooks and Electron main-process engines.
- [Geode adapter](./geode-adapter.md) covers Geometry Dash record/replay through the in-process adapter.
