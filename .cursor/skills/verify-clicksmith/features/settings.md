# Settings

Settings is the right-hand card where a user opts into telemetry, SmartClick, Geode, 240Hz snap, and cloud sync.

## Sub-features

- `settings-smartclick` toggles image matching.
- `settings-geode` toggles Use Geode adapter (disabled while disconnected).
- `settings-cloud-sync` toggles cloud sync when the subscription allows it.
- `settings-radius` changes SmartClick search radius.

## How to get to it (user POV)

- Open the Profile Manager. The right card is titled `Settings`.

## Driving it with control-clicksmith

Preconditions:

- Lane `ui` is healthy.
- Verify bridge seeds a Pro subscription, so cloud sync is enabled.

- **SmartClick.** Click `[data-testid="toggle-smartclick"]` until unchecked. Reload. The checkbox stays unchecked.
- **Radius.** Set the number input labeled `SmartClick search radius (px)` to `96`. Reload. The value is `96`.
- **Geode.** `[data-testid="toggle-geode"]` is disabled while the adapter card says `Connection: disconnected`. Do not force-enable it.
- **Cloud sync.** Click `[data-testid="toggle-cloud-sync"]`. Reload. The checkbox matches the last click.
- **Proof.** Screenshot `artifacts/settings/toggles.png` with the changed controls visible, plus the post-reload values.

## Gotchas

- Geode enabled while disconnected is not a valid proof. The control is disabled on purpose.
- Free-tier Electron builds disable cloud sync. The verify bridge uses Pro so Cloud Agents can exercise the control. Real free-tier behavior is a desktop subscription check.
- Changing a toggle is not proof until reload (or `SETTINGS_GET`) shows the stored value.
