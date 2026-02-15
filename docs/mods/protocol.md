# Clicksmith Mod Protocol (v1.0.0)

Clicksmith treats game mods as separate processes that expose a simple local API. The protocol
is intentionally minimal so each game/framework can implement it without sharing internals.

## Transport

- Local loopback HTTP (recommended)
- Base URL example: `http://127.0.0.1:27737`

## Required Endpoints

### `GET /status`

Returns a lightweight status payload. Clicksmith treats this as a hard compatibility
gate before any record/replay/takeover call is allowed.

Response:
```
{
  "ok": true,
  "id": "geode-geometry-dash",
  "name": "Clicksmith Geode Adapter",
  "game": "Geometry Dash",
  "version": "0.2.5",
  "protocol_version": "1.0.0",
  "capabilities": ["status", "record", "replay"],
  "tick_hz": 240,
  "record_state": "idle",
  "record_active": false,
  "record_armed": false,
  "record_complete": false,
  "replay_state": "idle",
  "replay_active": false,
  "replay_armed": false,
  "replay_requested": false,
  "paused": false,
  "takeover_armed": false
}
```

Required compatibility checks:
- `ok === true`
- `protocol_version` major must be `1`
- `capabilities` must include `status`, `record`, `replay`
- `tick_hz` must be finite and > 0
- record/replay lifecycle fields above must exist with valid enum/boolean types

## Core Endpoints (v0.2)

### `POST /record/start`
Starts a mod-side recording session. The mod should align timestamps to the
game tick timeline (not OS time).

Response:
```
{ "ok": true, "state": "armed" }
```

### `POST /record/stop`
Stops recording and returns captured events.

Response:
```
{
  "ok": true,
  "duration_ms": 1234.5,
  "tick_hz": 240,
  "events": [
    { "t_ms": 0.0, "button": "jump", "down": true, "player2": false },
    { "t_ms": 120.0, "button": "jump", "down": false, "player2": false }
  ]
}
```

### `POST /replay/start`
Starts replaying a macro. If `events` is omitted, the mod can replay the last
recorded macro.

Body:
```
{
  "events": [
    { "t_ms": 0.0, "button": "jump", "down": true, "player2": false }
  ]
}
```

### `POST /replay/stop`
Stops the mod-side replay loop.

Response:
```
{ "ok": true, "state": "stopped" }
```

## Optional Endpoints

### `POST /replay/takeover`

Signals the mod to hand control back to the user and switch to takeover recording.
Takeover is valid only while replay is `live`.

## Notes

- The mod should only bind to `127.0.0.1`.
- Clicksmith does not inject or modify game memory; mods are a separate, explicit opt-in.
