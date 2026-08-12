import { describe, expect, it, vi } from "vitest"
import { createClassifyAgent } from "../agent/classify"
import { createCritiqueAgent } from "../agent/critique"
import { createDraftAgent, createDraftConversation } from "../agent/draft"
import { buildReviseConversation, createReviseAgent } from "../agent/revise"
import type { GenerateFn, LLMMessage } from "../providers/llm"

const STYLE = "Professional but conversational. Concise. Story-driven."

function mockGen(text: string): GenerateFn {
  return vi.fn().mockResolvedValue({ text, usage: { inputTokens: 10, outputTokens: 5 } })
}

function lastMessages(fn: ReturnType<typeof mockGen>): LLMMessage[] {
  return (vi.mocked(fn).mock.calls[0][0] as { messages: LLMMessage[] }).messages
}

describe("draft agent", () => {
  it("produces a draft from title and body", async () => {
    const generate = mockGen("My LinkedIn post content")
    const draft = createDraftAgent(generate, STYLE)
    const result = await draft({ title: "Test Title", body: "Some context" })
    expect(result).toBe("My LinkedIn post content")
    const msgs = lastMessages(generate)
    expect(msgs[0]).toEqual({ role: "system", content: STYLE })
    expect(msgs[1].role).toBe("user")
    expect(msgs[1].content).toContain("Test Title")
    expect(msgs[1].content).toContain("Some context")
  })

  it("includes the format directive in the user message", async () => {
    const generate = mockGen("Draft with reference")
    const draft = createDraftAgent(generate, STYLE)
    await draft({ title: "T", body: "B" })
    const user = lastMessages(generate)[1].content
    expect(user).toContain("150-300 words")
  })

  it("createDraftConversation returns style as system and idea/source as user without calling generate", () => {
    const msgs = createDraftConversation(STYLE, { title: "T", body: "B" })
    expect(msgs[0]).toEqual({ role: "system", content: STYLE })
    expect(msgs[1].role).toBe("user")
    expect(msgs[1].content).toContain("T")
    expect(msgs[1].content).toContain("B")
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
  it("preserves the existing transcript and appends a revision instruction + assistant response", async () => {
    const generate = mockGen("Revised draft text")
    const revise = createReviseAgent(generate)
    const existing: LLMMessage[] = [
      { role: "system", content: STYLE },
      { role: "user", content: "original request" },
      { role: "assistant", content: "original draft" },
    ]
    const result = await revise({
      messages: existing,
      failedItems: [{ check: "Post is too long", passed: false, feedback: "Shorten it" }],
    })
    expect(result).toBe("Revised draft text")
    const sent = lastMessages(generate)
    expect(sent.slice(0, 3)).toEqual(existing)
    expect(sent[3].role).toBe("user")
    expect(sent[3].content).toContain("Shorten it")
    expect(sent.some((m) => m.role === "assistant" && m.content === "Revised draft text")).toBe(false)
  })

  it("appends human feedback as a separate user message when provided", async () => {
    const generate = mockGen("Revised")
    const revise = createReviseAgent(generate)
    const existing: LLMMessage[] = [
      { role: "system", content: STYLE },
      { role: "user", content: "original request" },
      { role: "assistant", content: "draft" },
    ]
    await revise({ messages: existing, failedItems: [], humanFeedback: "Make it funnier" })
    const sent = lastMessages(generate)
    expect(sent.slice(0, 3)).toEqual(existing)
    expect(sent[3].role).toBe("user")
    expect(sent[4].role).toBe("user")
    expect(sent[4].content).toBe("Make it funnier")
  })

  it("buildReviseConversation omits feedback user message when humanFeedback is empty", () => {
    const existing: LLMMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ]
    const built = buildReviseConversation({ messages: existing, failedItems: [] })
    expect(built).toHaveLength(existing.length + 1)
    expect(built[built.length - 1].role).toBe("user")
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
