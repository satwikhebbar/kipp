import { describe, expect, test } from "vitest"
import { computeCost, computeCostByModel, formatCostLine } from "../core/cost"
import type { WorkflowCost } from "../core/types"
import { resolveModel } from "../providers"

describe("computeCost", () => {
  test("known model arithmetic", () => {
    const cost = computeCost({ inputTokens: 1_000_000, outputTokens: 500_000 }, "deepseek-flash")
    expect(cost.totalCostUsd).toBeCloseTo(0.9, 4)
    expect(cost.totalInputTokens).toBe(1_000_000)
    expect(cost.totalOutputTokens).toBe(500_000)
    expect(cost.model).toBe("deepseek-flash")
  })

  test("unknown model returns null cost", () => {
    const cost = computeCost({ inputTokens: 100, outputTokens: 50 }, "nonexistent-model")
    expect(cost.totalCostUsd).toBeNull()
    expect(cost.model).toBe("nonexistent-model")
  })

  test("zero tokens costs zero", () => {
    const cost = computeCost({ inputTokens: 0, outputTokens: 0 }, "deepseek-flash")
    expect(cost.totalCostUsd).toBeCloseTo(0, 4)
  })

  test("rounding with small token counts", () => {
    const cost = computeCost({ inputTokens: 1, outputTokens: 1 }, "deepseek-flash")
    expect(cost.totalCostUsd).toBeCloseTo(0.0000015, 8)
  })

  test("deepseek-chat pricing arithmetic", () => {
    const cost = computeCost({ inputTokens: 1_000_000, outputTokens: 500_000 }, "deepseek-chat")
    expect(cost.totalCostUsd).toBeCloseTo(0.82, 4)
    expect(cost.model).toBe("deepseek-chat")
  })

  test("openai/gpt-5.6-luna pricing arithmetic", () => {
    const cost = computeCost({ inputTokens: 1_000_000, outputTokens: 500_000 }, "openai/gpt-5.6-luna")
    expect(cost.totalCostUsd).toBeCloseTo(0.8, 4)
    expect(cost.model).toBe("openai/gpt-5.6-luna")
  })

  test("openai/gpt-6-luna pricing arithmetic", () => {
    const cost = computeCost({ inputTokens: 1_000_000, outputTokens: 500_000 }, "openai/gpt-6-luna")
    expect(cost.totalCostUsd).toBeCloseTo(0.35, 4)
    expect(cost.model).toBe("openai/gpt-6-luna")
  })

  test("gemini-2.5-flash pricing arithmetic", () => {
    const cost = computeCost({ inputTokens: 1_000_000, outputTokens: 500_000 }, "gemini-2.5-flash")
    expect(cost.totalCostUsd).toBeCloseTo(1.55, 4)
    expect(cost.model).toBe("gemini-2.5-flash")
  })

  test("every model the app can select has a pricing entry", () => {
    // resolveModel fallbacks plus the local dev default (wrangler.toml LLM_MODEL).
    const selectableModels = [
      resolveModel("deepseek"),
      resolveModel("openrouter"),
      resolveModel("gemini"),
      "deepseek-flash",
    ]
    for (const model of selectableModels) {
      expect(computeCost({ inputTokens: 0, outputTokens: 0 }, model).totalCostUsd).not.toBeNull()
    }
  })
})

describe("computeCostByModel", () => {
  test("prices each model group at its own rate and joins the model labels", () => {
    const cost = computeCostByModel([
      { inputTokens: 1_000_000, outputTokens: 500_000, model: "openai/gpt-6-luna" },
      { inputTokens: 1_000_000, outputTokens: 500_000, model: "deepseek-flash" },
    ])
    expect(cost.totalCostUsd).toBeCloseTo(0.35 + 0.9, 4)
    expect(cost.totalInputTokens).toBe(2_000_000)
    expect(cost.totalOutputTokens).toBe(1_000_000)
    expect(cost.model).toBe("openai/gpt-6-luna + deepseek-flash")
  })

  test("a single group matches computeCost", () => {
    const groups = [{ inputTokens: 1_000, outputTokens: 500, model: "deepseek-chat" }]
    expect(computeCostByModel(groups).totalCostUsd).toBeCloseTo(
      computeCost(groups[0], "deepseek-chat").totalCostUsd ?? -1,
      8,
    )
    expect(computeCostByModel(groups).model).toBe("deepseek-chat")
  })

  test("an unpriced model nulls the whole estimate", () => {
    const cost = computeCostByModel([
      { inputTokens: 10, outputTokens: 5, model: "deepseek-flash" },
      { inputTokens: 10, outputTokens: 5, model: "some-future-model" },
    ])
    expect(cost.totalCostUsd).toBeNull()
    expect(cost.model).toBe("deepseek-flash + some-future-model")
  })
})

describe("formatCostLine", () => {
  test("known model formats cost with tilde prefix", () => {
    const cost: WorkflowCost = {
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      totalCostUsd: 0.00027,
      model: "deepseek-flash",
    }
    const line = formatCostLine(cost)
    expect(line).toContain("~$0.0003")
    expect(line).toContain("1000 in / 500 out")
    expect(line).toContain("deepseek-flash")
  })

  test("unknown model returns no-estimate message", () => {
    const cost: WorkflowCost = {
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalCostUsd: null,
      model: "some-future-model",
    }
    expect(formatCostLine(cost)).toContain("not in pricing table")
    expect(formatCostLine(cost)).toContain("some-future-model")
  })
})

describe("resolveModel", () => {
  test("explicit model overrides default", () => {
    expect(resolveModel("deepseek", "deepseek-flash")).toBe("deepseek-flash")
  })

  test("unknown provider throws", () => {
    expect(() => resolveModel("ollama")).toThrow("Unknown LLM provider")
  })
})
