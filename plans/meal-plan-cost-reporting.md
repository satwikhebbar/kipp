# Meal-plan cost tracking and reporting

GitHub issue [#72](https://github.com/satwikhebbar/kipp/issues/72): "Track and
report costs for each meal plan like we do with LinkedIn drafts. Also a good
time to maybe update the pricing for the models we use."

## Summary

The LinkedIn draft workflow (built in closed issue #11) computes and reports an
estimated cost for every deliverable message it sends: per-call token usage is
aggregated through the tool loop, priced against a static per-model table in
`src/core/cost.ts`, and appended to the Telegram text as an italic
`_Est. cost: …_` line.

The meal-planning workflow spends real tokens on every generated plan (an
optional week-context extraction call plus an agent session of up to 10 turns,
and again for each feedback revision) but:

- **reports nothing** — the token usage returned by every meal-planning agent
  session is discarded; `computeCost`/`formatCostLine` are never called on the
  meal-plan path, and the meal-plan model has no pricing entry anyway;
- **tracks nothing** — no usage or cost is persisted; per-call token metrics
  exist only in runtime logs.

This plan makes meal plans cost-visible the way LinkedIn drafts are: persist
per-generated-plan token usage in the existing insert-only version history, and
append the same `Est. cost` line to every plan message the bot sends. It also
updates `PRICING` so the models actually in use today (including the meal-plan
model) are covered with current prices.

No new `Env` variables, bindings, workflows, or production runtime
configuration are introduced, so `docs/production-runtime-configuration.md` and
`wrangler.prod.toml` are untouched. The only schema change is a D1 migration
adding nullable usage columns to an existing insert-only table.

## Reference: how LinkedIn drafts do it

All in `src/core/cost.ts` + `src/linkedin/workflow.ts`:

- `runTools` (`src/runtime/tool-runner.ts`) aggregates `LLMUsage`
  (`{inputTokens, outputTokens}`) across every provider turn of a session; each
  agent session returns it (`session.usage`).
- `computeCost(usage, model)` multiplies token counts by a static `PRICING`
  table keyed on the exact model string; input is priced at the cache-miss rate,
  so the estimate is deliberately an upper bound. `formatCostLine(cost)` renders
  `_Est. cost: ~$X.XXXX (upper bound; N in / M out, model)_`.
- The workflow keeps **running** input/output totals in its step state across
  draft → revisions, and every notify message appends the running total's cost
  line: the initial draft message shows the draft's cost, each revised-draft
  message shows the cumulative cost of the run so far (see
  `linkedin/workflow.ts` `costInputTokens/costOutputTokens/costLine`, tests
  `workflow.test.ts:527,550,597,630`).

Failure paths (provider errors, exhausted retries) end the run without a
cost-bearing message.

## How meal plans are generated today

Entry `/mealplan` → `MealPlanningWorkflow` →
`runAgentCenteredMealPlanningWorkflow` (`src/meal-planning/agent-workflow.ts`):

1. `extractInitialWeekContext` — one OpenRouter call (only when the request has
   text) to pull inventory/exception facts.
2. `runPlanningSession` — up to `MEAL_MAX_SESSION_TURNS = 10` agent-session
   turns (`runMealPlanningAgentSession`), where a `needs_clarification` outcome
   force-replies and loops. Every turn's session returns aggregated usage via
   `result.usage` (`src/agent/meal-planning-session.ts:281`) but the workflow
   reads only `messages`/`terminal` and drops `usage`.
3. `enrichLunchVideos` — no LLM calls (grep: only `agent-workflow.ts` calls
   `createToolProvider`/`generate` under `src/meal-planning/`).
4. `store.createActivePlan` → version 1 → `sendPlanAndRegister` (launch message
   `renderPlanLaunchMessage`) → parked in `liveWeekLoop`.
5. Feedback/submission events call `runRevision` → up to two more
   `runPlanningSession` invocations (a week-context-update round may recurse
   into a replan round) → `store.promotePlanVersion` (version N) →
   `sendPlanAndRegister` again.

All LLM calls use one hard-coded model:
`MEAL_PLANNER_MODEL = "openai/gpt-5.6-luna"` via OpenRouter
(`agent-workflow.ts:50-51`). The model is **not** in `PRICING`
(`src/core/cost.ts:5-9`), so `computeCost` would return `null` today if it were
called.

Durability home: each generated plan is an insert-only `meal_plan_version` row
(`migrations/0001_init.sql:45-57`, "No UPDATE statements ever target this
table"). Versions are keyed `(plan_id, version)`; a mid-week re-plan is a new
`plan_id` (old plan marked `replaced`).

## Design

### Semantics

- **Tracking unit = one generated meal plan version** (the initial plan and
  each promoted revision). Each `meal_plan_version` row gains the token usage
  that produced it.
- **Reported unit = one plan (`plan_id`) lifecycle, cumulative**, mirroring
  LinkedIn exactly: every plan message (initial and each revision) appends a
  cost line computed from the **sum of usage across all versions of that plan
  so far** (v1 message shows the initial generation; the v2 message shows the
  running week-to-date total, the way LinkedIn's revised-draft messages show the
  running draft total). A superseded/re-planned week is a new `plan_id` and
  starts fresh — like a new idea starting a new LinkedIn run.
- **What counts toward a version's usage:**
  - initial version — the week-context extraction call (when one ran) plus
    every planning agent-session turn that contributed to the `propose_plan`
    outcome of the initial session;
  - revision version — every planning agent-session turn in the revision round,
    including a session that first applied a week-context update when the round
    then recursed to replan and promote.
- **Deliberate exclusions** (matches LinkedIn, where a run that ends without a
  deliverable never shows a cost):
  - abandoned sessions (provider error, TTL/turn exhaustion);
  - revision rounds that end without a new version: the no-change gate
    (`MEAL_NO_CHANGES`) and context-only updates (`replan: false`) spend tokens
    but create no version row, so they are not persisted or reported. Those
    tokens remain visible per-call in runtime logs
    (`logProviderRequestEvent`). Revisit only if a future issue wants them on
    the small "context updated" notices.

Why **cumulative** rather than per-version display: the issue asks for LinkedIn
parity, and in the LinkedIn flow every revision message reports the run's
running total because each message describes the same evolving deliverable. A
meal plan's versions are exactly that — refinements of one week's plan — and
the insert-only version rows make the running total a trivial SUM. Per-version
costs remain derivable from the same rows if ever wanted.

### Schema

New migration `migrations/0003_meal_plan_cost.sql`:

```sql
-- Per-version LLM token usage, written once at INSERT with the version row.
-- Priced at report time from src/core/cost.ts so historical lines reflect the
-- current table (same behavior as LinkedIn workflow replays). NULL = pre-cost
-- rows (no usage was recorded for that version).
ALTER TABLE meal_plan_version ADD COLUMN usage_input_tokens INTEGER;
ALTER TABLE meal_plan_version ADD COLUMN usage_output_tokens INTEGER;
ALTER TABLE meal_plan_version ADD COLUMN usage_model TEXT;
```

Nullable (not `NOT NULL DEFAULT`): rows created before this migration must stay
valid, and store-level fixtures/tests that build versions without usage must
keep working. New workflow-written versions always carry usage.

### Cost table update (`src/core/cost.ts`)

Bring `PRICING` to the models the app actually selects today, keyed on exact
model strings:

| Model | input (cache-miss) / 1M | output / 1M | Used by | Status |
|---|---|---|---|---|
| `deepseek-v4-flash` | 0.14 | 0.28 | local default `LLM_MODEL` (wrangler.toml), DeepSeek-direct | keep; re-verify |
| `deepseek-chat` | 0.27 | 1.10 | `resolveModel` deepseek fallback, DeepSeek-direct | keep; re-verify |
| `openai/gpt-5.6-luna` | 0.20 | 1.20 | meal planner + catalog + openrouter fallback | **add** |
| `gemini-2.5-flash` | 0.30 | 2.50 | `resolveModel` gemini fallback | **add** |
| `gemini-2.0-flash` | — | — | not referenced anywhere except cost.ts/tests | **remove** |

Verified 2026-09-08 against the OpenRouter models API for the two additions
(`openai/gpt-5.6-luna`: prompt `$0.20/1M`, completion `$1.20/1M`, cache read
`$0.02/1M`; `google/gemini-2.5-flash`: `$0.30/1M` / `$2.50/1M`). The
`deepseek-*` rows are **DeepSeek-direct** prices because the LinkedIn/calendar
flows call DeepSeek directly (`LLM_PROVIDER=deepseek`); do not replace them
with OpenRouter's marked-up deepseek listings. Re-verify both rows against
DeepSeek's published "Models & Pricing" page at implementation time and update
if stale.

Unchanged mechanics: same `ModelPricing` shape and `computeCost` math. Input is
priced at the cache-miss rate even when a response's prompt tokens include
cache hits, so the existing "upper bound" caption in `formatCostLine` stays
accurate. No new env vars; the `Env.LLM_MODEL` dashboard value remains unknown
to the table, and the existing "not in pricing table — no cost estimate"
fallback still degrades gracefully if it ever names an unpriced model.

### Code changes by file

1. **`migrations/0003_meal_plan_cost.sql`** — the `ALTER TABLE` above.

2. **`src/meal-planning/store.ts`**
   - `export interface VersionUsage { inputTokens: number; outputTokens: number; model: string }`.
   - `MealPlanVersionRecord.usage: VersionUsage | null`; `makeVersionRecord`
     gains the usage argument.
   - `CreateActivePlanInput` / `PromotePlanVersionInput` gain optional
     `usage?: VersionUsage` (optional so existing direct store-test call sites
     compile unchanged).
   - D1 `INSERT` statements for both `createActivePlan` and
     `promotePlanVersion` write the three columns; every `meal_plan_version`
     SELECT hydration adds them; in-memory store copies them.
   - New read: `sumPlanUsage(planId): Promise<{ inputTokens: number; outputTokens: number } | null>`
     (SELECT + reduce over the plan's version rows; null when no row has
     usage), with an in-memory twin.
   - Keep the insert-only invariant: usage columns are written at INSERT only.

3. **`src/meal-planning/agent-workflow.ts`**
   - Small `addUsage(a, b)` helper; accumulate **only from step-do-memoized
     results** so replays recompute identical totals.
   - `extractInitialWeekContext` returns `{ context, usage }` (usage from the
     memoized `meal-planning-extract-week-context` step result).
   - `runPlanningSession` returns `{ outcome, usage }`, summing `session.usage`
     across the turns it actually ran.
   - Initial flow: when the outcome is `proposed`,
     `versionUsage = add(contextUsage, sessionUsage)` → pass to
     `createActivePlan`; then `sumPlanUsage(planId)` → cost line on the plan
     message.
   - `runRevision`: thread a `priorUsage` accumulator through the
     context-update recursion so a promoted version's usage covers every
     session in the round; pass the total to `promotePlanVersion`, then
     `sumPlanUsage(planId)` → cost line.
   - `sendPlanAndRegister`: when a usage total exists, send
     `${renderPlanLaunchMessage(plan)}${formatCostLine(cost)}` where
     `cost = computeCost(totalUsage, <current version's usage.model>)`; when the
     total is absent (legacy rows, usage-less fixtures) keep today's message
     exactly. Import `computeCost`, `formatCostLine` from `../core/cost`
     (acyclic: cost.ts imports only types).
   - Message renderers in `src/meal-planning/messages.ts` are unchanged; the
     cost line is appended at the send site, same as LinkedIn appends
     `state.costLine` to its draft text.

4. **`src/core/cost.ts`** — PRICING rows per the table above (entries added
   with a comment naming the source and date; `gemini-2.0-flash` removed).

### Tests

- **`src/__tests__/cost.test.ts`** — replace `gemini-2.0-flash` expectations
  with the new rows; add a coverage guard: every model string the app can
  select (`MEAL_PLANNER_MODEL`, `resolveModel` fallbacks, the wrangler default
  `deepseek-v4-flash`) has a PRICING entry. Import the constants where the
  import graph allows; otherwise assert a literal list with a keep-in-sync
  comment. Keep the existing "unknown model → null" case.
- **`src/__tests__/meal-planning-store.test.ts`** — `createActivePlan` /
  `promotePlanVersion` persist usage and hydrate it back; `sumPlanUsage` totals
  across versions and returns null when no version has usage; legacy rows
  (null usage) still hydrate and `sumPlanUsage` handles them.
- **`src/__tests__/meal-planning-workflow.test.ts`** (unit harness, real
  workflow over D1 + stubbed network) — with `usage: { prompt_tokens,
  completion_tokens }` stub responses: the initial plan message contains an
  `Est. cost:` line; the revision message's cost line reflects the cumulative
  total across versions; version rows carry the recorded usage.
- **`src/__integration__/meal-planning-telegram-workflow.integration.test.ts`**
  — give the `LLM_QUEUE` fixtures non-empty `usage` and assert the cost line
  appears on plan messages; adjust any exact-message assertions.
- **`src/__tests__/meal-planning-messages.test.ts`** — unchanged (renderers
  untouched), unless a cost-line helper is extracted for testability.
- LinkedIn tests are untouched: kept rows keep their prices; the removed row
  affects only `cost.test.ts`.

### Validation and deploy notes

- Validation: `pnpm check` (lint + jsdoc + typecheck + unit), plus
  `pnpm test:integration` and `pnpm test:migration`. `d1-test-db.ts` applies
  `migrations/*.sql` automatically.
- Migration must reach the provisioned remote D1 database during deploy; the
  documented command shape (wrangler.toml comment) is
  `wrangler d1 migrations apply <meal-planning database> --remote` (database
  name/id live in the environment config). Local dev databases pick it up on
  next apply.
- No `Env`/binding/workflow/cron change → no `config/runtime-variables.json`
  or production runtime configuration work.

### Out of scope (explicitly deferred)

- Live price fetching or a pricing admin surface — keep the static table
  LinkedIn uses (YAGNI until prices drift more than a manual edit tolerates).
- Cost lines on failure/no-change/context-only notices and in the Mini App.
- Cross-plan/weekly cost rollups for the user — the version rows now make this
  queryable; no reader is built here.
- Pricing entries for models the app does not select (e.g. `deepseek-v4-pro`).

## Ordered implementation steps (one iteration)

1. Write `migrations/0003_meal_plan_cost.sql`.
2. `store.ts`: types, D1/in-memory inserts + hydration, `sumPlanUsage`; update
   `meal-planning-store.test.ts`.
3. `cost.ts`: PRICING rows + comments; update `cost.test.ts` incl. coverage
   guard.
4. `agent-workflow.ts`: usage threading (extract → session → revision
   recursion) and cost line in `sendPlanAndRegister`.
5. Update `meal-planning-workflow.test.ts` and the integration test fixtures.
6. Run `pnpm check`, `pnpm test:integration`, `pnpm test:migration`.
