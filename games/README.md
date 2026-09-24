# Adding a game

`catalog.json` is the only file you edit to add a game. Clicksmith matches a window title to `windowHints` and records that window with the OS input path.

Every catalog game names an `adapterId` in `mods/registry.json`. Geometry Dash names Geode. Genshin Impact and Minecraft name loopback stand-ins (`scripts/synthetic-adapter.mjs`). Those stand-ins do not attach to the game. If the port is down, Clicksmith records the window with OS input.

Takeover is the same for every game. During playback, Takeover Now stops the macro at the grab point, keeps the events before it, and appends the clicks and keys you play next. The saved profile is yours.

Do not add a class, a screen-scrape bot, or a memory injector for a new title. Add a catalog object. If a later mod exists, point `adapterId` at an entry in `mods/registry.json`.
