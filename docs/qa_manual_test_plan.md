# QA Manual Test Plan (MVP)

## Setup
- Install Clicksmith and accept the EULA.
- Start backend and image-service locally.
- Launch a test app window (Notepad or a simple demo app).

## Recording Flow
1. Select the target window in the client.
2. Start recording with F9.
3. Click and type for 20 seconds.
4. Stop recording with F9.
5. Verify Save/Discard modal appears with event count.
6. Save the profile and confirm it appears in the library.

## Playback Flow
1. Select the saved profile.
2. Start playback with F10.
3. Verify clicks align and timing drift stays under 30ms for most events.
4. Trigger takeover with F11 and verify playback pauses.
5. Resume playback and confirm it completes cleanly.

## SmartClick Matching
1. Move the target window slightly.
2. Replay the profile with SmartClick enabled.
3. Confirm matches resolve within confidence > 0.6 and fallback retries occur if needed.

## Cloud Sync (Opt-In)
1. Toggle cloud sync in Settings (Pro).
2. Save a new profile.
3. Verify the backend receives a create profile request.

## Import/Export
1. Export profiles to JSON.
2. Delete a profile.
3. Import the exported JSON and confirm profiles are restored.

## EULA & Compliance
1. Reset local settings and relaunch.
2. Verify EULA prompt appears and blocks usage until accepted.
