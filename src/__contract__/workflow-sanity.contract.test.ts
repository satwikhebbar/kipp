import { mkdirSync, writeFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { createWorkflowSanity, SANITY_LIMITS } from "../__integration__/helpers/workflow-sanity"
import {
  calendarJourney,
  linkedInJourney,
  notesJourney,
  notesRelativeJourney,
  notesScheduledJourney,
} from "../__integration__/helpers/workflow-sanity-scenarios"
import { NOTES_MODEL } from "../agent/notes"
import { resolveOpenRouterModel } from "../providers/routing"

const enabled = process.env.WORKFLOW_SANITY_LIVE === "1"
const CLEANUP_ALLOWANCE_MS = 15_000

describe.skipIf(!enabled)("live LLM webhook workflow sanity", () => {
  for (const [name, journey] of [
    ["linkedin", linkedInJourney],
    ["calendar", calendarJourney],
    ["notes", notesJourney],
    ["notes scheduled", notesScheduledJourney],
    ["notes relative", notesRelativeJourney],
  ] as const) {
    it(
      name,
      async () => {
        const model = name.startsWith("notes")
          ? NOTES_MODEL
          : resolveOpenRouterModel("deepseek", process.env.SANITY_MODEL)
        const apiKey = process.env.OPENROUTER_API_KEY
        if (!apiKey) throw new Error("Set OPENROUTER_API_KEY to run live workflow sanity")
        console.log(JSON.stringify({ scenario: name, phase: "starting-runtime" }))
        const harness = await createWorkflowSanity({
          live: { apiKey, model },
          onProgress: (event) => console.log(JSON.stringify({ scenario: name, model, ...event })),
        })
        try {
          await journey(harness)
          expect(harness.state.transcript.length).toBeGreaterThan(0)
          for (const { request, response } of harness.state.transcript) {
            expect(request.model).toBe(model)
            expect(request.usage).toEqual({ include: true })
            const usage = response.usage as { cost?: number } | undefined
            expect(usage?.cost).toEqual(expect.any(Number))
            expect(Number.isFinite(usage?.cost)).toBe(true)
            expect(usage?.cost).toBeGreaterThanOrEqual(0)
          }
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
