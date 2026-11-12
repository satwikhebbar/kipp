# Automated workflow sanity checks

Routine workflow refactoring does not require a Telegram session or real LinkedIn
or Google Calendar account. The integration suites include complete HTTP journeys
through the production Worker, Cloudflare Workflows and SQLite Durable Objects
in Miniflare. The token vault contains synthetic credentials. All outbound HTTP
is intercepted; unrecognized requests fail the scenario.

Run deterministic coverage with:

```sh
pnpm test:integration
```

The existing LinkedIn suite now also drives `/generate 1`, reads the actual Revise
button, submits feedback, and clicks the revised draft's actual Approve button.
It asserts no early write, one LinkedIn request with `lifecycleState: DRAFT`, exact
reviewed text, Notion finalization, and no second write after callback redelivery.
The Calendar suite drives a clarification and reply before checking the production
client's serialized event and Telegram confirmation. Spring gaps and fall overlaps
produce clarification with no event creation. Existing targeted integration and
unit tests remain in place for expiry, authorization, stale actions and recovery.

## Real-model checks

The separate, opt-in contract suite reuses the LinkedIn and Calendar journeys
with real DeepSeek, and the Notes journey with GPT-6 Luna through OpenRouter.
External account APIs remain intercepted. Notes covers necessary clarification,
a prose revision that retains the first embedded card, and exact publication approval.
It evaluates workflow behavior and payloads, rather than exact prose or editorial
quality. It does not use an LLM to play the user: user replies are scripted, and
button values come from actual captured Telegram messages.

With credentials already loaded in the environment:

```sh
pnpm test:workflow-sanity:live
```

To load the ignored local credentials file without printing its contents:

```sh
WORKFLOW_SANITY_LIVE=1 node --env-file=.dev.vars node_modules/vitest/vitest.mjs run src/__contract__/workflow-sanity.contract.test.ts
```

LinkedIn and Calendar use `DEEPSEEK_API_KEY`, or `LLM_API_KEY` containing a DeepSeek key.
`SANITY_MODEL` overrides their default model (`deepseek-flash`). Notes uses
`OPENROUTER_API_KEY` and its pinned production model, `openai/gpt-6-luna`. Enabling the
suite without a key fails explicitly; ordinary test runs skip the live cases.
Run these checks for prompt, provider and orchestration changes and before release.

Each scenario allows at most 12 model calls, five user actions (including callback
redelivery), 16,384 output tokens per call, 98,304 aggregate output tokens, 90 seconds
per model request and four minutes overall. Scripted scenarios have a 20-second
deadline. Production's per-session turn limits continue to apply. The harness
preserves any smaller explicit production output limit, disables provider retries,
and does not rerun failed scenarios. A truncated response or exhausted budget is
reported explicitly. The aggregate usage check runs after each response, so the
maximum overshoot is one bounded response.

The initial token allowances are generous anomaly guards, not calibrated cost
targets. Recorded successful usage should inform later adjustments; do not lower
them merely to save a small amount on this tiny suite. Both reasoning and visible
output count toward DeepSeek's reported completion-token usage.

Each live run retains model requests/responses, Telegram messages, captured
provider writes, failure reasons and usage under the ignored
`.wrangler/workflow-sanity/` directory. Files contain synthetic scenario data and
no authentication headers or real account credentials. A failure should be
diagnosed from that transcript and reproduced with scripted coverage before one
live confirmation; do not repeatedly rerun live tests until they pass.

Live-account checks are reserved for capabilities mocks cannot establish, such as
OAuth setup, provider contract changes and native embedded-card appearance.
