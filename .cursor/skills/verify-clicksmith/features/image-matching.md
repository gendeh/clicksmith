# Image matching

SmartClick sends a template patch and a search image to the Flask image-service. A match returns coordinates and confidence.

## Sub-features

- `match-health` answers `/health`.
- `match-template` finds a bright square on a dark field above threshold 0.6.
- `match-missing` rejects a request with no images.

## How to get to it (user POV)

- Enable `SmartClick matching` in Settings, then Play a profile that has `img_patch_b64` on events.
- Direct HTTP `/match` is the observable contract agents can prove without capturing the screen.

## Driving it with control-clicksmith

Preconditions:

- Lane `api` doctor includes image-service.
- Python deps from `image-service/requirements.txt` are installed.

- **Health.** GET `<image>/health`. `service` is `image-service`.
- **Match.** POST `<image>/match` with `template` and `searchArea` as base64 PNGs, `threshold` 0.6, `method` `template`. Status 200, `success` true, `bestMatch.confidence` >= 0.6.
- **Missing payload.** POST `{}`. Status 400.
- **Proof.** Save the successful JSON to `artifacts/image-matching/match.json`.

A fixture generator lives in `image-service/tests/test_match.py`. Reuse that image construction rather than inventing a weaker fixture.

## Gotchas

- `opencv-python-headless` is required. A GUI OpenCV wheel is the wrong package for Cloud Agents.
- Hybrid/feature matching can return a different point than template matching. Assert `success` and confidence, not exact pixels, unless the test built the pixels.
- Client playback talking to a down image-service falls back to positional clicks. That fallback is not a match proof.
