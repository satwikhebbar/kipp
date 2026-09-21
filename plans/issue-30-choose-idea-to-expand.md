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
- When an explicit id cannot be used, the reply names the reason: malformed →
  `Idea id must be a positive whole number.`; unknown → `No idea found with id
  <id>.`; a status other than `raw` (including `awaiting-feedback`) → `Idea #<id>
  is not raw.`. All start nothing.
- Every raw idea — `substack`, `telegram`, or `manual` — is selectable by id.
- The scheduled cadence is unchanged.

## 3. Design

### 3.1 `/generate [idea id]` — optional id, default preserved

Keep the existing `getNextIdea()` path as the no-argument default and add an id
lookup as the alternative:

```ts
if (command?.name === "generate") {
  logRuntime(env, { event: "linkedin-generation-request", outcome: "started" })
  const requestedId = command.argument
  if (requestedId && parseIdeaId(requestedId) === null) {
    await tg.sendMessage(msg.chat.id, "Idea id must be a positive whole number.")
    return new Response("OK")
  }
  const manager = createIdeaManager(createNotionClient(env))
  const idea = requestedId ? await manager.getIdeaByIdeaId(requestedId) : await manager.getNextIdea()
  if (!idea) {
    await tg.sendMessage(
      msg.chat.id,
      requestedId ? `No idea found with id ${requestedId}.` : "No raw ideas to generate from.",
    )
    return new Response("OK")
  }
  if (idea.status !== "raw") {
    await tg.sendMessage(msg.chat.id, `Idea #${idea.id} is not raw.`)
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

The explicit-id path reports its three distinct failure modes with their own
replies, so the user can tell a typo from a missing idea from an idea that is
already in flight:

| Case | Reply |
| --- | --- |
| Id is not a positive integer | `Idea id must be a positive whole number.` |
| Id is a number but no idea exists | `No idea found with id <id>.` |
| Id exists but is not `raw` | `Idea #<id> is not raw.` |

The no-argument default keeps its single empty-queue reply
`No raw ideas to generate from.`.

The no-argument default reuses `getNextIdea()`. Explicit selection uses a new
manager method, `getIdeaByIdeaId(ideaId)`, which issues a single Notion query
filtered on the `Kipp ID` `unique_id` property (limit 1) and returns a
metadata-only `IdeaSummary | null` — no markdown body fetch. This replaces the
earlier `getIdeasByStatuses(["raw"])` scan, which loaded every raw idea to find
one; the by-id query stays O(1) as the queue grows. The integer rule lives in one
exported `parseIdeaId(value)` helper in `manager.ts`; the webhook calls it to
distinguish the malformed-id reply, and `getIdeaByIdeaId` calls it to
short-circuit invalid input to `null` without a Notion call. `getNextIdea()`
therefore stays in production use, and its unit tests in
`src/__tests__/ideas.test.ts` are untouched; new `getIdeaByIdeaId` tests are
added there.

The `LABEL_TRUNCATE_LENGTH = 80` constant stays in place. The default path
receives a hydrated `Idea` (with `body`) from `getNextIdea()`, so its
missing-title label remains the old `idea.body.slice(0, LABEL_TRUNCATE_LENGTH)`
excerpt; the `"body" in idea` guard narrows the union so the explicit-id path,
which receives a body-less `IdeaSummary`, falls back to `"Untitled"`. This keeps
the existing no-argument message byte-for-byte identical for untitled ideas.

### 3.2 Validation and failure replies

For an explicit id, `parseIdeaId(id)`, `getIdeaByIdeaId(id)`, and the
`status === "raw"` check form the validation gate. The id is rejected when:

- the argument is not a valid id (for example `/generate abc` or
  `/generate 1.5`) — reply `Idea id must be a positive whole number.`;
- no idea has that Kipp id (typo or out-of-range number) — reply
  `No idea found with id <id>.`; or
