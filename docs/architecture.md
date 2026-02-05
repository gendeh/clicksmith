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

## Security & Privacy
Profiles and screenshots remain local unless the user opts in to cloud sync.
