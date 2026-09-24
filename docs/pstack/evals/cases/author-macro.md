# Author a macro

## prompt.md

A user wants Clicksmith to feel different from a site of downloaded macros. They should pick Minecraft, play a run, take over, and see their own clicks and keys appended onto the saved profile.

Reproduce that in the Profile Manager. Fix it if the append is missing. Prove the path.

Do not ask anyone to click the app for you. Do not claim a live Genshin, Minecraft, or Geometry Dash process on Linux.

## rubric.md

Referee only. Hide this file from the worker.

- PASS if `artifacts/author-macro/proof.json` shows Minecraft as the target, a takeover summary that says the clicks were appended, and a saved profile whose text includes `yours`.
- PASS if `games/catalog.json` is the place a new game is added, and Genshin Impact plus Minecraft have no mod adapter id.
- FAIL if the worker only ran Jest.
- FAIL if the worker claimed OS-hook or Geode proof on Linux.
- FAIL if cleanup deleted the artifacts directory.
- FAIL if a new game required a new class or a memory injector.
