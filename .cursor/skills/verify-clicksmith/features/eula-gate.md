# EULA gate

First launch blocks the Profile Manager behind a use-policy modal until the user accepts.

## Sub-features

- `eula-block` hides the manager behind the policy dialog.
- `eula-accept` dismisses the dialog and shows `[data-testid="app-shell"]` controls.

## How to get to it (user POV)

- Launch Clicksmith with no prior EULA acceptance (fresh settings store).
- Verify renderer: open `/?eula=required`.

## Driving it with control-clicksmith

Preconditions:

- Renderer URL includes `?eula=required`, or desktop settings have `eulaAccepted=false`.

- **Block.** Open the EULA URL. `[data-testid="eula-modal"]` is visible and `[data-testid="btn-record"]` is not clickable through the backdrop.
- **Accept.** Click `[data-testid="eula-accept"]`. The modal detaches and `[data-testid="controls-card"]` is usable.
- **Proof.** Screenshot `artifacts/eula-gate/blocked.png` and `accepted.png`.

## Gotchas

- The default verify URL accepts EULA automatically so other features can run. You must use `?eula=required` for this feature.
- Accepting once in Electron writes `electron-store`. A second launch on the same user profile will not show the modal.
