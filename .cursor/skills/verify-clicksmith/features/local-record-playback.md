# Local record and playback

OS-level recording and playback inject real mouse and keyboard events through `uiohook-napi` and `robotjs` inside Electron main.

## Sub-features

- `desktop-record` captures real input against a target window.
- `desktop-play` replays a saved profile onto that window.
- `desktop-takeover` pauses replay and splices a human correction.

## How to get to it (user POV)

- Launch the packaged Clicksmith or `cd client && npm run start` on macOS or Windows.
- Choose a target window. Press `F9` to record, `F10` to play, `F11` for takeover.

## Driving it with control-clicksmith

Preconditions:

- Lane `desktop`. Accessibility / input monitoring permission granted.
- A disposable target window exists (TextEdit, Notepad).
- Linux Cloud Agents: **SKIP desktop**.

- **Record.** Focus the target, press `F9`, click once, press `F9`. Save-run modal shows at least one event.
- **Play.** Press `F10`. The target receives the click. Playback chip returns to Ready.
- **Proof.** Event count in the saved profile, plus a screen recording of the target reacting. Unit tests with `MockInputHook` are not this feature.

## Gotchas

- Cloud Ubuntu cannot satisfy this feature. Skipping is correct; substituting the verify-bridge record flow is not.
- `npm install` of native addons often fails on Linux. That is a packaging issue, not a passed skip.
- Geometry Dash playback belongs to the Geode feature, not this one.
