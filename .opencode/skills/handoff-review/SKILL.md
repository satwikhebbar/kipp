---
name: handoff-review
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
| `.agent-handoff/done/` | Result files written after work is applied, optionally with a sibling `.response.md` |
| `.agent-handoff/archive/` | Processed original handoff files kept for audit history |

Queue contents are gitignored, except `.gitkeep` files and `.agent-handoff/README.md`.

## Processing Flow

1. Look for Markdown files in `.agent-handoff/inbox/`.
2. Claim one by moving it to `.agent-handoff/in-progress/`.
3. Read the YAML frontmatter and requested changes.
4. Apply the requested changes to the target files.
5. Verify the acceptance criteria.
6. Write a result file to `.agent-handoff/done/`.
7. Optionally write a **response sidecar** (see Response Shape below) to communicate back to the reviewer.
8. Move the original handoff to `.agent-handoff/archive/`, unless its `cleanup` field says `delete`. If a response sidecar was written, move it alongside the original.

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

## Response Shape

An optional sidecar file written alongside the result when Opencode needs to communicate back to the reviewer (Codex). Named after the original handoff id: `YYYY-MM-DD-short-topic.response.md`.

```markdown
---
id: YYYY-MM-DD-short-topic-response
type: implementation-response
status: done
created_by: opencode
responds_to: YYYY-MM-DD-short-topic
target:
  - path/or/topic
cleanup: archive|delete   # matches the original handoff's cleanup value
---

## Summary

Short note on what changed.

## Changes Made

- Concrete change.

## Not Done

- Anything intentionally skipped, with reason.

## Verification

- Commands or checks run.

## Questions For Codex

- Optional follow-up questions or areas to re-review.
```

Codex reads response files when `responds_to` or `target` overlaps with its current review scope.

## Behavior Rules

- Handoff files in `.agent-handoff/*/` are gitignored. Use `bash find` or direct file paths — glob tools respect `.gitignore` and will not find them.
- Process one handoff at a time per session.
- Treat `Requested Changes` as the work queue.
- Treat `Acceptance Criteria` as the definition of done.
- Preserve unrelated user changes — only touch files listed in `target`.
- If blocked or acceptance criteria can't be met, write a `done/` result with `status: blocked` and explain why in `Notes`.
- Archive or delete the original handoff according to `cleanup` field. If a response sidecar exists, treat it with the same `cleanup` value.
- Write the result file to `done/` before moving/archiving the original.
- Write a response sidecar when: changes were intentionally skipped, acceptance criteria weren't fully met, or you have questions for the reviewer. Skip it when the work was straightforward and all criteria were met.
