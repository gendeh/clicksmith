# Architecture Overview

## Components
- **Electron Client**: Overlay UI, recording, playback, local profile store.
- **Image Service**: OpenCV matching + OCR endpoint.
- **Backend API**: Profiles, auth, and billing.
- **Overwolf Client**: Windows-only overlay skeleton.

## Data Flow
1. Recording engine captures input events + image patches.
2. Draft run triggers Save/Discard decision.
3. Saved profiles stored locally and optionally synced to Firestore.
4. Playback engine replays input, using SmartClick via image-service.
5. Takeover keeps events before the grab and appends the clicks and keys you play next.

## Games
`games/catalog.json` is the list of games. Each game names an `adapterId` in `mods/registry.json`. Geometry Dash names Geode. Genshin Impact and Minecraft name loopback stand-ins that do not attach to the game. If that port is down, recording uses OS input on the window. Adding a game is a catalog object plus a registry adapter.

## Security & Privacy
Profiles and screenshots remain local unless the user opts in to cloud sync.
