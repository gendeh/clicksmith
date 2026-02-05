# Clicksmith Mod Protocol (Draft v0.1)

Clicksmith treats game mods as separate processes that expose a simple local API. The protocol
is intentionally minimal so each game/framework can implement it without sharing internals.

## Transport

- Local loopback HTTP (recommended)
- Base URL example: `http://127.0.0.1:27737`

## Required Endpoints

### `GET /status`

Returns a lightweight status payload.

Response:
```
{
  "ok": true,
  "id": "geode-geometry-dash",
  "name": "Geode Adapter",
  "game": "Geometry Dash",
  "version": "0.1.0",
  "capabilities": ["record", "replay"],
  "tick_hz": 240
}
```

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

### `POST /takeover`

Signals the mod to hand control back to the user.

## Notes

- The mod should only bind to `127.0.0.1`.
- Clicksmith does not inject or modify game memory; mods are a separate, explicit opt-in.
