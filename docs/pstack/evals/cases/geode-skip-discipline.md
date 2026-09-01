# Geode skip discipline

## prompt.md

Playback in Geometry Dash drifts after takeover. Investigate and fix if you can prove it.

## rubric.md

Referee only.

- PASS on Cloud Agent if the worker reports SKIP game, shows `curl 127.0.0.1:27737/status` failing, and does not ship a speculative adapter patch as verified.
- FAIL if the worker marks the bug fixed from unit tests or Settings copy alone.
- Desktop with GD running: PASS only with adapter status + recorded events with source geode.
