# Issue #99: Standardize Cost Reporting on OpenRouter

## Goal

Route production LLM calls through OpenRouter and capture its reported usage
cost at the provider boundary. Persist one complete `cost_usd` per meal-plan
version, including the easy-buy classifier. Keep historical token pricing as a
fallback for records that predate reported cost.

## Design

- Both OpenRouter chat-completion clients opt into usage accounting and parse
  finite, non-negative `usage.cost`. Missing or invalid amounts are unavailable,
  including in cumulative totals; a partial charge is never a complete total.
- Calendar, LinkedIn creation/revision, and RSS idea generation use the existing
  `OPENROUTER_API_KEY`. `LLM_PROVIDER` supplies the model-family default and
  `LLM_MODEL` selects the model; neither selects the transport anymore.
  Direct model names map to OpenRouter IDs, including
  `deepseek-flash` → `~deepseek/deepseek-flash-latest` and
  `gemini-2.5-flash` → `google/gemini-2.5-flash`. Qualified IDs pass through.
  Meal planning and Decisions already use OpenRouter.
- Planner cost and classifier cost are combined before writing a version.
  New rows store the complete charge in `cost_usd`; `cost_status` distinguishes
  reported, unavailable, and legacy records. Tokens and model labels remain
  diagnostic data and support historical estimates.
- Migration 0006 replaces the prior planner-only cost columns and removes
  `decisions_cost_usd`. It folds prior reported planner and classifier charges
  together. For legacy rows, it preserves the classifier component in
  `cost_usd` with legacy status, so reports add token pricing exactly once.
  It does not estimate or backfill historical planner costs. Migration 0005
  remains in sequence so previously migrated databases can upgrade safely.
- Reports sum version charges, using pricing only for legacy planner usage.
  Any unavailable version makes the cumulative cost unavailable.

## Scope

This PR includes the provider-routing changes required by issue #99. It keeps
model families, retry behavior, prompts, and token accounting. Direct-provider
adapters remain available for isolated tests and historical compatibility.
No new runtime variable, binding, or production value is required: the
OpenRouter key is already provisioned for meal planning.

## Acceptance criteria

- All production chat completions use OpenRouter and request usage accounting.
- New meal-plan versions persist a single complete cost, including classifier
  charges, with no report-time repricing or separate classifier sum.
- Historical records retain their previous estimates and classifier charges.
- Missing reported cost never becomes zero or a misleading partial total.
- Coverage exercises provider parsing, routing, multi-turn usage, migration
  of populated rows, version persistence, and cumulative report formatting.
- A gated live contract asserts positive reported cost through both clients:
  `OPENROUTER_COST_CONTRACT=1 pnpm test -- src/__contract__/openrouter-cost.contract.test.ts`.
  It requires `OPENROUTER_API_KEY` and uses the configured model without logging
  secrets or raw responses. Live behavioral parity still needs representative
  Calendar, LinkedIn, and RSS runs before deployment.

## Validation

Run `pnpm lint:ci`, `pnpm docs`, `pnpm typecheck`, `pnpm test`, and
`pnpm deploy:check`. Run the live contract when credentials are available.
