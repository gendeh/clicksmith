# Clicksmith Handoff (2026-02-04)

**Project**: `/Users/maxgendeh/Documents/Git/clicksmith`

**Current Status**
- Geode adapter is working and loads in GD. Status endpoint responds on `127.0.0.1:27737`.
- Clicksmith can use the Geode adapter for record/replay via the “Use Geode adapter when connected (Geometry Dash)” toggle.
- Adapter version is `0.2.1` (shown in Geode Installed list).
- Core adapter endpoints implemented:
  - `GET /status`
  - `POST /record/start`
  - `POST /record/stop`
  - `POST /replay/start`
  - `POST /replay/stop`
- Remaining issue: ship hold still drifts (needs tick-quantized replay or mod-side timing enhancements).

**Key Files Changed**
- `geode-adapter/src/main.cpp` (HTTP server, chunked/body parsing, record/replay hooks, GJBaseGameLayer + PlayerObject hooks)
- `geode-adapter/mod.json` (version 0.2.1)
- `client/src/main/main.ts` (mod adapter record/replay path, conversions, status error reporting)
- `client/src/renderer/App.tsx` (adapter toggle, playback error display)
- `client/src/main/settingsStore.ts` (new `useModAdapter` pref)
- `client/src/types/index.ts` (mod protocol baseUrl, `useModAdapter` pref)
- `client/src/main/modManager.ts` (baseUrl, detection path for GD app bundle)
- `mods/registry.json` (baseUrl + detection path)
- `docs/mods/protocol.md` / `docs/mods/manifest.md` / `docs/mods/geode.md`

**Build and Run (Client)**
```
cd /Users/maxgendeh/Documents/Git/clicksmith/client
npm run build
npm run start
```

**Build and Install (Geode Adapter)**
```
cd /Users/maxgendeh/Documents/Git/clicksmith/geode-adapter
rm -rf build
export CMAKE_OSX_ARCHITECTURES="arm64;x86_64"
geode build
```

**Install Path (GD App Bundle)**
- Copy `clicksmith.geode-adapter.geode` to:
  - `/Users/maxgendeh/Library/Application Support/Steam/steamapps/common/Geometry Dash/Geometry Dash.app/Contents/geode/mods`
- Clear cache:
```
rm -f "/Users/maxgendeh/Library/Application Support/Steam/steamapps/common/Geometry Dash/Geometry Dash.app/Contents/geode/mods/.geode_cache"
```

**Quick Health Checks**
- Geode log shows adapter listening:
  - `Clicksmith adapter: listening on 127.0.0.1:27737`
- Status check:
```
curl http://127.0.0.1:27737/status
```

**Known Issues / Next Work**
- Ship drift persists even with mod replay.
- Proposed next step: implement “arm recording” and tick-quantized replay in the Geode adapter.
- F10 hotkey can be intercepted by macOS; manual “Play Selected” works once adapter is connected.