- the idea exists but its status is not `raw` — `drafted`,
  `awaiting-feedback`, `awaiting-feedback-expired`, `finalized`, or `skipped` —
  reply `Idea #<id> is not raw.`.

Each of those cases starts nothing. The three distinct replies are intentional:
they separate a malformed id, a missing idea, and an idea that is already in
flight.

The no-argument default keeps its existing distinct reply,
`No raw ideas to generate from.`, when there is no raw idea at all. See open
question 2.

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
| `src/triggers/telegram-webhook.ts` | Rewrite the `/generate` branch so the argument is optional: no argument falls back to `getNextIdea()` (old behavior); an argument is validated with `parseIdeaId()` and resolved via `getIdeaByIdeaId()`, gated on `status === "raw"`. Keep the empty-queue reply `No raw ideas to generate from.` and add the three explicit-id replies (malformed, unknown, non-`raw`). Keep the `LABEL_TRUNCATE_LENGTH` constant and the `"body" in idea` guard so the default path keeps the old body-excerpt label while the explicit-id path falls back to `"Untitled"`. Update the two unknown-command hint strings to advertise the optional id. |
| `src/linkedin/ideas/manager.ts` | Add exported `parseIdeaId(value): number \| null` (positive-integer rule) and `getIdeaByIdeaId(ideaId): Promise<IdeaSummary \| null>`: reject invalid input via `parseIdeaId`, then a single `queryPages({ property: "Kipp ID", unique_id: { equals: n } }, [], 1)` returning the metadata-only summary. `getNextIdea` is unchanged. |
| `src/__tests__/ideas.test.ts` | Extend the fake `queryPages` to honor a `Kipp ID` `unique_id` filter; add `getIdeaByIdeaId` cases for a hit (summary, no body), a miss, and malformed ids. |
| `src/__tests__/telegram.test.ts` | Restore the default `/generate` (no argument) case and assert it starts the oldest raw idea; add a default no-argument case for an untitled raw idea asserting the body-excerpt label; add a `/generate <id>` case asserting it starts that named idea and issues the `Kipp ID` filter; add the three explicit-id failure cases (non-numeric → `Idea id must be a positive whole number.` with no Notion call, unknown → `No idea found with id 99.`, non-`raw` → `Idea #1 is not raw.`, each starting nothing); keep the empty-queue `No raw ideas to generate from.` case; update the Notion-failure and unauthorized `/generate` payloads. |
| `src/__integration__/setup.ts` | Teach the fake Notion `/query` handler the `Kipp ID` `unique_id` filter. |
| `src/__integration__/telegram-to-backlog.integration.test.ts` | Restore a default no-argument `/generate` case (oldest raw idea), keep the named-id selection case (picks a non-oldest idea), the `substack`-source case, and the non-`raw` rejection case (now `Idea #1 is not raw.`); assert the help hints advertise the optional id. |
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
5. `/generate 99` (no such idea) replies `No idea found with id 99.` and starts
   nothing.
6. `/generate abc` (malformed) replies `Idea id must be a positive whole number.`
   and starts nothing, with no Notion query.
7. `/generate <id>` for an idea whose status is `awaiting-feedback` (and, by the
   same path, `drafted` / `finalized` / `skipped`) replies `Idea #<id> is not
   raw.` and starts nothing.
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
2. **Failure messages.** An empty raw queue on the default path keeps the
   existing `No raw ideas to generate from.`; the explicit path splits into three
   replies — malformed id, missing idea, and non-`raw` idea. Distinct messages
   tell the user which situation they hit; a single message is simpler.

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
- [ ] Malformed, unknown, and non-`raw` ids (including `awaiting-feedback`) each
      reply with their own message and start nothing.
- [ ] `substack`, `telegram`, and `manual` raw ideas are all selectable by id.
- [ ] Scheduled cadence, RSS ingestion, `/add`, and the drafting workflow are
      unchanged.
- [ ] Targeted tests and `pnpm check` pass.
