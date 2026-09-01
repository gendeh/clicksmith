# Manager controls

The Controls card is how a user starts and stops recording and playback, picks a target window, and triggers takeover from the Profile Manager.

## Sub-features

- `controls-record` starts recording and shows REC Live, then stops into the save-run modal.
- `controls-play` plays the selected profile and shows PLAY Running.
- `controls-takeover` pauses playback from Takeover Now.
- `controls-target` changes the TARGET chip when a listed window is chosen.

## How to get to it (user POV)

- Open the Profile Manager window. The left card is titled `Controls`.
- Press `F9` to toggle recording and `F10` to toggle playback (desktop Electron only; the verify renderer has no global hotkeys).
- Use the overlay Rec/Play/Takeover buttons — those are the overlay feature, not this one.

## Driving it with control-clicksmith

Preconditions:

- Lane `ui` is healthy. `[data-testid="app-shell"]` is visible.
- EULA modal is not showing.
- Doctor has passed since launch.

- **Record.** Choose `Start Recording`. Run `node .cursor/skills/verify-clicksmith/scripts/control-clicksmith.mjs drive manager-controls`. `[data-testid="chip-rec"]` reads `REC · Live`, then after stop `[data-testid="save-run-modal"]` appears.
- **Save from this flow.** Enter `Verify Manager Run` in `[data-testid="save-run-name"]` and choose `Save Profile`. The profiles list contains that name.
- **Play.** Select a profile card, then choose `Play Selected`. `[data-testid="chip-play"]` reads `PLAY · Running`.
- **Takeover.** Choose `Takeover Now` while playing. `[data-testid="chip-play"]` reads `PLAY · Paused`.
- **Target.** Open `[data-testid="select-target"]` and choose `Notepad`. `[data-testid="chip-target"]` reads `TARGET · Notepad`.
- **Proof.** Keep `artifacts/manager-controls/idle.png`, `recording.png`, `saved.png`, and `proof.json`.

## Gotchas

- Button labels toggle. Target `[data-testid="btn-record"]`, not the text `Start Recording`.
- Status chips are CSS-uppercased (`REC · IDLE`). Match case-insensitively.
- `F9`/`F10` do nothing in the verify renderer. That is expected. Report hotkeys as `SKIP desktop`.
- Play is disabled when no profile is selected. Select a card first.
- This lane does not inject OS clicks. A green save modal is UI-contract proof, not proof that `uiohook-napi` captured a real mouse event.
