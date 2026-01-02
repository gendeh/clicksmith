# Clicksmith Overwolf Client (Skeleton)

This folder contains the Overwolf overlay build for Clicksmith. It is a Windows-only option that mirrors the Electron client behavior with Overwolf windows and hotkeys.

## What is implemented
- Overlay and main window UI (HTML/CSS)
- Hotkey wiring stubs using `overwolf.settings.hotkeys`
- Placeholder command dispatcher to integrate with a native input hook module

## Next steps
1. Register the app in Overwolf and import this folder into the Overwolf developer console.
2. Replace `sendNativeCommand` in `scripts/app.js` with calls to your native input capture module.
3. Bind the hotkey names in `manifest.json` to Overwolf hotkey settings.

This is intentionally minimal so you can drop in the native module that matches your internal input-capture pipeline.
