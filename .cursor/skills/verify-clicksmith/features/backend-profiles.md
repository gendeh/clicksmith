# Backend profiles

The Express API stores profiles used by optional cloud sync. Users never hit it directly; the desktop client does when cloud sync is on. Agents prove the HTTP contract.

## Sub-features

- `api-health` answers `/health`.
- `api-create` inserts a profile and returns an id.
- `api-list` returns the created profile.
- `api-delete` removes it.

## How to get to it (user POV)

- No GUI. Cloud sync in Settings is the product entry. This feature is the HTTP contract behind that toggle.

## Driving it with control-clicksmith

Preconditions:

- Lane `api` doctor is green.
- Backend URL from state or `http://127.0.0.1:3000`.

- **Health.** `control-clicksmith http GET <backend>/health`. Status 200, `status` is `ok`.
- **Create.** POST `<backend>/api/v1/profiles` with a JSON body containing `name`, `target_app`, `created_at`, `events`, `success_metric`, `version`, `notes`. Status 201 and an `id`.
- **List.** GET `<backend>/api/v1/profiles`. Status 200 and the new `id` is present.
- **Get.** GET `<backend>/api/v1/profiles/<id>`. Body `name` matches what was posted.
- **Delete.** DELETE `<backend>/api/v1/profiles/<id>`. Follow-up GET is 404 or missing from list.
- **Proof.** Write the create and get JSON to `artifacts/backend-profiles/create.json` and `get.json`.

## Gotchas

- In-memory mock DB resets when the process restarts. Do not split create and get across a restart.
- Stripe checkout is not part of this feature. Hitting `/api/v1/billing/checkout` without keys is not a profile proof.
- Firebase is optional. The mock store is the cloud-agent source of truth.
