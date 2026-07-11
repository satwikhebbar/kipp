import { beforeEach, describe, expect, it, vi } from "vitest"

const mockFetch = vi.hoisted(() => vi.fn())
vi.stubGlobal("fetch", mockFetch)

describe("DeepSeek provider", () => {
  beforeEach(() => mockFetch.mockReset())

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("bad auth"),
    })

    const { createDeepseekGenerator } = await import("../providers/deepseek")
    const gen = createDeepseekGenerator("bad-key")
    await expect(gen({ prompt: "hi" })).rejects.toThrow("DeepSeek API error 401")
  })

  it("throws on empty choices", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } }),
    })

    const { createDeepseekGenerator } = await import("../providers/deepseek")
    const gen = createDeepseekGenerator("key")
    await expect(gen({ prompt: "hi" })).rejects.toThrow("empty choices")
  })

  it("handles missing usage metadata", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "hello" } }],
          usage: null,
        }),
    })

    const { createDeepseekGenerator } = await import("../providers/deepseek")
    const gen = createDeepseekGenerator("key")
    const result = await gen({ prompt: "hi" })
    expect(result.text).toBe("hello")
    expect(result.usage.inputTokens).toBe(0)
    expect(result.usage.outputTokens).toBe(0)
  })
})

const mockModel = vi.hoisted(() => ({ generateContent: vi.fn() }))
vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: vi.fn().mockReturnValue({
    getGenerativeModel: () => mockModel,
  }),
}))

describe("Gemini provider", () => {
  beforeEach(() => mockModel.generateContent.mockReset())

  it("throws on blocked content", async () => {
    mockModel.generateContent.mockResolvedValue({
      response: {
        candidates: [],
        promptFeedback: { blockReason: "SAFETY" },
        text: () => "",
        usageMetadata: null,
      },
    })

    const { createGeminiGenerator } = await import("../providers/gemini")
    const gen = createGeminiGenerator("key")
    await expect(gen({ prompt: "bad" })).rejects.toThrow("blocked: SAFETY")
  })

  it("throws on no candidates", async () => {
    mockModel.generateContent.mockResolvedValue({
      response: {
        candidates: [],
        promptFeedback: {},
        text: () => "",
        usageMetadata: null,
      },
    })

    const { createGeminiGenerator } = await import("../providers/gemini")
    const gen = createGeminiGenerator("key")
    await expect(gen({ prompt: "bad" })).rejects.toThrow("Gemini returned no candidates")
  })

  it("returns text and usage on success", async () => {
    mockModel.generateContent.mockResolvedValue({
      response: {
        candidates: [{ content: { parts: [{ text: "response text" }] } }],
        text: () => "response text",
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
      },
    })

    const { createGeminiGenerator } = await import("../providers/gemini")
    const gen = createGeminiGenerator("key")
    const result = await gen({ prompt: "hi" })
    expect(result.text).toBe("response text")
    expect(result.usage.inputTokens).toBe(10)
    expect(result.usage.outputTokens).toBe(20)
  })
})
