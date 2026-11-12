import { mkdirSync, writeFileSync } from "node:fs"
import { describe, it } from "vitest"
import { createWorkflowSanity, SANITY_LIMITS } from "../__integration__/helpers/workflow-sanity"
import { calendarJourney, linkedInJourney, notesJourney } from "../__integration__/helpers/workflow-sanity-scenarios"
import { resolveModel } from "../providers"

const enabled = process.env.WORKFLOW_SANITY_LIVE === "1"
const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.LLM_API_KEY ?? ""
const model = resolveModel("deepseek", process.env.SANITY_MODEL)
const CLEANUP_ALLOWANCE_MS = 15_000

describe.skipIf(!enabled)("live LLM webhook workflow sanity", () => {
  for (const [name, journey] of [
    ["linkedin", linkedInJourney],
    ["calendar", calendarJourney],
    ["notes", notesJourney],
  ] as const) {
    it(
      name,
      async () => {
        if (!apiKey) throw new Error("Set DEEPSEEK_API_KEY or LLM_API_KEY to run live workflow sanity")
        console.log(JSON.stringify({ scenario: name, phase: "starting-runtime" }))
        const harness = await createWorkflowSanity({
          live: { apiKey, model },
          onProgress: (event) => console.log(JSON.stringify({ scenario: name, model, ...event })),
        })
        try {
          await journey(harness)
          console.log(
            JSON.stringify({
              scenario: name,
              model,
              calls: harness.state.modelCalls,
              outputTokens: harness.state.outputTokens,
            }),
          )
        } finally {
          // The transcript contains only synthetic scenario data; credentials and HTTP headers are never included.
          mkdirSync(".wrangler/workflow-sanity", { recursive: true })
          writeFileSync(
            `.wrangler/workflow-sanity/${name}.json`,
            JSON.stringify(
              { model, limits: SANITY_LIMITS, ...harness.state, telegram: harness.network.getState().telegramMessages },
              null,
              2,
            ),
            { mode: 0o600 },
          )
          await harness.dispose()
        }
      },
      SANITY_LIMITS.scenarioMs + CLEANUP_ALLOWANCE_MS,
    )
  }
})
