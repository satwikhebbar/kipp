import { describe, expect, it } from "vitest"
import { resolveOpenRouterModel } from "../providers/routing"

describe("OpenRouter workflow model selection", () => {
  it.each([
    ["deepseek", undefined, "~deepseek/deepseek-flash-latest"],
    ["gemini", undefined, "google/gemini-2.5-flash"],
    ["openrouter", undefined, "~openai/gpt-luna-latest"],
    ["deepseek", "deepseek-v4-flash", "deepseek/deepseek-v4-flash"],
    ["gemini", "gemini-2.5-flash", "google/gemini-2.5-flash"],
    ["deepseek", "openai/gpt-6-luna", "openai/gpt-6-luna"],
  ])("maps %s / %s to %s", (provider, configured, expected) => {
    expect(resolveOpenRouterModel(provider, configured)).toBe(expected)
  })

  it("rejects ambiguous model names before sending a request", () => {
    expect(() => resolveOpenRouterModel("openrouter", "unknown-model")).toThrow("OpenRouter model ID")
  })
})
