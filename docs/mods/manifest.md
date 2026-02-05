# Adapter Manifest Format

The mod registry is a JSON file that lists adapters Clicksmith can surface in the UI.

File: `mods/registry.json`

## Top-Level

```
{
  "version": 1,
  "adapters": [ ... ]
}
```

## Adapter Fields

- `id` (string, required): Stable identifier for the adapter.
- `name` (string, required): Display name.
- `description` (string, optional): Short summary shown in the UI.
- `framework` (string, required): Mod framework name (Geode, BepInEx, etc).
- `game` (string, required): Game title.
- `platforms` (array, optional): Supported platforms (`win32`, `darwin`, `linux`).
- `install` (object, optional):
  - `instructionsPath` (string): Repo-relative doc path.
  - `downloadUrl` (string): External install page.
- `detect` (object, optional): Platform-specific install probes.
  - `win32` / `darwin` / `linux`: array of filesystem paths. Supports `~`, `$VAR`, `%VAR%`.
- `launch` (object, optional):
  - `type`: `uri` or `appPath`
  - `value`: URI (Steam) or absolute path to the game app.
- `protocol` (object, optional):
  - `type`: `local-http`
  - `statusUrl`: URL for `GET /status`.
  - `baseUrl`: Base URL for adapter endpoints (ex: `http://127.0.0.1:27737`).

## Example

```
{
  "id": "geode-geometry-dash",
  "name": "Geode (Geometry Dash)",
  "framework": "Geode",
  "game": "Geometry Dash",
  "install": {
    "instructionsPath": "docs/mods/geode.md",
    "downloadUrl": "https://geode-sdk.org"
  },
  "detect": {
    "darwin": ["~/Library/Application Support/Geode"],
    "win32": ["%APPDATA%\\Geode"]
  },
  "launch": {
    "type": "uri",
    "value": "steam://rungameid/322170"
  },
  "protocol": {
    "type": "local-http",
    "statusUrl": "http://127.0.0.1:27737/status",
    "baseUrl": "http://127.0.0.1:27737"
  }
}
```
