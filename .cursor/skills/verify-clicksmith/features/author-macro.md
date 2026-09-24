# Author a macro

Author a macro is how you record your own clicks and keys for a game, then grab the wheel during playback so your correction is appended onto the run. The saved profile is yours. Geometry Dash, Genshin Impact, and Minecraft are catalog entries. A new game is another object in `games/catalog.json`.

## Sub-features

- `author-pick-game` chooses a catalog game and points TARGET at that window.
- `author-play` plays the selected profile.
- `author-takeover` pauses playback and opens the save modal with your clicks and keys appended.
- `author-save` keeps the merged profile in the list, including a yours count.

## How to get to it (user POV)

- Open the Profile Manager. The left card is titled `Controls`.
- The Game row lists every title in `games/catalog.json`.
- Choose the game, press Play Selected, then Takeover Now, then Save Profile.

## Driving it with control-clicksmith

Preconditions:

- Lane `ui` is healthy. `[data-testid="app-shell"]` is visible.
- EULA modal is not showing.
- Doctor has passed since launch.

- **Pick a game.** Wait until `[data-testid="select-target"]` has an option `Minecraft`. Choose `[data-testid="game-minecraft"]`. `[data-testid="chip-target"]` reads `TARGET · Minecraft` and `[data-testid="game-match"]` reads `Minecraft`.
- **Play.** Choose `[data-testid="btn-play"]`. `[data-testid="chip-play"]` reads `PLAY · Running`.
- **Take the wheel.** Choose `[data-testid="btn-takeover"]`. `[data-testid="takeover-summary"]` says your clicks and keys were appended.
- **Save.** Enter `Minecraft wheel grab` in `[data-testid="save-run-name"]` and choose `[data-testid="save-run-confirm"]`. The new profile card contains that name and the word `yours`.
- **Proof.** Keep `artifacts/author-macro/playing.png`, `appended.png`, `saved.png`, and `proof.json`.

One command drives the whole path:

```bash
node .cursor/skills/verify-clicksmith/scripts/control-clicksmith.mjs drive author-macro
```

## Gotchas

- Genshin Impact and Minecraft have no `adapterId`. Choosing them must not enable the Geode toggle or send input to `127.0.0.1:27737`.
- This lane does not inject OS clicks into a real game. A saved yours count is the UI contract for the append. Real hooks are `SKIP desktop`. A live Geode process is `SKIP game`.
- Adding a title means editing `games/catalog.json` only. Do not add a class per game.
- `node scripts/repro-takeover.mjs` replays the append on a timeline and writes `artifacts/repro-takeover/report.json`. `node scripts/repro-takeover.mjs --heap` also writes a heap snapshot next to that report. The report's `gapMs` is `0` when the human segment starts on the grab.
- Status chips are CSS-uppercased. `textContent` on `[data-testid="chip-target"]` stays `Minecraft`. `innerText` reads `MINECRAFT`.
