import { describe, expect, it } from "vitest"
import { createGenerator } from "../providers/index"

describe("createGenerator", () => {
  it("throws on unknown provider", () => {
    expect(() => createGenerator("sk-test", "unknown")).toThrow("Unknown LLM provider")
  })

  it("returns a function for gemini", () => {
    const gen = createGenerator("sk-test", "gemini")
    expect(typeof gen).toBe("function")
  })

  it("returns a function for deepseek", () => {
    const gen = createGenerator("sk-test", "deepseek")
    expect(typeof gen).toBe("function")
  })
})
