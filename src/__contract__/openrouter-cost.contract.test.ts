import { describe, expect, it } from "vitest"
import { createOpenRouterGenerator, createOpenRouterToolClient } from "../providers/openrouter"
import { resolveOpenRouterModel } from "../providers/routing"

const apiKey = process.env.OPENROUTER_API_KEY ?? ""
const enabled = process.env.OPENROUTER_COST_CONTRACT === "1" && Boolean(apiKey)
const contractIt = enabled ? it : it.skip
const CONTRACT_TIMEOUT_MS = 240_000

describe("OpenRouter reported usage cost live contract", () => {
  contractIt(
    "returns a positive cost through the generator",
    async () => {
      const model = resolveOpenRouterModel(process.env.LLM_PROVIDER ?? "deepseek", process.env.LLM_MODEL)
      const result = await createOpenRouterGenerator(
        apiKey,
        model,
      )({
        messages: [{ role: "user", content: "Reply with the word hello." }],
      })
      expect(result.usage.reportedCostUsd).toBeGreaterThan(0)
      expect(Number.isFinite(result.usage.reportedCostUsd)).toBe(true)
    },
    CONTRACT_TIMEOUT_MS,
  )

  contractIt(
    "returns a positive cost through the workflow tool client",
    async () => {
      const model = resolveOpenRouterModel(process.env.LLM_PROVIDER ?? "deepseek", process.env.LLM_MODEL)
      const result = await createOpenRouterToolClient(apiKey, model).generate({
        messages: [{ role: "user", text: "Reply with the word hello." }],
        tools: [],
      })
      expect(result.usage.reportedCostUsd).toBeGreaterThan(0)
      expect(Number.isFinite(result.usage.reportedCostUsd)).toBe(true)
    },
    CONTRACT_TIMEOUT_MS,
  )
})
