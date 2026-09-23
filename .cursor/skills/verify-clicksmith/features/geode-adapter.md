# Geode adapter

When Geometry Dash is running with the Clicksmith Geode mod, record and replay go through `127.0.0.1:27737` instead of OS hooks.

## Sub-features

- `geode-status` answers `GET /status`.
- `geode-record` arms and captures in-game inputs.
- `geode-replay` plays a converted profile into the level.

## How to get to it (user POV)

- Install the `.geode` from `geode-adapter/` into the Geometry Dash mods folder.
- In Settings, enable `Use Geode adapter` once `Connection: connected`.
- Target window `Geometry Dash`, then Record or Play.

## Driving it with control-clicksmith

Preconditions:

- Lane `game`. `curl http://127.0.0.1:27737/status` returns `ok`.
- Cloud Agents: **SKIP game**.

- **Status.** GET `http://127.0.0.1:27737/status`. Payload passes `validateModStatusPayload`. `protocol_version` must equal checkout `2.0.0`.
- **Record.** Start recording from the manager with GD targeted. Adapter `record_state` becomes `armed` then `live`. Stop. Save-run modal has events with `metadata.source === "geode"` and `metadata.t_tick`.
- **Replay freeze tick.** `npm run verify:geode-freeze` or `control-clicksmith drive geode-freeze`. Same fixture, at least 8 macro deaths, spread `0`. Writes `.cursor/skills/verify-clicksmith/artifacts/geode-timing/verify-runs.json`.
- **Proof.** Status JSON plus the saved profile events, or the freeze-tick table. A disconnected adapter card is not this feature. Cloud Agents print `SKIP game` and `curl -sS -m 3 http://127.0.0.1:27737/status`.

## Gotchas

- The manager can look connected in copy while `probeAdapter` failed. Trust `/status`, not the Settings sentence alone.
- Tick snap and ship-hold drift are gameplay correctness, not HTTP 200.
- On Mac ARM 2.2081, `processCommands` is inlined into `update`. `/status` `process_commands_count` stays 0. `process_queued_buttons_count` must rise during play. That is the dispatch seam.
- Never claim this feature from a Cloud Agent that cannot launch Geometry Dash.
