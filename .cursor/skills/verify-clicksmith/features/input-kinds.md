# Input kinds

A saved run lists every gaming input it captured. Pointer clicks (mouse and trackpad), keyboard keys, pointer motion, scroll, and gamepad samples are separate kinds. The save dialog shows that mix before the profile is kept.

## Sub-features

- `manager-save-summary` shows the captured kinds after Record is stopped.
- `desktop-capture` records those kinds from the OS hook and replays them. Cloud Agents skip this entry.

## How to get to it (user POV)

- Open the Profile Manager.
- Choose Record, then Record again to stop.
- Read the line under the event count in the save dialog.

## Driving it with control-clicksmith

Preconditions:

- Lane `ui` for `manager-save-summary`. The verify renderer is up and doctor is green.
- Lane `desktop` for `desktop-capture`. Accessibility / input monitoring permission granted. Linux Cloud Agents: **SKIP desktop**.

- **Summary.** `node .cursor/skills/verify-clicksmith/scripts/control-clicksmith.mjs drive input-kinds`. `[data-testid="save-run-kinds"]` reads `1 pointer click, 1 key, 1 pointer move, 1 scroll, 1 gamepad input`.
- **Desktop capture.** On macOS or Windows, `cd client && npm run start`, press `F9`, use a mouse button, a key, a scroll, and a gamepad, press `F9` again. The same kinds line includes each device you used. Playback with `F10` repeats pointer, key, and scroll on the target. Gamepad playback reports `gamepad_output_unavailable` unless a virtual pad sink is attached.
- **Proof.** `artifacts/input-kinds/proof.json` plus `kinds.png`. Engine coverage is `client/tests/inputKinds.test.ts`.

## Gotchas

- The verify bridge stops a recording with one sample of each kind. That proves the dialog. It does not prove `uiohook-napi` or `/dev/input/js*`.
- Trackpad taps and two-finger scroll are pointer clicks and wheel events. There is no separate trackpad type.
- Side mouse buttons record as `back` and `forward`. `robotjs` may reject them at playback time.
- SmartClick retargets pointer clicks, motion anchors, and scrolls that carry `img_patch_b64`. A later move without a patch keeps the last match offset. Keys and gamepad samples stay on their own path. The engine proof is `client/tests/smartClickInputs.test.ts`.
- Unknown pointer buttons are dropped. They are not stored as left clicks.
- Gamepad recording reads Linux joystick devices when they are readable. Playback does not invent a keyboard substitute.
