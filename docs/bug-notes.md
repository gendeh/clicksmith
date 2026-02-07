# Clicksmith Bug Notes

This is a running log of the main bugs we hit during MVP development, how they showed up, and how they were fixed.

## 1) Electron native module ABI mismatch (`NODE_MODULE_VERSION` error)
- Symptom: App crashed on launch with `robots.node was compiled against a different Node.js version`.
- Root cause: Native dependency was built for a different Electron runtime ABI.
- Fix: Rebuilt/reinstalled native modules against the active Electron version (`npm rebuild` / clean install).

## 2) Accessibility crash on record start (`SIGABRT`, Accessibility API disabled)
- Symptom: Pressing record crashed process on macOS.
- Root cause: Input hook library requires macOS Accessibility + Input Monitoring permissions for the launched `Electron.app`.
- Fix: Added permission steps and startup checks; app no longer proceeds blindly when permissions are missing.

## 3) Overlay did not appear as expected in Dock/permissions list
- Symptom: User could not find/authorize the right app instance.
- Root cause: Permissions were granted to a different binary/path than the one actually launched by dev Electron.
- Fix: Standardized launch path instructions and clarified exact app entry in system settings.

## 4) Recording showed active but no profile/draft was created
- Symptom: UI said recording, but profile library stayed empty.
- Root cause: Hook events were not arriving due permission/runtime mismatch and state transitions not handling no-event runs cleanly.
- Fix: Added stronger state handling and draft save flow; fixed hook setup path.

## 5) Main process TypeScript build failures (config/type drift)
- Symptom: `tsc` errors across playback/profile/settings files.
- Root cause: New playback fields introduced without type updates and nullable handling.
- Fix: Synchronized `PlaybackConfig`/settings/types, removed unsafe `undefined` assignments, and added null-safe paths.

## 6) Stripe checkout failed (`ECONNREFUSED ::1:3000`)
- Symptom: Upgrade button did nothing; main process logged fetch failure.
- Root cause: Backend API server not running (client expected local billing endpoint).
- Fix: Added clearer dependency/run ordering and better error surfacing in UI.

## 7) Image matching service failed during playback (`ECONNREFUSED ::1:5001`)
- Symptom: Playback stopped after first action, with image-service fetch errors.
- Root cause: Optional image service was unavailable but playback path still depended on it.
- Fix: Added graceful fallback and clearer service status/error messaging.

## 8) Keyboard replay threw `Invalid key code specified`
- Symptom: Unhandled rejection during keyboard event playback.
- Root cause: Recorded key values were not normalized to robotjs-valid key codes.
- Fix: Added key normalization/guards and error handling for unsupported codes.

## 9) Overlay hitbox was larger than visible pill
- Symptom: Clicking transparent area still focused/captured overlay window.
- Root cause: Window accepted pointer events outside visible control surface.
- Fix: Tightened click-through behavior to only interactive controls.

## 10) Overlay too large / cropped / poor ergonomics
- Symptom: UI occupied too much space and required manual resize to access controls.
- Root cause: Early layout was panel-heavy and not compact for in-level usage.
- Fix: Reworked to compact "island" style overlay and reduced always-on visual footprint.

## 11) Playback state got stuck on `Stop F10`
- Symptom: Playback visually remained active after events ended.
- Root cause: No reliable completion signal from adapter in all paths.
- Fix: Added adapter status fields + client polling + auto-idle settle logic.

## 12) Geode adapter packaging/version errors
- Symptom: Mod failed to load (`mod.json` schema/version errors).
- Root cause: Geode schema changes (`gd` field/resources format/version contract).
- Fix: Updated `mod.json` structure and version compatibility fields.

## 13) Geode mod binary failed to load on macOS
- Symptom: `Couldn't load binary` / `dlopen` errors.
- Root cause: Architecture mismatch (single-arch build vs universal target/runtime).
- Fix: Built adapter with `arm64;x86_64` and validated target binary architecture.

## 14) Geode folder confusion (mod present on disk but not in loader)
- Symptom: File copied, but Geode UI did not show/load adapter.
- Root cause: Wrong active mod directory, stale cache, quarantine attributes.
- Fix: Standardized active folder path, cache cleanup, and quarantine removal steps.

## 15) Playback/recording status desync around mod connection
- Symptom: Client showed unreachable/stale state while adapter was running.
- Root cause: Weak adapter heartbeat/status interpretation.
- Fix: Added `/status` polling and richer adapter status payload (`record_active`, `replay_active`, etc).

## 16) F10 anchor mismatch (playback not aligned with first gameplay click)
- Symptom: Playback clicked at wrong phase relative to level start.
- Root cause: Playback timeline started from profile zero, not first actionable anchor.
- Fix: Added runtime lead-in normalization and shifted playback timeline to the first press anchor.

## 17) Geode event conversion created invalid macro edges
- Symptom: Random jumps/releases and malformed replay sequence.
- Root cause: Edge reconstruction inserted synthetic pairs that duplicated/conflicted with raw Geode events.
- Fix: Preserved source edge semantics and deduped invalid consecutive states in conversion.

## 18) Auto-record started unexpectedly after death/respawn
- Symptom: Replay stopped, then app switched to record without `F9`.
- Root cause: Stale `record_armed`/`takeover_armed` survived replay stop/level transition.
- Fix: Cleared arming flags on replay stop, replay end, death/reset transitions, and level complete paths.

## 19) Replay did not stop on death
- Symptom: Playback continued after death/respawn.
- Root cause: No hard stop tied to player death state.
- Fix: Added death detection (`m_isDead`) and immediate replay stop/disarm in update loop.

## 20) Pause during playback switched state incorrectly
- Symptom: Pausing could flip playback flow into recording behavior.
- Root cause: Input/arming logic still processed while paused.
- Fix: Blocked arming during pause and froze replay clock/dispatch while paused; resume continues correctly on unpause.

## 21) Takeover merge had long silent gap (5-13s) or skipped takeover segment
- Symptom: Merged macro played initial segment, then long dead zone, then late/manual segment (or no visible takeover segment).
- Root cause:
  - Merge anchor sometimes used absolute game clock instead of replay-relative elapsed time.
  - Boundary trigger edge could be dropped in takeover transition.
  - Out-of-range anchor values could produce impossible stitch points.
- Fix:
  - Stored takeover anchor as replay-relative elapsed (`game - replayStart`) at takeover moment.
  - Captured takeover trigger edge explicitly by seeding per-button state.
  - Returned/used `snapshot.start_ms` consistently.
  - Clamped takeover anchor in adapter to replay range and in client to base profile duration before merge.
 
## 22) Git push blocked by large backup artifact
- Symptom: GitHub pre-receive hook rejected push (>100MB file).
- Root cause: Game backup artifacts were tracked in repo history/worktree.
- Fix: Removed backup artifacts from tracked state and ensured `gd backup/` is ignored.

