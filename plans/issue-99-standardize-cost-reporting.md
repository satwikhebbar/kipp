# Issue #99 Plan: Standardize Cost Reporting on OpenRouter's Reported Usage Cost

## Goal

Use OpenRouter's per-request reported USD cost as the authoritative cost for
OpenRouter-backed completions and Decisions calls. Aggregate those reported
amounts across workflow turns and show them in cost reports without applying a
second model price estimate. Keep token counts and model labels in reports, and
preserve readable historical plan records that predate persisted reported-cost
data.

## Current state

- `src/providers/openrouter.ts` parses prompt and completion token counts from
  chat-completion usage, but drops OpenRouter's reported `usage.cost`. Both the
  basic generator and tool client return only token usage.
- `src/providers/openrouter-decisions.ts` already parses `usage.cost` from the
  Decisions API and exposes it as `DecisionUsage.costUsd`.
- `src/core/cost.ts` estimates cost from a static model pricing table. LinkedIn
  reports use this calculation for one session and for revisions. Meal planning
  groups token usage by model and reprices those groups when rendering plan
  messages; Decisions cost is separately added as a reported USD amount.
- `LLMUsage` contains only input and output token counts. Meal-plan versions
  persist those counts and a model label in `VersionUsage`; old records may have
  no usage data. There is no persisted per-version chat-completion cost today.
- The plan cost is rendered from accumulated version usage, so carrying the
  reported amount through aggregation and storage is needed for consistent
  future revisions and history reads.

## Design

1. **Carry reported cost from both chat-completion paths.** Extend the
   OpenRouter response usage shape to accept a numeric `cost`, and return it
   with token usage from both `createOpenRouterGenerator` and
   `createOpenRouterToolClient`. Treat a missing or malformed reported cost as
   unavailable rather than converting it to zero. Confirm against the current
   OpenRouter API contract whether the request needs an explicit usage option
   to receive cost, then request it where necessary. Preserve existing
   behavior for token fields and all non-OpenRouter providers.

2. **Make cost selection explicit.** Extend the shared usage/cost model so a
   reported USD amount can be distinguished from token-derived pricing. When a
   reported amount exists, use it as the cost for that usage and never add a
   model-table estimate for the same calls. Continue showing input/output token
   totals and model labels. Keep model pricing available for non-OpenRouter
   providers that do not report a comparable cost, and for legacy records that
   have no reported-cost value.

3. **Aggregate actual cost across calls and revisions.** Update tool-session
   and workflow usage aggregation to sum reported amounts alongside tokens.
   Maintain correct mixed-provider behavior: each group's reported cost takes
   precedence when available, with pricing used only for a group that has no
   reported amount. Do not infer missing costs from a partial set of calls or
   display a partial sum as the full workflow cost.

4. **Persist meal-plan reported cost.** Add an optional reported-cost field to
   per-version usage and migrate the D1 schema/store serialization, summation,
   and hydration paths. Existing rows remain valid with a null/missing field.
   On render, sum reported costs for versions that have them and use the
   existing model-pricing estimate only for legacy versions without reported
   cost. Preserve the current separately reported Decisions cost and add it
   exactly once. Avoid rewriting prior rows or changing the meaning of their
   stored token counts and model labels.

5. **Update reporting and focused coverage.** Ensure LinkedIn initial drafts,
   LinkedIn revisions, meal-plan creation/revisions/history, and Decisions
   classification all contribute their appropriate costs exactly once. Add
   provider tests for reported, absent, and invalid cost values; aggregation
   tests for multiple turns and mixed availability; storage/migration tests for
   new and legacy versions; and formatting tests proving reported amounts are
   not repriced. Update existing expectations that currently assert static
   estimates for OpenRouter-backed work.

## Scope boundaries

- Do not change provider routing, selected models, token accounting, retry
  behavior, prompt or tool payloads, or persisted model labels.
- Do not make model pricing changes as a substitute for reported billing data.
- Do not change production runtime configuration; no new `Env` binding is
  expected.
- Keep old model-based pricing for providers and historical records where no
  reported cost was saved.

## Validation

Run focused provider, cost, tool-session, workflow, and meal-planning store
tests, including migration coverage. Then run the repository checks:

```bash
pnpm lint:ci
pnpm docs
pnpm typecheck
pnpm test
pnpm deploy:check
```

Where OpenRouter credentials are available, run the relevant provider contract
check to confirm the returned response includes a usable `usage.cost`. Do not
log request payloads, credentials, or raw provider responses.

## Acceptance criteria

- OpenRouter chat completions expose the API-reported cost through both
  generator and tool-client paths.
- OpenRouter-reported cost is the single source used for those calls; no
  static-price estimate is added on top.
- Multi-turn and cumulative reports sum the reported costs correctly while
  retaining token totals and model labels.
- Meal-plan reported cost is persisted per version and aggregated correctly;
  existing rows continue to render using their legacy pricing behavior.
- The Decisions endpoint's existing reported cost remains included exactly
  once.
- Missing reported cost is handled explicitly and does not masquerade as zero
  or produce an incomplete full-workflow total.
- Focused and repository validation passes.

## Likely implementation areas

- `src/providers/openrouter.ts`
- `src/core/types.ts` and `src/core/cost.ts`
- `src/agent/` and `src/linkedin/workflow.ts` usage aggregation
- `src/meal-planning/agent-workflow.ts` and `src/meal-planning/store.ts`
- A new migration under `migrations/`
- Provider, cost, agent, workflow, store, and migration tests

