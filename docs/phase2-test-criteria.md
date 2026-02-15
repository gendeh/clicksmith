# Phase 2 Move-On Test Criteria

This checklist is the gate from Phase 2 (security and trust boundaries) to Phase 3.

## Automated gates (must pass)

1. Build
- `npm run build`
- Pass condition: `client` and `backend` build cleanly.

2. Client tests
- `npm run test:client -- --runInBand`
- Pass condition: all deterministic lifecycle/scheduler tests pass.

3. Backend tests
- `npm run test:backend`
- Pass condition:
- auth middleware rejects invalid bearer format,
- schema validators reject malformed payloads,
- profile ownership enforcement passes.

## Manual gates (must pass)

1. Renderer hardening
- Start app and inspect BrowserWindow settings.
- Pass condition:
- `contextIsolation: true`,
- `nodeIntegration: false`,
- preload bridge is the only renderer access path.

2. IPC payload validation
- Invoke handlers with malformed payloads from devtools/scripts.
- Pass condition:
- malformed payload returns `E_IPC_INVALID_PAYLOAD`,
- no process crash or undefined behavior.

3. Backend route security
- Call protected routes without bearer token.
- Pass condition: HTTP `401`.
- Call profile update/delete with different owner.
- Pass condition: HTTP `403`.

4. Contract discipline
- Verify `docs/openapi/clicksmith-v1.yaml` reflects current v1 routes.
- Verify `client/src/types/apiContract.ts` is updated with v1 request/response types.

## Hard fail conditions (block Phase 3)

1. Renderer can still access Node/Electron directly without preload.
2. Any protected backend route accepts anonymous mutation.
3. Malformed IPC payload causes crash or silent success.
4. Ownership checks can be bypassed in profile update/delete.
