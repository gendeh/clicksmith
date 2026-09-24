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
`games/catalog.json` is the list of games. A window title matches `windowHints`. A game without `adapterId` uses the OS recorder only. Geometry Dash is the one catalog entry that names the Geode adapter. Adding a game is a new object in that file.

## Security & Privacy
Profiles and screenshots remain local unless the user opts in to cloud sync.
