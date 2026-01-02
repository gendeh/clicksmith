# Developer Handoff

## Commands to Run Locally

### 1. Install Dependencies
Run these commands in order:
```bash
# Root
npm install

# Client
cd client
npm install

# Backend
cd ../backend
npm install

# Image Service (Python)
cd ../image-service
pip install -r requirements.txt
```

### 2. Start Development Environment
You can start all services concurrently from the root directory:
```bash
npm run dev
```

Or start them individually:
- **Client**: `cd client && npm run dev`
- **Backend**: `cd backend && npm run dev`
- **Image Service**: `cd image-service && python app/main.py`

### 3. Build & Package (Windows)
To produce the Windows installer (`.exe`):

1.  Build the client application:
    ```bash
    cd client
    npm run build
    npm run package
    ```
    This creates a packaged Electron app in `client/release/win-unpacked`.

2.  Generate the installer using NSIS (ensure NSIS is installed):
    ```bash
    cd installer
    makensis clicksmith.nsi
    ```
    This will produce `ClicksmithInstaller.exe`.

### 4. Overwolf Build (Optional)
The Overwolf client lives in `overwolf/`. Import the folder into the Overwolf developer console and update `manifest.json` hotkey bindings as needed.

## Architecture Notes

- **Client**: Uses Electron + React. `src/main` contains the Node.js backend for the desktop app (recording/playback engine), while `src/renderer` contains the UI.
- **Input Capture**: Uses `uiohook-napi` for global input hooks and `robotjs` for playback. On Windows you can swap in a Win32-specific hook module.
- **Image Matching**: The client communicates with the Python `image-service` via HTTP. In a production build, you might want to bundle this service or rewrite the critical path in C++ (OpenCV) directly within Electron for lower latency.
- **Backend**: Standard Express app. Uses Firebase Admin SDK. Requires `FIREBASE_SERVICE_ACCOUNT` env var for full functionality.

## Next Steps

1.  **Windows Input Hooks**: Validate `uiohook-napi` and `robotjs` on Windows; consider swapping in raw input hooks for more stability.
2.  **Stripe Integration**: Add live keys and webhook secrets in production.
3.  **Firebase**: Add your `serviceAccount.json` content to the `.env` file for the backend.
