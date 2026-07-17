import { beforeEach, describe, expect, it, vi } from "vitest"

const mockFetch = vi.hoisted(() => vi.fn())
vi.stubGlobal("fetch", mockFetch)

function userMsg(text: string) {
  return { messages: [{ role: "user", content: text } as const] }
}

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
    await expect(gen(userMsg("hi"))).rejects.toThrow("DeepSeek API error 401")
  })

  it("throws on empty choices", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } }),
    })

    const { createDeepseekGenerator } = await import("../providers/deepseek")
    const gen = createDeepseekGenerator("key")
    await expect(gen(userMsg("hi"))).rejects.toThrow("empty choices")
  })

  it("passes ordered system/user/assistant messages and configured model to the wire", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "hello" } }],
          usage: { prompt_tokens: 2, completion_tokens: 3 },
        }),
    })

    const { createDeepseekGenerator } = await import("../providers/deepseek")
    const gen = createDeepseekGenerator("key", "deepseek-reasoner")
    const result = await gen({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
      ],
    })
    expect(result.text).toBe("hello")
    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string) as {
      model: string
      messages: Array<{ role: string; content: string }>
    }
    expect(body.model).toBe("deepseek-reasoner")
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ])
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
    const result = await gen(userMsg("hi"))
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
    await expect(gen(userMsg("bad"))).rejects.toThrow("blocked: SAFETY")
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
    await expect(gen(userMsg("bad"))).rejects.toThrow("Gemini returned no candidates")
  })

  it("merges system messages into systemInstruction and maps assistant to model", async () => {
    mockModel.generateContent.mockResolvedValue({
      response: {
        candidates: [{ content: { parts: [{ text: "response text" }] } }],
        text: () => "response text",
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
      },
    })

    const { createGeminiGenerator } = await import("../providers/gemini")
    const gen = createGeminiGenerator("key")
    const result = await gen({
      messages: [
        { role: "system", content: "rule one" },
        { role: "system", content: "rule two" },
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
      ],
    })
    expect(result.text).toBe("response text")
    expect(result.usage.inputTokens).toBe(10)
    expect(result.usage.outputTokens).toBe(20)

    const arg = mockModel.generateContent.mock.calls[0][0] as {
      systemInstruction?: { parts: Array<{ text: string }> }
      contents: Array<{ role: string; parts: Array<{ text: string }> }>
    }
    expect(arg.systemInstruction?.parts[0]?.text).toBe("rule one\n\nrule two")
    expect(arg.contents).toEqual([
      { role: "user", parts: [{ text: "u1" }] },
      { role: "model", parts: [{ text: "a1" }] },
      { role: "user", parts: [{ text: "u2" }] },
    ])
  })
})
