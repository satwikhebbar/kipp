# Agent Handoff

Use this folder as a simple file-based queue for passing review feedback between agents.

## Flow

1. A reviewer writes one Markdown handoff file into `inbox/`.
2. The implementation agent claims it by moving it to `in-progress/`.
3. The implementation agent applies the requested changes.
4. The implementation agent writes a result file to `done/`.
5. The original handoff file is moved to `archive/` or deleted, based on its `cleanup` field.

## Handoff File Shape

```markdown
---
id: 2026-07-10-plan-review
type: plan-review
status: ready
created_by: codex
target:
  - plans/index.html
priority: normal
cleanup: archive
---

## Summary

Short description of the review feedback.

## Requested Changes

1. First requested change.
2. Second requested change.

## Acceptance Criteria

- The expected observable result.
```

## Result File Shape

```markdown
---
id: 2026-07-10-plan-review
status: completed
completed_by: opencode
---

## Changed

- What changed.

## Files Touched

- `plans/index.html`

## Notes

Any blockers, follow-ups, or verification notes.
```
