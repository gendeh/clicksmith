# Profiles

The Profiles card is the user's library of saved runs: select, play, delete, and persist a draft after recording.

## Sub-features

- `profiles-list` shows saved runs or the empty state.
- `profiles-select` marks a card Selected.
- `profiles-save-draft` names a finished recording and keeps it in the list.
- `profiles-delete` removes the selected run after confirm.

## How to get to it (user POV)

- Open the Profile Manager. The middle card is titled `Profiles`.
- Finish a recording; the save-run modal is the other entry into the same library.
- Import/Export in Controls are file-dialog desktop paths.

## Driving it with control-clicksmith

Preconditions:

- Lane `ui` is healthy.
- For delete, at least one profile card is visible (the verify bridge seeds `Verify Seed`).

- **List.** Read `[data-testid="profile-list"]`. Either `[data-testid="profile-empty"]` or one or more `[data-testid^="profile-card-"]` is present.
- **Select.** Click a profile card. It has class `profile-card-active` and a `Selected` tag.
- **Save draft.** Complete `controls-record`, set `[data-testid="save-run-name"]` to `Library Keep`, click `[data-testid="save-run-confirm"]`. Reload the page. `Library Keep` is still listed.
- **Discard draft.** Complete `controls-record`, click `[data-testid="save-run-discard"]`. The modal closes and no new name appears.
- **Delete.** Select a disposable profile, click `[data-testid="btn-delete-profile"]`, accept `window.confirm`. That card is gone.
- **Proof.** Screenshot `artifacts/profiles/list.png` showing the saved name, and after reload a second screenshot proving persistence.

## Gotchas

- Import and Export open native file dialogs. Those entry points are `SKIP desktop` on Cloud Agents.
- `window.confirm` must be accepted by the driver (`page.on('dialog')` in Playwright). Dismissing it is not a delete proof.
- Persistence proof is a reload or a second list read, not the toast-less in-memory update alone.
