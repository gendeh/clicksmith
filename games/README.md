# Adding a game

`catalog.json` is the only file you edit to add a game. Clicksmith matches a window title to `windowHints` and records that window with the OS input path.

A game with no `adapterId` never talks to a mod. Genshin Impact and Minecraft are that shape. Geometry Dash names the Geode adapter, which stays optional and loopback-only.

Takeover is the same for every game. During playback, Takeover Now stops the macro at the grab point, keeps the events before it, and appends the clicks and keys you play next. The saved profile is yours.

Do not add a class, a screen-scrape bot, or a memory injector for a new title. Add a catalog object. If a later mod exists, point `adapterId` at an entry in `mods/registry.json`.
