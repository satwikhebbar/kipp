---
name: review-handoff
description: >
  Process file-based review handoffs from .agent-handoff/inbox/. Moves handoffs
  through an inbox → in-progress → done/archive pipeline. Reads YAML frontmatter
  for id, target files, requested changes, and acceptance criteria. Writes result
  files to done/ after applying changes.
license: MIT
---

# Agent Handoff

This repo uses `.agent-handoff/` as a file-based queue for review feedback between agents.

## Folder Layout

| Path | Purpose |
|------|---------|
| `.agent-handoff/inbox/` | New handoff files waiting to be processed |
| `.agent-handoff/in-progress/` | Files claimed by the implementation agent |
| `.agent-handoff/done/` | Result files written after work is applied |
| `.agent-handoff/archive/` | Processed original handoff files kept for audit history |

Queue contents are gitignored, except `.gitkeep` files and `.agent-handoff/README.md`.

## Processing Flow

1. Look for Markdown files in `.agent-handoff/inbox/`.
2. Claim one by moving it to `.agent-handoff/in-progress/`.
3. Read the YAML frontmatter and requested changes.
4. Apply the requested changes to the target files.
5. Verify the acceptance criteria.
6. Write a result file to `.agent-handoff/done/`.
7. Move the original handoff to `.agent-handoff/archive/`, unless its `cleanup` field says `delete`.

Do **not** process a handoff in `inbox/` whose `id` field duplicates a file already in `in-progress/`, `done/`, or `archive/` — it's a retry or duplicate.

## Handoff Shape

```markdown
---
id: <unique-id>
type: <plan-review|code-review|etc>
status: ready
created_by: codex
target:
  - <file-path>
priority: normal|high
cleanup: archive|delete
---

## Summary

Short review outcome.

## Requested Changes

1. Concrete requested change.
2. Another requested change.

## Acceptance Criteria

- Observable condition that proves the change was made.
```

## Result Shape

```markdown
---
id: <same-as-handoff-id>
status: completed|blocked|failed
completed_by: opencode
---

## Changed

- What changed.

## Files Touched

- `path/to/file`

## Verification

- What was checked.

## Notes

Blockers, follow-ups, or anything left unresolved.
```

## Behavior Rules

- Process one handoff at a time per session.
- Treat `Requested Changes` as the work queue.
- Treat `Acceptance Criteria` as the definition of done.
- Preserve unrelated user changes — only touch files listed in `target`.
- If blocked or acceptance criteria can't be met, write a `done/` result with `status: blocked` and explain why in `Notes`.
- Archive or delete the original handoff according to `cleanup` field.
- Write the result file to `done/` before moving/archiving the original.
