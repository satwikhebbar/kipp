import { describe, expect, it } from "vitest"
import { serializeTranscript, transcriptEnabled } from "../meal-planning/agent-workflow"

describe("development meal-planning transcripts", () => {
  it("only enables transcript payloads for an explicit development opt-in", () => {
    expect(transcriptEnabled({ DEPLOYMENT_ENV: "development", LLM_DEBUG_TRANSCRIPT: "true" })).toBe(true)
    expect(transcriptEnabled({ DEPLOYMENT_ENV: "development", LLM_DEBUG_TRANSCRIPT: "false" })).toBe(false)
    expect(transcriptEnabled({ DEPLOYMENT_ENV: "production", LLM_DEBUG_TRANSCRIPT: "true" })).toBe(false)
  })

  it("preserves structured tool inputs and outputs while omitting provider reasoning", () => {
    const transcript = serializeTranscript([
      { role: "system", text: "Plan the week." },
      {
        role: "assistant",
        text: "Evaluating the candidate.",
        reasoningContent: "private reasoning",
        toolCalls: [
          {
            id: "call-1",
            name: "evaluate_meal_plan",
            input: {
              grid: { Mon: { breakfast: { dish: "Poha", items: ["flattened rice", "potato"] } } },
              policyOutcomes: { "ingredient-naming": { outcome: "satisfied" } },
            },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        name: "evaluate_meal_plan",
        output: { pass: false, failures: [{ code: "missing_slot", detail: "Tue breakfast" }] },
      },
    ])

    expect(transcript).toEqual([
      { role: "system", text: "Plan the week." },
      {
        role: "assistant",
        text: "Evaluating the candidate.",
        toolCalls: [
          {
            id: "call-1",
            name: "evaluate_meal_plan",
            input: {
              grid: { Mon: { breakfast: { dish: "Poha", items: ["flattened rice", "potato"] } } },
              policyOutcomes: { "ingredient-naming": { outcome: "satisfied" } },
            },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        name: "evaluate_meal_plan",
        output: { pass: false, failures: [{ code: "missing_slot", detail: "Tue breakfast" }] },
      },
    ])
    expect(JSON.stringify(transcript)).not.toContain("redacted")
    expect(JSON.stringify(transcript)).not.toContain("private reasoning")
  })
})
