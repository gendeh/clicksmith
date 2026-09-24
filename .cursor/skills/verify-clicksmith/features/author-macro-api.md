# Author a macro over HTTP

The desktop client can store a takeover profile through the Express API. The saved body keeps the clicks and keys you appended, and the game id from the catalog. Genshin Impact and Minecraft each have a loopback adapter. The adapter does not attach to the game.

## Sub-features

- `api-adapter-takeover` starts the Minecraft loopback adapter, replays a base event, and stops a recording that contains your key.
- `api-store-append` posts the merged profile and reads it back.
- `api-health` answers `/health` on the same instance before the write.

## How to get to it (user POV)

- No extra screen. Cloud sync is the product path. This drive is the HTTP contract for a profile whose events include `human_override: true`.

## Driving it with control-clicksmith

Preconditions:

- Lane `api` is up. Doctor has passed since launch. The backend URL is in the verify state.
- Lane `ui` is not required for this drive.

- **Adapter.** The drive starts `scripts/synthetic-adapter.mjs` on `127.0.0.1` and an ephemeral port. `GET /status` returns id `minecraft-os`. `POST /replay/takeover` then `POST /record/stop` returns a `left` click and an `e` key.
- **Store.** The merged profile comes from `mergeTakeoverEvents`, then `POST /api/v1/profiles`. `GET /api/v1/profiles/<id>` returns `target_app` `Minecraft`, `metadata.custom.game_id` `minecraft`, and two events with `human_override: true`.
- **Proof.** `artifacts/author-macro-api/proof.json`, `create.json`, and `get.json`.

```bash
node .cursor/skills/verify-clicksmith/scripts/control-clicksmith.mjs drive author-macro-api
```

## Gotchas

- The loopback adapter is not Geode and not a game process. A green status on this port is not `lane game`.
- The in-memory store dies with the backend process. Create and get must hit the same process.
- If the Minecraft port in `mods/registry.json` (`27739`) is down, the desktop client records with OS hooks instead. This drive uses its own ephemeral port.
