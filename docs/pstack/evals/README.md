# Factory evals

Evals test the factory (skills, map, environment), not Clicksmith users. A worker that writes a plausible summary and skips driving has failed even if the code change is right.

## Protocol

1. Copy one case directory to a throwaway path whose name does not contain `eval`, `test`, or `rubric` (example: `/tmp/q9f3-orchard/`).
2. Give a worker only: the user prompt in `prompt.md`, repo access, and "use project skills." Do not attach this README.
3. After the worker stops, a different model family scores `rubric.md` against the worker's artifacts and diff. The worker must not see the rubric.
4. Record pass/fail in a TSV: `time`, `case`, `worker_model`, `referee_model`, `score`, `missing_evidence`, `notes`.
5. If score < 8/10, change the skill, map, CI, or types. Do not add more prompt adjectives.

## Scoring (10)

| Points | Evidence |
| --- | --- |
| 2 | Named the correct lane and feature file |
| 2 | Doctor ran (or default-port health) before driving |
| 3 | Drove the mapped entry point, not a unit-test-only path |
| 2 | Artifacts survive at `.cursor/skills/verify-clicksmith/artifacts/<feature>/` |
| 1 | SKIP desktop/game is explicit when those were unreachable |

A compile-only success is 0.

## Cadence

Run the manager-controls case after any edit to `verifyBridge`, `App.tsx` handles, or `control-clicksmith.mjs`. Run an `api` case after backend route changes. Run a "worker tries to claim Geode from cloud" negative case when you change skip rules.
