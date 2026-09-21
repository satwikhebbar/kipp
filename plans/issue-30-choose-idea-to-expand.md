# Choose Which Raw Idea to Draft Next

> **Status:** Revised plan for GitHub issue #30 (`Allow choosing which idea to
> expand to a draft next`).
> **Document role:** Design of the change that makes `/generate`'s idea
> selection optional: keep the existing default (oldest raw idea) and add an
> optional explicit idea id.
> **Scope:** Telegram ingress only. No agent, Notion schema, workflow, or
> production runtime configuration change.
> **Revision note:** Supersedes two earlier designs. The first proposed an
> inline-keyboard chooser. The second made the idea id **required** and dropped
> the default auto-selection; that was wrong — it broke the existing
> `/generate` flow that users rely on. This revision keeps the old default
> intact and layers explicit selection on top as an optional argument. It also
> preserves the old body-excerpt label for the default path; only the
> explicit-id path falls back to `"Untitled"`.

## 1. Problem

`/generate` (Telegram, no argument) hard-codes serial selection. In
`src/triggers/telegram-webhook.ts` it calls `manager.getNextIdea()`, which
returns the lowest-Kipp-ID page whose status is `raw`:

```ts
const idea = await manager.getNextIdea()
if (!idea) { /* "No raw ideas to generate from." */ }
const result = await ingest.start({ pageId: idea.pageId, ideaId: idea.id, source: idea.source })
```

The author cannot say "draft this one today." Substack runs can add up to five
raw ideas per post, so the queue grows and `/generate` keeps pulling the oldest
one regardless of what the author actually wants to publish.

`getNextIdea()` has exactly one production caller (`telegram-webhook.ts`); the
scheduled cadence (`src/triggers/cadence.ts`) selects its own oldest
non-Substack raw idea directly, so the change is confined to the `/generate`
branch.

The previous implementation iteration made `/generate <idea id>` mandatory.
That is a regression for anyone who just wants "the next one" and is being
reverted: the default must remain valid.

## 2. Outcome

`/generate` keeps working exactly as before, and gains an optional idea id:

- `/generate` (no argument) keeps the current behavior: start
  `PipelineWorkflow` for the oldest raw idea, or reply
  `No raw ideas to generate from.` when the raw queue is empty.
- `/generate <idea id>` (for example `/generate 20`) starts `PipelineWorkflow`
  for that specific idea instead of the oldest one.
- When an explicit id does not name a currently-`raw` idea — unknown,
  malformed, or a status other than `raw` (including `awaiting-feedback`) —
  reply `Nothing to generate for that idea.` and start nothing.
- Every raw idea — `substack`, `telegram`, or `manual` — is selectable by id.
- The scheduled cadence is unchanged.

## 3. Design

### 3.1 `/generate [idea id]` — optional id, default preserved

Keep the existing `getNextIdea()` path as the no-argument default and add an id
lookup as the alternative:

```ts
if (command?.name === "generate") {
  logRuntime(env, { event: "linkedin-generation-request", outcome: "started" })
  const manager = createIdeaManager(createNotionClient(env))
  const idea = command.argument
    ? await manager.getIdeaByIdeaId(command.argument)
    : await manager.getNextIdea()
  if (!idea || idea.status !== "raw") {
    await tg.sendMessage(
      msg.chat.id,
      command.argument ? "Nothing to generate for that idea." : "No raw ideas to generate from.",
    )
    return new Response("OK")
  }
  const result = await createIdeaIngest(env).start({ pageId: idea.pageId, ideaId: idea.id, source: idea.source })
  const verb = result.alreadyStarted ? "Workflow already running" : "Started workflow"
  const label = idea.title ?? ("body" in idea ? idea.body.slice(0, LABEL_TRUNCATE_LENGTH) : "Untitled")
  await tg.sendMessage(msg.chat.id, `${verb} for idea #${idea.id}: ${label}`)
  logRuntime(env, { event: "linkedin-generation-request", outcome: "succeeded" })
  return new Response("OK")
}
```

The no-argument default reuses `getNextIdea()`. Explicit selection uses a new
manager method, `getIdeaByIdeaId(ideaId)`, which issues a single Notion query
filtered on the `Kipp ID` `unique_id` property (limit 1) and returns a
metadata-only `IdeaSummary | null` — no markdown body fetch. This replaces the
earlier `getIdeasByStatuses(["raw"])` scan, which loaded every raw idea to find
one; the by-id query stays O(1) as the queue grows. A non-integer argument
short-circuits to `null` without a Notion call. `getNextIdea()` therefore stays
in production use, and its unit tests in `src/__tests__/ideas.test.ts` are
untouched; new `getIdeaByIdeaId` tests are added there.

The `LABEL_TRUNCATE_LENGTH = 80` constant stays in place. The default path
receives a hydrated `Idea` (with `body`) from `getNextIdea()`, so its
missing-title label remains the old `idea.body.slice(0, LABEL_TRUNCATE_LENGTH)`
excerpt; the `"body" in idea` guard narrows the union so the explicit-id path,
which receives a body-less `IdeaSummary`, falls back to `"Untitled"`. This keeps
the existing no-argument message byte-for-byte identical for untitled ideas.

### 3.2 Validation and failure replies

For an explicit id, `getIdeaByIdeaId(id)` plus the `status === "raw"` check is
the validation gate. The id is rejected when:

- no idea has that Kipp id (typo or out-of-range number);
- the argument is not a valid id (for example `/generate abc`); or
- the idea exists but its status is not `raw` — `drafted`,
  `awaiting-feedback`, `awaiting-feedback-expired`, `finalized`, or `skipped`.

All of those cases reply with the same message, `Nothing to generate for that
idea.`, and start nothing.

The no-argument default keeps its existing distinct reply,
`No raw ideas to generate from.`, when there is no raw idea at all. Two
messages is intentional: they describe different situations (an empty queue vs.
a bad/unavailable id). See open question 2.

The `IdeaIngestDO` claim (`claim:{pageId}`) already makes near-simultaneous
double-taps idempotent and reports `alreadyStarted`; a re-issue after the
workflow flips the idea out of `raw` fails the status gate.

### 3.3 Unchanged behavior

- Scheduled cadence (`handleCadenceCron`) still selects the oldest non-Substack
  raw idea; it is a timer, not a conversation.
- `/add`, RSS ingestion, the LinkedIn workflow, `IdeaIngestDO`, the interaction
  router, and the Notion schema are untouched.
- Authorization is unchanged: `verifyUser` still runs at the top of
  `handleMessage` before the `/generate` branch.
- Boundary failures (Notion errors) still flow through the branch's `catch` →
  `handleBoundaryError`, which notifies the chat with safe wording.

## 4. File-level change list

| File | Change |
| --- | --- |
| `src/triggers/telegram-webhook.ts` | Rewrite the `/generate` branch so the argument is optional: no argument falls back to `getNextIdea()` (old behavior); an argument resolves via `getIdeaByIdeaId()`, gated on `status === "raw"`. Keep the empty-queue reply `No raw ideas to generate from.` and the `Nothing to generate for that idea.` reply for a bad/unavailable explicit id. Keep the `LABEL_TRUNCATE_LENGTH` constant and the `"body" in idea` guard so the default path keeps the old body-excerpt label while the explicit-id path falls back to `"Untitled"`. Update the two unknown-command hint strings to advertise the optional id. |
| `src/linkedin/ideas/manager.ts` | Add `getIdeaByIdeaId(ideaId): Promise<IdeaSummary \| null>`: reject non-integer input, then a single `queryPages({ property: "Kipp ID", unique_id: { equals: n } }, [], 1)` returning the metadata-only summary. `getNextIdea` is unchanged. |
| `src/__tests__/ideas.test.ts` | Extend the fake `queryPages` to honor a `Kipp ID` `unique_id` filter; add `getIdeaByIdeaId` cases for a hit (summary, no body), a miss, and malformed ids. |
| `src/__tests__/telegram.test.ts` | Restore the default `/generate` (no argument) case and assert it starts the oldest raw idea; add a default no-argument case for an untitled raw idea asserting the body-excerpt label; add a `/generate <id>` case asserting it starts that named idea and issues the `Kipp ID` filter; keep the unknown-id and non-`raw` cases (both `Nothing to generate for that idea.`, no start); keep the empty-queue `No raw ideas to generate from.` case; update the Notion-failure and unauthorized `/generate` payloads. |
| `src/__integration__/setup.ts` | Teach the fake Notion `/query` handler the `Kipp ID` `unique_id` filter. |
| `src/__integration__/telegram-to-backlog.integration.test.ts` | Restore a default no-argument `/generate` case (oldest raw idea), keep the named-id selection case (picks a non-oldest idea), the `substack`-source case, and the non-`raw` rejection case; assert the help hints advertise the optional id. |
| `README.md` | Telegram command table and drafting paragraph: `/generate [idea id]` starts generation for the oldest raw idea, or for the named idea. |
| `docs/architecture/request-flows.md` | LinkedIn flow: `/generate [idea id]` selects the named raw idea, defaulting to the oldest raw idea. |

No change to `src/integrations/notion.ts`, `src/core/idea-ingest.ts`,
`src/triggers/cadence.ts`, `Env`, `config/runtime-variables.json`, or
`wrangler.prod.toml`.

The currently open PR #87 carries the required-id implementation from the
previous iteration. The next implementation iteration revises that code on the
same branch; the plan commit itself is documentation only.

## 5. Verification plan

Targeted suites first:

```bash
pnpm test src/__tests__/telegram.test.ts
pnpm test:integration -- --run src/__integration__/telegram-to-backlog.integration.test.ts
```

Then the full gate `pnpm check` (lint, JSDoc, typecheck, unit tests).

Behavioral assertions:

1. `/generate` with no argument starts exactly one workflow for the oldest raw
   idea with that page's `pageId`, `ideaId`, and `source`, and replies naming
   the idea (default restored).
2. A no-argument `/generate` for an **untitled** raw idea replies with the
   existing body excerpt truncated to `LABEL_TRUNCATE_LENGTH` (80) characters,
   preserving the pre-change message for the default path.
3. `/generate <id>` for a raw idea that is **not** the oldest starts exactly one
   workflow for that idea, proving explicit selection overrides the default.
4. `/generate` with an empty raw queue replies `No raw ideas to generate from.`
   and starts nothing.
5. `/generate 99` (no such idea) replies `Nothing to generate for that idea.`
   and starts nothing.
6. `/generate abc` (malformed) replies `Nothing to generate for that idea.` and
   starts nothing.
7. `/generate <id>` for an idea whose status is `awaiting-feedback` (and, by the
   same path, `drafted` / `finalized` / `skipped`) replies
   `Nothing to generate for that idea.` and starts nothing.
8. A `substack`-sourced raw idea is selectable by id and starts its workflow.
9. The Notion-failure and unauthorized-user `/generate` tests continue to pass.
10. `pnpm check` passes.

## 6. Out of scope

- The inline-keyboard chooser, `gen:` callback contract, and pagination from the
  first superseded revision.
- Making the idea id mandatory, or removing the no-argument default.
- Removing `getNextIdea()` or its unit tests in `src/__tests__/ideas.test.ts`.
- Changing scheduled cadence to ask for a choice instead of auto-selecting.
- Listing ideas (`/ideas`) or accepting a title/source in place of an id.
- Any agent-prompt, Notion-property, workflow-step, or deployment-config change.

## 7. Open questions for review

1. **Help/hint format.** Because the id is optional, the plan advertises
   `/generate [idea id]` in the unknown-command hints, README, and architecture
   doc. Brackets are the common "optional argument" convention but are a small
   style choice; the alternative is leaving the hints as plain `/generate`.
2. **Two failure messages.** An empty raw queue on the default path keeps the
   existing `No raw ideas to generate from.`; a bad/unavailable explicit id gets
   `Nothing to generate for that idea.`. Keeping both preserves current behavior
   and tells the user which situation they hit; a single message is simpler.

### Resolved in this revision

- **Success label fallback.** The default path keeps the exact old label,
  `idea.title ?? idea.body.slice(0, LABEL_TRUNCATE_LENGTH)`, because
  `getNextIdea()` returns a hydrated `Idea`. Only the explicit-id path, which
  works from a body-less `IdeaSummary`, falls back to `"Untitled"`. The
  `"body" in idea` guard selects between them, and a unit test covers an
  untitled default-selected idea so the old behavior stays locked in.

## 8. Acceptance criteria

- [ ] `/generate` with no argument keeps the existing behavior: starts
      `PipelineWorkflow` for the oldest raw idea, or replies
      `No raw ideas to generate from.` when the queue is empty.
- [ ] The no-argument success message is unchanged for untitled ideas: it still
      uses the `idea.body.slice(0, LABEL_TRUNCATE_LENGTH)` excerpt, not
      `"Untitled"`, with a test covering an untitled default-selected idea.
- [ ] `/generate <id>` starts `PipelineWorkflow` for exactly that idea when it
      exists and is `raw`, and reports the started/already-running state.
- [ ] Unknown, malformed, or non-`raw` ids (including `awaiting-feedback`) reply
      `Nothing to generate for that idea.` and start nothing.
- [ ] `substack`, `telegram`, and `manual` raw ideas are all selectable by id.
- [ ] Scheduled cadence, RSS ingestion, `/add`, and the drafting workflow are
      unchanged.
- [ ] Targeted tests and `pnpm check` pass.
