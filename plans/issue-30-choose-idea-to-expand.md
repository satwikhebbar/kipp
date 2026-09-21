# Choose Which Raw Idea to Draft Next

> **Status:** Plan for GitHub issue #30 (`Allow choosing which idea to expand to a
> draft next`).
> **Document role:** Design of the change that replaces `/generate`'s forced
> oldest-raw-idea selection with an explicit, author-chosen idea.
> **Scope:** Telegram ingress only. No agent, Notion schema, workflow, or
> production runtime configuration change.

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

`getNextIdea()` has exactly one caller (`telegram-webhook.ts`); the scheduled
cadence (`src/triggers/cadence.ts`) selects its own oldest eligible idea
directly, so the root cause is confined to the `/generate` branch.

## 2. Outcome

When the author sends `/generate`, Kipp replies with the available raw ideas as
inline buttons. Tapping one starts `PipelineWorkflow` for that idea. No draft is
started until the author explicitly picks.

- `/generate` never auto-starts a workflow.
- Every raw idea — `substack`, `telegram`, or `manual` — is offered.
- Tapping a stale button (idea already drafted, or unknown) starts nothing and
  explains why.
- The scheduled cadence is unchanged: it is a timer with no interactive surface.

## 3. Design

### 3.1 `/generate` presents the raw ideas

Replace the `getNextIdea()` call in the `/generate` branch with a raw-idea list
and an inline keyboard:

```ts
if (command?.name === "generate" && !command.argument) {
  logRuntime(env, { event: "linkedin-generation-request", outcome: "started" })
  const manager = createIdeaManager(createNotionClient(env))
  const ideas = await manager.getIdeasByStatuses(["raw"])
  if (ideas.length === 0) {
    await tg.sendMessage(msg.chat.id, "No raw ideas to generate from.")
    return new Response("OK")
  }
  const choices = ideas.slice(-MAX_IDEA_CHOICES).reverse()
  const heading =
    ideas.length > MAX_IDEA_CHOICES
      ? `Choose a raw idea to draft (showing the ${MAX_IDEA_CHOICES} most recent of ${ideas.length}):`
      : "Choose a raw idea to draft:"
  await tg.sendMessage(msg.chat.id, heading, {
    replyMarkup: {
      inline_keyboard: choices.map((idea) => [
        { text: ideaChoiceLabel(idea), callback_data: `${IDEA_CALLBACK_PREFIX}${idea.pageId}` },
      ]),
    },
  })
  logRuntime(env, { event: "linkedin-generation-request", outcome: "succeeded" })
  return new Response("OK")
}
```

This reuses the existing `IdeaManager.getIdeasByStatuses(["raw"])` (already used
by the cadence check) and the existing `sendMessage` `replyMarkup` support. No
new Notion query, filter, or manager method is required.

### 3.2 Selection callback contract

Buttons carry `gen:<pageId>` as `callback_data`. A Notion page id is a 36-char
UUID, so `gen:` + id is ~40 bytes, within Telegram's 64-byte callback limit.

Handle the prefix in the existing `callback_query` branch, after
`answerCallbackQuery` and before `dispatchRoutedInteraction`:

```ts
if (cq.data?.startsWith(IDEA_CALLBACK_PREFIX) && cq.message) {
  await startSelectedIdea(env, tg, cq.message.chat.id, cq.data.slice(IDEA_CALLBACK_PREFIX.length))
  logRuntime(env, { event: "linkedin-generation-request", outcome: "succeeded" })
  return new Response("OK")
}
```

`startSelectedIdea` re-reads the raw set and only starts a workflow when the
tapped page is still `raw`:

```ts
/** Starts PipelineWorkflow for the raw idea chosen from the /generate keyboard. */
async function startSelectedIdea(
  env: Env,
  tg: ReturnType<typeof createTelegramClient>,
  chatId: number,
  pageId: string,
): Promise<void> {
  const manager = createIdeaManager(createNotionClient(env))
  const idea = (await manager.getIdeasByStatuses(["raw"])).find((candidate) => candidate.pageId === pageId)
  if (!idea) {
    await tg.sendMessage(chatId, "That idea is no longer available to draft.")
    return
  }
  const result = await createIdeaIngest(env).start({ pageId: idea.pageId, ideaId: idea.id, source: idea.source })
  const verb = result.alreadyStarted ? "Workflow already running" : "Started workflow"
  const label = idea.title?.trim() || `Idea #${idea.id}`
  await tg.sendMessage(chatId, `${verb} for idea #${idea.id}: ${label}`)
}
```

Why this shape:

- It deliberately does **not** register anything in `InteractionRouterDO`. That
  router routes callbacks to an existing workflow instance; no instance exists
  before selection. A direct `gen:` prefix is the smaller path.
- `getIdeasByStatuses(["raw"])` doubles as the stale guard, so a double-tap after
  the workflow flips the idea to `drafted` cannot start a second workflow. The
  `IdeaIngestDO` claim (`claim:{pageId}`) already makes near-simultaneous
  double-taps idempotent and reports `alreadyStarted`.
- Authorization is unchanged: `verifyUser` runs at the top of the
  `callback_query` branch before any `gen:` handling.
- Boundary failures (Notion errors) already flow through the branch's
  `catch` → `handleBoundaryError`, which notifies the chat with safe wording.

### 3.3 Bounds and labels

Telegram caps a message at 4,096 characters and an inline keyboard at 100
buttons. Add two module constants and one label helper:

```ts
const IDEA_CALLBACK_PREFIX = "gen:"
const MAX_IDEA_CHOICES = 20
const IDEA_CHOICE_LABEL_MAX = 48

