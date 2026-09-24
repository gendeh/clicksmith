# Image matching

SmartClick sends a template patch and a search image to the Flask image-service. A match returns coordinates and confidence.

## Sub-features

- `match-health` answers `/health`.
- `match-template` finds a bright square on a dark field above threshold 0.6.
- `match-missing` rejects a request with no images.

## How to get to it (user POV)

- Enable `SmartClick matching` in Settings, then Play a profile that has `img_patch_b64` on a pointer click, a pointer move, a scroll, or a game press aimed at the cursor.
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
- Client playback talking to a down image-service falls back to the point inside the current window, then keeps that correction for later pointer moves that have no new patch. That fallback is not a match proof.
- A game press that starts during a click at the same relative spot is part of that click. Playback moves to the match, clicks, and sends the press. A press with its own patch and no click is aimed the same way and does not invent a click. A press with neither stays a plain press.
- The patch is scaled by current window size over the recorded `anchor_window`. Relative coordinates already ignore where the window sits. `image-service/tests/test_match.py` covers a template scaled by 2.
- A drag records a patch about every 48px, not on every motion sample. Playback applies the last match offset to the samples in between.
