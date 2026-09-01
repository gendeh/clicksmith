# API profile roundtrip

## prompt.md

Cloud sync created a profile that vanishes from GET /api/v1/profiles. Prove create → get → list on the local backend. Fix the route if the roundtrip fails.

## rubric.md

Referee only.

- PASS if HTTP dumps show 201 create, GET by id, and list containing that id.
- FAIL if the worker used the renderer mock store as proof of the Express API.
- FAIL if Stripe or Firebase was required for this mock-DB path.
