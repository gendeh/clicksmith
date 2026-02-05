# Geode Adapter (Geometry Dash)

This adapter runs inside Geometry Dash via Geode and exposes a local API for
high-fidelity recording/replay. Clicksmith does **not** install Geode for you.

## Install Steps (Manual)

1) Download and install Geode from the official site.
2) Launch Geometry Dash once to let Geode initialize.
3) Build/install the Clicksmith Geode adapter from `geode-adapter/`.
4) Restart the game.

## What Clicksmith Does

- Detects Geode by checking common install paths.
- Probes the local adapter endpoint (`/status`, `/record/*`, `/replay/*`).
- Can launch the game via Steam if available.

If Clicksmith still shows "Installed: No", add your actual Geode path to `mods/registry.json`
under the `detect.darwin` list and click "Refresh List" in the Mods panel.

## Notes

- This adapter is optional and separate from the Clicksmith overlay.
- Mods run inside the game process and must be installed separately.
- Use only in offline/single-player contexts that permit mods.
