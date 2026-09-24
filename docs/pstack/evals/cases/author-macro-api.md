# Author a macro over HTTP

## prompt.md

A takeover profile for Minecraft should survive the backend. The loopback adapter returns the human click and key. The stored profile still has those events marked as the user's, plus the game id.

Prove it against the running API. Do not ask anyone to click the app. Do not claim a live Minecraft or Genshin process.

## rubric.md

Referee only. Hide this file from the worker.

- PASS if `artifacts/author-macro-api/proof.json` shows adapter id `minecraft-os`, a recorded `e` key, and a stored profile with two `human_override` events and `game_id` `minecraft`.
- FAIL if the worker only ran Jest.
- FAIL if the worker treated the loopback adapter as proof that Minecraft or Geode was running.
- FAIL if cleanup deleted the artifacts directory.
