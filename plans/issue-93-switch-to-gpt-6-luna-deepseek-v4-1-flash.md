# Issue #93 Plan: Switch to GPT-6 Luna and DeepSeek v4.1 Flash

## Goal

Switch Kipp's current model selections from GPT-5.6 Luna to GPT-6 Luna and
from DeepSeek v4 Flash to DeepSeek v4.1 Flash, while keeping provider routing,
tool-call contracts, cost reporting, and existing persisted workflow state
correct.

The implementation should use these canonical provider model IDs unless the
provider documentation confirms a different spelling before coding:

- OpenRouter: `openai/gpt-luna-latest`
- DeepSeek direct API: `deepseek-flash`

The exact IDs must be confirmed against the provider model catalogs during
implementation; no compatibility alias should be invented if a provider
rejects either identifier.

## Current state and scope

The current code already centralizes provider selection but has model names in
several layers:

- `src/providers/index.ts` defaults OpenRouter to `openai/gpt-5.6-luna` and
  DeepSeek to `deepseek-chat` when no explicit model is supplied.
- `src/meal-planning/agent-workflow.ts` explicitly selects OpenRouter with
  `openai/gpt-5.6-luna` for meal planning.
- `wrangler.toml` and `wrangler.local.toml` select `deepseek-v4-flash` for
  the general local/runtime configuration.
- `src/core/cost.ts` prices the old Luna and DeepSeek v4 Flash IDs, and tests
  assert those IDs and rates throughout provider, workflow, integration, and
  store coverage.
- The OpenRouter adapter already sends an arbitrary configured model through
  the OpenAI-compatible chat-completions API, and the DeepSeek adapter already
  does the same through the direct API. No new provider adapter is expected.

The change is limited to model selection, pricing metadata, documentation or
configuration references, and tests/fixtures that assert the selected model.
Do not change provider routing, tool schemas, retry behavior, transcript
handling, workflow state shape, or persisted historical usage rows unless
provider validation exposes a concrete incompatibility.

## Implementation steps

1. **Confirm provider identifiers and pricing.** Verify the canonical
   OpenRouter and direct DeepSeek IDs, availability of native tool calling,
   reasoning/request options, and current input/output prices. Record the
   chosen identifiers in code exactly as returned by the provider catalogs.
   If a model is unavailable for the existing tool protocol, stop and revise
   the plan rather than silently falling back to an older model.

2. **Update model defaults and runtime defaults.** Change the OpenRouter
   fallback in `src/providers/index.ts` to GPT-6 Luna. Change the general
   runtime model in `wrangler.toml` and its derived local configuration to
   DeepSeek v4.1 Flash. Change the meal-planning constants in
   `src/meal-planning/agent-workflow.ts` to keep meal planning on OpenRouter
   and use GPT-6 Luna. Preserve the existing `LLM_PROVIDER` values and the
   production-manifest rule: `wrangler.prod.toml` has no runtime `[vars]`
   values to edit; production values remain dashboard-owned.

3. **Defer production runtime configuration.** Do not update the Cloudflare
   Dashboard or deploy from this branch. After the pull request lands on
   `main`, the human owner will update the existing production `LLM_MODEL`
   value to `deepseek-flash` and deploy using the tracked production manifest.
   Do not add a `[vars]` block or copy the value into `wrangler.prod.toml`;
   that manifest remains value-free with `keep_vars = true`.

4. **Refresh cost reporting.** Replace the old model entries in
   `src/core/cost.ts` with the new identifiers and verified rates. Keep
   `deepseek-chat`, Gemini, and any other still-supported model pricing when
   they remain selectable or are needed for historical records. Do not rewrite
   stored usage model strings; old completed workflow records must continue to
   render their original cost estimates. Update cost comments so the source
   and date of the new rates remain clear.

5. **Update focused tests and fixtures.** Update provider default assertions,
   meal-planning provider/model assertions, runtime fixture defaults, contract
   test defaults, cost arithmetic, and integration/store expectations from the
   old model IDs. Add explicit tests that verify the new model IDs are sent in
   the OpenRouter and DeepSeek request bodies and that every selectable current
   model has a pricing entry. Keep a regression assertion for historical model
   strings if the cost/storage tests exercise mixed-model or previously saved
   usage.

6. **Refresh user-facing references.** Update README or operational docs only
   where they name the active model, and document that local model values come
   from `wrangler.local.toml` while production values are configured in the
   Cloudflare Dashboard. Avoid placing secrets or production runtime values in
   tracked deployment manifests.

## Validation

Run the narrow checks first:

```bash
pnpm vitest run src/__tests__/providers.test.ts src/__tests__/cost.test.ts
pnpm vitest run src/__tests__/meal-planning-workflow.test.ts src/__tests__/meal-planning-store.test.ts
pnpm typecheck
```

Then run the repository quality gates:

```bash
pnpm lint:ci
pnpm docs
pnpm test
pnpm deploy:check
```

For the production rollout, verify the Cloudflare Dashboard value and the
deployed runtime separately after `pnpm deploy:check` and deployment. The
tracked production manifest must still contain no runtime `[vars]` values.

Credential-gated provider contract tests should be run when the new provider
credentials and model access are available. They must confirm native tool
calling and the expected reasoning fields for both updated model paths without
logging prompts, credentials, or raw provider responses.

## Acceptance criteria

- All default and explicitly configured active paths select GPT-6 Luna for
  OpenRouter meal planning and DeepSeek v4.1 Flash for the general DeepSeek
  runtime.
- Provider request tests prove the exact canonical model IDs are sent.
- Cost reporting recognizes both new IDs with verified rates, and model
  coverage tests prevent an active selectable model from becoming unpriced.
- Existing persisted usage/cost records remain readable and retain their
  original model labels and estimates.
- Production Dashboard configuration and deployment are explicitly deferred
  until after this branch merges to `main`; `wrangler.prod.toml` remains
  value-free.
- No provider routing, tool schema, retry, privacy, workflow state, or
  production secret-handling regressions are introduced.
- Typecheck, lint, documentation checks, tests, and deployment dry-run pass.

## Files expected to change during implementation

- `src/providers/index.ts`
- `src/meal-planning/agent-workflow.ts`
- `src/core/cost.ts`
- `wrangler.toml`
- `wrangler.local.toml`
- Focused provider, cost, meal-planning, integration, contract, and storage
  tests identified by search for the old model IDs.
- Any README or operational documentation that names the active model.

No implementation files are changed in this planning lane.