/** Builds a bounded inline-button label that identifies one raw idea. */
function ideaChoiceLabel(idea: IdeaSummary): string {
  const title = idea.title?.trim()
  const label = title ? `#${idea.id} ${title}` : `#${idea.id} Untitled`
  return label.length > IDEA_CHOICE_LABEL_MAX ? `${label.slice(0, IDEA_CHOICE_LABEL_MAX - 1)}…` : label
}
```

The heading text carries the truncation note so the author knows older ideas are
not shown. The full title remains available in Notion.

### 3.4 Unchanged behavior

- Scheduled cadence (`handleCadenceCron`) still selects the oldest non-Substack
  raw idea; it is a timer, not a conversation.
- `/add`, RSS ingestion, the LinkedIn workflow, `IdeaIngestDO`, the interaction
  router, and the Notion schema are untouched.
- `/generate <argument>` still falls through to the unknown-command reply, as
  today. A text-based picker is out of scope (see §6).

## 4. File-level change list

| File | Change |
| --- | --- |
| `src/triggers/telegram-webhook.ts` | Replace the `getNextIdea()` auto-start with the raw-idea chooser; add the `gen:` callback branch; add `IDEA_CALLBACK_PREFIX`, `MAX_IDEA_CHOICES`, `IDEA_CHOICE_LABEL_MAX`, `ideaChoiceLabel`, and `startSelectedIdea` (all with JSDoc per `tools/require-jsdoc.mjs`); import `IdeaSummary` from `../core/types`. |
| `src/__tests__/telegram.test.ts` | Update the `/generate` test to assert a chooser message (keyboard, no workflow start); add cases for callback selection, stale/unknown selection, disallowed callback user, and the choice cap. |
| `src/__integration__/telegram-to-backlog.integration.test.ts` | Rewrite the `/generate` tests around the chooser + callback round-trip; add a Substack-source selection case. |
| `README.md` | Telegram command table: `/generate` now lists raw ideas to choose from. |
| `docs/architecture/request-flows.md` | LinkedIn flow: `/generate` lists raw ideas and the selection callback starts the workflow. |

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

1. `/generate` with one or more raw ideas sends a message with an inline
   keyboard whose buttons are `gen:<pageId>` and whose labels contain each Kipp
   ID; no `PIPELINE_WORKFLOW` instance is created.
2. `/generate` with no raw ideas still replies `No raw ideas to generate from.`
   and starts nothing.
3. A `callback_query` with `data: "gen:<pageId>"` for a raw page starts exactly
   one workflow with that page's `pageId`, `ideaId`, and `source`, and replies
   `Started workflow for idea #<id>: <title>`.
4. A `gen:` callback for a page that is no longer `raw`, or for an unknown page,
   starts nothing and replies `That idea is no longer available to draft.`
5. A `gen:` callback from a user failing `verifyUser` returns HTTP 403 and sends
   nothing.
6. With more than `MAX_IDEA_CHOICES` raw ideas, only the newest `MAX_IDEA_CHOICES`
   are offered and the heading states how many were omitted.
7. Choosing a `substack`-sourced raw idea starts it (Substack ideas stay
   manual-only but become individually selectable).
8. Existing routed callbacks (Approve / Revise) and the Notion-failure and
   unauthorized-user `/generate` tests continue to pass.

## 6. Out of scope

- Text-based selection (`/generate <id>` or a `/ideas` command). Inline buttons
  cover the requirement; a text fallback can be added later if buttons prove
  awkward.
- Pagination of the raw-idea list beyond the newest 20.
- Changing scheduled cadence to ask for a choice instead of auto-selecting.
- Showing idea bodies or Substack source URLs in the chooser.
- Any agent-prompt, Notion-property, workflow-step, or deployment-config change.

## 7. Open questions for review

1. **Cap and ordering.** The plan offers the 20 newest raw ideas, newest first.
   This keeps the message and keyboard well inside Telegram limits and favors
   "what I feel like publishing today." Alternative: no cap (message length can
   exceed 4,096 characters as raw ideas accumulate) or a `/ideas` paginator.
2. **Callback data exposes the Notion page id.** Notion page ids are not secrets
   and the callback is user-gated, so `gen:<pageId>` is accepted. An opaque
   token would require registering a workflow-less interaction in
   `InteractionRouterDO`, which the plan avoids.
3. **Cadence behavior.** The plan leaves the scheduled cadence auto-selecting the
   oldest non-Substack idea. If the owner wants the timer to stop drafting
   without a human choice, that is a separate, behavior-changing issue.

## 8. Acceptance criteria

- [ ] `/generate` lists raw ideas and starts no workflow until the author taps
      one.
- [ ] Tapping a raw idea starts `PipelineWorkflow` for exactly that idea and
      reports the started/already-running state.
- [ ] Stale, unknown, or unauthorized selections start nothing and are handled
      safely.
- [ ] `substack`, `telegram`, and `manual` raw ideas are all selectable.
- [ ] Scheduled cadence, RSS ingestion, `/add`, and the drafting workflow are
      unchanged.
- [ ] Targeted tests and `pnpm check` pass.
