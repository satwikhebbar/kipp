import { describe, expect, test } from "vitest"
import { computeCost, formatCostLine } from "../core/cost"
import type { WorkflowCost } from "../core/types"
import { resolveModel } from "../providers"

describe("computeCost", () => {
  test("known model arithmetic", () => {
    const cost = computeCost({ inputTokens: 1_000_000, outputTokens: 500_000 }, "deepseek-v4-flash")
    expect(cost.totalCostUsd).toBeCloseTo(0.28, 4)
    expect(cost.totalInputTokens).toBe(1_000_000)
    expect(cost.totalOutputTokens).toBe(500_000)
    expect(cost.model).toBe("deepseek-v4-flash")
  })

  test("unknown model returns null cost", () => {
    const cost = computeCost({ inputTokens: 100, outputTokens: 50 }, "nonexistent-model")
    expect(cost.totalCostUsd).toBeNull()
    expect(cost.model).toBe("nonexistent-model")
  })

  test("zero tokens costs zero", () => {
    const cost = computeCost({ inputTokens: 0, outputTokens: 0 }, "deepseek-v4-flash")
    expect(cost.totalCostUsd).toBeCloseTo(0, 4)
  })

  test("rounding with small token counts", () => {
    const cost = computeCost({ inputTokens: 1, outputTokens: 1 }, "deepseek-v4-flash")
    expect(cost.totalCostUsd).toBeCloseTo(0.00000042, 8)
  })

  test("deepseek-chat pricing arithmetic", () => {
    const cost = computeCost({ inputTokens: 1_000_000, outputTokens: 500_000 }, "deepseek-chat")
    expect(cost.totalCostUsd).toBeCloseTo(0.82, 4)
    expect(cost.model).toBe("deepseek-chat")
  })

  test("gemini-2.0-flash pricing arithmetic", () => {
    const cost = computeCost({ inputTokens: 1_000_000, outputTokens: 500_000 }, "gemini-2.0-flash")
    expect(cost.totalCostUsd).toBeCloseTo(0.3, 4)
    expect(cost.model).toBe("gemini-2.0-flash")
  })
})

describe("formatCostLine", () => {
  test("known model formats cost with tilde prefix", () => {
    const cost: WorkflowCost = {
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      totalCostUsd: 0.00027,
      model: "deepseek-v4-flash",
    }
    const line = formatCostLine(cost)
    expect(line).toContain("~$0.0003")
    expect(line).toContain("1000 in / 500 out")
    expect(line).toContain("deepseek-v4-flash")
  })

  test("unknown model returns no-estimate message", () => {
    const cost: WorkflowCost = {
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalCostUsd: null,
      model: "gemini-2.0-flash",
    }
    expect(formatCostLine(cost)).toContain("not in pricing table")
    expect(formatCostLine(cost)).toContain("gemini-2.0-flash")
  })
})

describe("resolveModel", () => {
  test("explicit model overrides default", () => {
    expect(resolveModel("deepseek", "deepseek-v4-flash")).toBe("deepseek-v4-flash")
  })

  test("unknown provider throws", () => {
    expect(() => resolveModel("ollama")).toThrow("Unknown LLM provider")
  })
})
