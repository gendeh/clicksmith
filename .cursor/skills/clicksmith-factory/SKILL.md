---
name: clicksmith-factory
description: Repo-local pstack router for Clicksmith. Use when pstack /poteto-mode is missing, when starting any non-trivial Clicksmith task, or when scaling parallel Cloud Agents.
---

# Clicksmith factory

Agents forget. This file is the operating system for this repository when the pstack plugin is not loaded (Cloud Agents often miss it). If `/poteto-mode` is available, use it and still obey the verify skill and feature map in this repo.

## 1. Copy a playbook into the task list

Match the request:

| Request | Playbook |
| --- | --- |
| How does X work / why | Investigation: read code and git history. No edits. |
| Something is wrong | Bug fix: reproduce on the correct lane, then fix, then drive the same path. |
| New user-visible behavior | Feature: name the data shape, implement, drive every mapped entry point. |
| Same behavior, new structure | Refactor: prove before and after with the same driver. |
| Overnight / many PRs | Autopilot: one owner per PR, verify-clicksmith on each head, no human inner loop. |
| Get a PR green / check on PR N | Babysit (`playbooks/babysit.md`). Stops at merge-ready. Does not merge. |
| Land / ship / merge a green PR | Shipping (`playbooks/shipping.md`). Independent verify, then land. |

Keep every step visible. If you skip a step, record why next to it.

## 2. Hard constraints

- Shortest path must be the correct path. If you are about to write a review comment you have written three times, encode it as a lint, CI check, or type instead.
- Renderer vs main process isolation is load-bearing. Cross-imports fail CI.
- No new comments in product code. Types, tests, and `data-testid` handles carry intent.
- Do not block on the user. Launch the verify instance yourself.

## 3. Verification is the done condition

Read `.cursor/skills/verify-clicksmith/SKILL.md`. Done means:

1. Doctor is green for the lane.
2. The feature file's entry points were driven or explicitly skipped.
3. Artifacts exist under `.cursor/skills/verify-clicksmith/artifacts/<feature>/`.
4. Cleanup did not delete those artifacts.

## 4. Parallelism

One Cloud Agent per independent PR, each with its own `CLICKSMITH_VERIFY_DIR` and port base. Do not share a renderer instance across writers. Do not stack conflicting edits on `client/src/main/main.ts` without serializing those PRs.

## 5. Evals

When asked to test the factory, follow `docs/pstack/evals/README.md`. Blind workers. Cross-family referee. Score evidence, not eloquence.
