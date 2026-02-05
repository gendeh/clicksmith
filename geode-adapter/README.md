# Clicksmith Geode Adapter (Stub)

This is a minimal Geode mod that exposes a local status endpoint for Clicksmith.
It does not inject replay logic yet; it only reports that the mod is running.

## What It Does

- Starts a local HTTP server on `127.0.0.1:27737`
- Responds to `GET /status` with a JSON payload

## Build Prerequisites

- Geode SDK installed
- CMake 3.21+
- A C++ toolchain (Xcode on macOS, MSVC on Windows)

## Build (macOS)

```
export GEODE_SDK=/path/to/geode-sdk
cmake -S . -B build
cmake --build build --config Release
```

## Build (Windows)

```
set GEODE_SDK=C:\path\to\geode-sdk
cmake -S . -B build
cmake --build build --config Release
```

## Install

Copy the built mod to your Geode mods folder, then launch Geometry Dash.
Clicksmith should show `Connection: connected` in the Mods panel.

## Status Response

```
GET http://127.0.0.1:27737/status
```

Example response:
```
{
  "ok": true,
  "id": "geode-geometry-dash",
  "name": "Clicksmith Geode Adapter",
  "game": "Geometry Dash",
  "version": "0.1.0",
  "capabilities": ["status"],
  "tick_hz": 240
}
```
