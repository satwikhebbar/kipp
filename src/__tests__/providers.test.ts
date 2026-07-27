import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import type { ToolConversationMessage } from "../providers/llm"
import type { ToolDefinition, ToolRegistry } from "../runtime/tools"

const mockFetch = vi.hoisted(() => vi.fn())
vi.stubGlobal("fetch", mockFetch)

function userMsg(text: string) {
  return { messages: [{ role: "user", content: text } as const] }
}

const ECHO_TOOL: ToolDefinition = {
  name: "echo",
  description: "Echoes an input value.",
  input: z.object({ value: z.string() }),
  output: z.object({ value: z.string() }),
  privacy: "private",
  handler: async ({ value }) => ({ value }),
}

const TOOL_TEST_MESSAGES: ToolConversationMessage[] = [{ role: "user", text: "hello" }]
const TOOL_TEST_REGISTRY: ToolRegistry = { echo: ECHO_TOOL }

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

  it("maps native tool declarations and calls", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            { message: { tool_calls: [{ id: "call-1", function: { name: "echo", arguments: '{"value":"hi"}' } }] } },
          ],
          usage: {},
        }),
    })
    const { createDeepseekToolClient } = await import("../providers/deepseek")
    const client = createDeepseekToolClient("key")
    const response = await client.generate({
      messages: TOOL_TEST_MESSAGES,
      tools: [TOOL_TEST_REGISTRY.echo],
    })
    expect(response.toolCalls).toEqual([{ id: "call-1", name: "echo", input: { value: "hi" } }])
    expect(JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string).tools[0].function.name).toBe("echo")
  })

  it("retries transient native-tool failures but not malformed tool payloads", async () => {
    const { createToolProvider } = await import("../providers")
    const transient = createToolProvider("key", "deepseek", undefined, 1)
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: "done" } }], usage: {} }),
    })
    vi.useFakeTimers()
    const transientResult = transient.generate({ messages: TOOL_TEST_MESSAGES, tools: [TOOL_TEST_REGISTRY.echo] })
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(transientResult).resolves.toMatchObject({ text: "done" })
    expect(mockFetch).toHaveBeenCalledTimes(2)
    vi.useRealTimers()

    mockFetch.mockReset()
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { tool_calls: [{ id: "bad", function: { name: "echo", arguments: "{" } }] } }],
          usage: {},
        }),
    })
    const malformed = createToolProvider("key", "deepseek", undefined, 3)
    await expect(
      malformed.generate({ messages: TOOL_TEST_MESSAGES, tools: [TOOL_TEST_REGISTRY.echo] }),
    ).rejects.toThrow("malformed tool arguments")
    expect(mockFetch).toHaveBeenCalledTimes(1)
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
