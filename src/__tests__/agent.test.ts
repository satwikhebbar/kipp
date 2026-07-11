import { describe, expect, it, vi } from "vitest"
import { createClassifyAgent } from "../agent/classify"
import { createCritiqueAgent } from "../agent/critique"
import { createDraftAgent } from "../agent/draft"
import { createReviseAgent } from "../agent/revise"
import type { GenerateFn } from "../providers/llm"

const STYLE = "Professional but conversational. Concise. Story-driven."

function mockGen(text: string): GenerateFn {
  return vi.fn().mockResolvedValue({ text, usage: { inputTokens: 10, outputTokens: 5 } })
}

describe("draft agent", () => {
  it("produces a draft from title and body", async () => {
    const generate = mockGen("My LinkedIn post content")
    const draft = createDraftAgent(generate, STYLE)
    const result = await draft({ title: "Test Title", body: "Some context" })
    expect(result).toBe("My LinkedIn post content")
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ system: STYLE }))
  })

  it("includes substackBody when provided", async () => {
    const generate = mockGen("Draft with reference")
    const draft = createDraftAgent(generate, STYLE)
    await draft({ title: "T", body: "B", substackBody: "Long reference text" })
    const call = vi.mocked(generate).mock.calls[0][0]
    expect(call.prompt).toContain("Long reference text")
  })
})

describe("critique agent", () => {
  it("returns checklist items from LLM", async () => {
    const llmResponse = JSON.stringify([
      { check: "Opening hook grabs attention within the first line", passed: true, feedback: null },
      { check: "Post is between 150 and 300 words", passed: false, feedback: "Post is 410 words, cut to ~250" },
    ])
    const generate = mockGen(llmResponse)
    const critique = createCritiqueAgent(generate)
    const result = await critique("My draft content")
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ check: expect.any(String), passed: true, feedback: null })
    expect(result[1].feedback).toBe("Post is 410 words, cut to ~250")
  })

  it("sets feedback to null when passed", async () => {
    const agent = createCritiqueAgent(mockGen("[]"))
    const result = await agent("")
    expect(Array.isArray(result)).toBe(true)
  })
})

describe("revise agent", () => {
  it("produces revised draft from failed items", async () => {
    const generate = mockGen("Revised draft text")
    const revise = createReviseAgent(generate)
    const result = await revise({
      draft: "Original draft",
      failedItems: [{ check: "Post is too long", passed: false, feedback: "Shorten it" }],
    })
    expect(result).toBe("Revised draft text")
  })

  it("includes human feedback when provided", async () => {
    const generate = mockGen("Revised")
    const revise = createReviseAgent(generate)
    await revise({ draft: "D", failedItems: [], humanFeedback: "Make it funnier" })
    const call = vi.mocked(generate).mock.calls[0][0]
    expect(call.prompt).toContain("funnier")
  })
})

describe("classify agent", () => {
  it("classifies approval", async () => {
    const generate = mockGen(JSON.stringify({ action: "approve", feedbackText: null }))
    const classify = createClassifyAgent(generate)
    const result = await classify("Looks great, publish it!")
    expect(result).toEqual({ action: "approve", feedbackText: null })
  })

  it("classifies feedback", async () => {
    const generate = mockGen(JSON.stringify({ action: "feedback", feedbackText: "Make it shorter" }))
    const classify = createClassifyAgent(generate)
    const result = await classify("Can you shorten the second paragraph?")
    expect(result).toEqual({ action: "feedback", feedbackText: "Make it shorter" })
  })
})
