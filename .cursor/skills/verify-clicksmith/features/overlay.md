# Overlay

The overlay is a small always-on-top bar with REC/PLAY status and Rec, Play, Takeover actions.

## Sub-features

- `overlay-status` shows LIVE/ARMED/REC and PLAY.
- `overlay-record` starts and stops recording from the bar.
- `overlay-play` starts and stops playback from the bar.

## How to get to it (user POV)

- Desktop: `Ctrl+Shift+O` toggles the overlay window.
- Verify renderer: open `/#/overlay`.

## Driving it with control-clicksmith

Preconditions:

- Lane `ui`. Navigate to the overlay hash route.

- **Open.** Go to `<renderer>/#/overlay`. `[data-testid="overlay-root"]` is visible.
- **Record.** Click `[data-testid="overlay-record"]`. `[data-testid="overlay-rec-label"]` reads `LIVE`.
- **Proof.** Screenshot `artifacts/overlay/bar.png` with the overlay bar filling the viewport.

## Gotchas

- The overlay route does not render the Profile Manager. Do not look for `[data-testid="app-shell"]` here.
- Click-through / ignore-mouse-events is Electron-only. The verify overlay is a normal page.
- Save-run modal is on the manager window, not the overlay route. After overlay record/stop, switch to the manager URL to finish save.
