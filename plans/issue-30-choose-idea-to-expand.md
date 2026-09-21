# Choose Which Raw Idea to Draft Next

> **Status:** Revised plan for GitHub issue #30 (`Allow choosing which idea to
> expand to a draft next`).
> **Document role:** Design of the change that replaces `/generate`'s forced
> oldest-raw-idea selection with an explicit idea id supplied by the author.
> **Scope:** Telegram ingress only. No agent, Notion schema, workflow, or
> production runtime configuration change.
> **Revision note:** Supersedes the inline-keyboard chooser design. The author
> now names the idea directly (`/generate <idea id>`), so no callback contract,
> keyboard, or selection state is needed.

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
scheduled cadence (`src/triggers/cadence.ts`) selects its own oldest eligible
idea directly, so the root cause is confined to the `/generate` branch.

## 2. Outcome

When the author sends `/generate <idea id>` (for example `/generate 20`), Kipp
starts `PipelineWorkflow` for that specific idea, but only when the idea exists
and is still `raw`. No draft is started until the author names an idea.

- `/generate <id>` starts a workflow for exactly that idea, or reports that
  there is nothing to generate.
- `/generate` with no argument replies with usage and starts nothing.
- Any idea that is unavailable — unknown id, malformed id, or a status other
  than `raw` (including `awaiting-feedback`) — gets the same
  nothing-to-generate reply and starts nothing.
- Every raw idea — `substack`, `telegram`, or `manual` — is selectable.
- The scheduled cadence is unchanged: it is a timer with no interactive surface.

## 3. Design

### 3.1 `/generate <idea id>` selects by Kipp id

Replace the `getNextIdea()` call in the `/generate` branch with an id lookup
over the raw set:

```ts
if (command?.name === "generate") {
  logRuntime(env, { event: "linkedin-generation-request", outcome: "started" })
  if (!command.argument) {
    await tg.sendMessage(msg.chat.id, "Usage: /generate <idea id>")
    return new Response("OK")
  }
  const manager = createIdeaManager(createNotionClient(env))
  const idea = (await manager.getIdeasByStatuses(["raw"])).find((candidate) => candidate.id === command.argument)
  if (!idea) {
    await tg.sendMessage(msg.chat.id, "Nothing to generate for that idea.")
    return new Response("OK")
  }
  const result = await createIdeaIngest(env).start({ pageId: idea.pageId, ideaId: idea.id, source: idea.source })
  const verb = result.alreadyStarted ? "Workflow already running" : "Started workflow"
  await tg.sendMessage(msg.chat.id, `${verb} for idea #${idea.id}: ${idea.title ?? "Untitled"}`)
  logRuntime(env, { event: "linkedin-generation-request", outcome: "succeeded" })
  return new Response("OK")
}
```

This reuses the existing `IdeaManager.getIdeasByStatuses(["raw"])` (already used
by the cadence check). No new Notion query, filter, manager method, keyboard, or
callback handling is required.

### 3.2 Validation and the single failure reply

`getIdeasByStatuses(["raw"])` is the only validation gate. The id is not found
in that set when:

- no idea has that Kipp id (typo or out-of-range number);
- the argument is not a valid id (for example `/generate abc`); or
- the idea exists but its status is not `raw` — `drafted`,
  `awaiting-feedback`, `awaiting-feedback-expired`, `finalized`, or `skipped`.

All of those cases reply with the same message, `Nothing to generate for that
idea.`, and start nothing. This matches the requirement that an unavailable
idea — including one awaiting feedback — only needs to tell the user there is
nothing to generate. Missing the argument is a bad invocation rather than an
unavailable idea, so it gets the usage reply instead.

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
| `src/triggers/telegram-webhook.ts` | Rewrite the `/generate` branch to require an idea id, look it up among `getIdeasByStatuses(["raw"])`, and start only on a match; add the usage and nothing-to-generate replies; remove the now-unused `LABEL_TRUNCATE_LENGTH` constant; update the two unknown-command hint strings to say `/generate <idea id>`. No new imports, constants, or helper functions. |
| `src/__tests__/telegram.test.ts` | Update the `/generate` test to send an id and assert the workflow starts for that page; add cases for the missing-argument usage reply, an unknown id, and a non-`raw` (e.g. `awaiting-feedback`) idea, all asserting no workflow start; add the id to the existing Notion-failure `/generate` payloads. |
| `src/__integration__/telegram-to-backlog.integration.test.ts` | Rewrite the `/generate` cases around the id argument; add a `substack`-source selection case and an `awaiting-feedback` rejection case. |
| `README.md` | Telegram command table and drafting paragraph: `/generate <idea id>` starts generation for that raw idea. |
| `docs/architecture/request-flows.md` | LinkedIn flow: `/generate <idea id>` selects a specific raw idea by id. |

No change to `src/linkedin/ideas/manager.ts`, `src/integrations/notion.ts`,
`src/core/idea-ingest.ts`, `src/triggers/cadence.ts`, `Env`,
`config/runtime-variables.json`, or `wrangler.prod.toml`.

## 5. Verification plan

Targeted suites first:

```bash
pnpm test src/__tests__/telegram.test.ts
pnpm test:integration -- --run src/__integration__/telegram-to-backlog.integration.test.ts
```

Then the full gate `pnpm check` (lint, JSDoc, typecheck, unit tests).

Behavioral assertions:

1. `/generate 1` for a raw idea #1 starts exactly one workflow with that page's
   `pageId`, `ideaId`, and `source`, and replies naming the idea.
2. `/generate` with no argument replies `Usage: /generate <idea id>` and starts
   nothing.
3. `/generate 99` (no such idea) replies `Nothing to generate for that idea.`
   and starts nothing.
4. `/generate <id>` for an idea whose status is `awaiting-feedback` (and, by the
   same path, `drafted` / `finalized` / `skipped`) replies
   `Nothing to generate for that idea.` and starts nothing.
5. A non-numeric argument (`/generate abc`) replies
   `Nothing to generate for that idea.` and starts nothing.
6. A `substack`-sourced raw idea is selectable by id and starts its workflow.
7. The Notion-failure and unauthorized-user `/generate` tests continue to pass.
8. `pnpm check` passes.

## 6. Out of scope

- The inline-keyboard chooser, `gen:` callback contract, and pagination from the
  superseded revision.
- Removing the now-unused `getNextIdea()` manager method and its unit tests in
  `src/__tests__/ideas.test.ts`; it stays in place as a tested but
  production-unused helper.
- Changing scheduled cadence to ask for a choice instead of auto-selecting.
- Listing ideas (`/ideas`) or accepting a title/source in place of an id.
- Any agent-prompt, Notion-property, workflow-step, or deployment-config change.

## 7. Open questions for review

1. **Uniform failure reply.** The plan uses one message,
   `Nothing to generate for that idea.`, for unknown, malformed, and non-`raw`
   ids rather than naming the id or explaining the status. Simpler and matches
   the requirement; a more specific reply can be added later.
2. **Missing-argument behavior.** `/generate` with no argument replies with
   usage instead of falling back to the old oldest-raw-idea auto-selection. The
   issue's intent is explicit choice, so the forced serial default is dropped.
3. **`getNextIdea` left in place.** After this change it has no production
   caller. The plan leaves the method and its unit tests untouched to keep the
   diff confined to the Telegram ingress.

## 8. Acceptance criteria

- [ ] `/generate <id>` starts `PipelineWorkflow` for exactly that idea when it
      exists and is `raw`, and reports the started/already-running state.
- [ ] `/generate` with no argument replies with usage and starts nothing.
- [ ] Unknown, malformed, or non-`raw` ids (including `awaiting-feedback`) reply
      `Nothing to generate for that idea.` and start nothing.
- [ ] `substack`, `telegram`, and `manual` raw ideas are all selectable by id.
- [ ] Scheduled cadence, RSS ingestion, `/add`, and the drafting workflow are
      unchanged.
- [ ] Targeted tests and `pnpm check` pass.
