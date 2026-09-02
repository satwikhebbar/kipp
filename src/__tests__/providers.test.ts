import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import type { ToolConversationMessage } from "../providers/llm"
import { toolDeclaration } from "../providers/llm"
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
  batching: "isolated",
  handler: async ({ value }) => ({ value }),
}

const TOOL_TEST_MESSAGES: ToolConversationMessage[] = [{ role: "user", text: "hello" }]
const TOOL_TEST_REGISTRY: ToolRegistry = { echo: ECHO_TOOL }
const SCHEDULING_TOOL: ToolDefinition = {
  name: "submit_one_off_proposal",
  description: "Submit a calendar proposal.",
  input: z.object({
    title: z.string(),
    durationMinutes: z.number().int(),
    description: z.string().optional(),
    location: z.string().optional(),
    reminderMinutes: z.number().int().optional(),
  }),
  output: z.object({ accepted: z.literal(true) }),
  privacy: "private",
  batching: "isolated",
  handler: async () => ({ accepted: true }),
}

const PROVENANCE_TOOL: ToolDefinition = {
  name: "submit_sourced_proposal",
  description: "Submit a proposal whose fields include provenance.",
  input: z.object({
    title: z.object({ value: z.string(), source: z.enum(["explicit", "inferred"]) }),
    localDate: z.object({ value: z.string(), source: z.enum(["explicit", "inferred"]) }).optional(),
  }),
  output: z.object({ accepted: z.literal(true) }),
  privacy: "private",
  batching: "isolated",
  handler: async () => ({ accepted: true }),
}

const CANDIDATE_TOOL: ToolDefinition = {
  name: "evaluate_calendar_candidate",
  description: "Evaluate one candidate.",
  input: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("one_off"), durationMinutes: z.number().int() }).strict(),
    z.object({
      kind: z.literal("recurring"),
      end: z.discriminatedUnion("mode", [
        z.object({ mode: z.literal("default_horizon") }).strict(),
        z.object({ mode: z.literal("count"), occurrences: z.number().int() }).strict(),
      ]),
    }),
  ]),
  output: z.object({ accepted: z.literal(true) }),
  privacy: "private",
  batching: "isolated",
  handler: async () => ({ accepted: true }),
}

describe("DeepSeek provider", () => {
  beforeEach(() => mockFetch.mockReset())

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("bad auth"),
      json: () => Promise.resolve({ error: { message: "bad auth" } }),
    })

    const { createDeepseekGenerator } = await import("../providers/deepseek")
    const gen = createDeepseekGenerator("bad-key")
    await expect(gen(userMsg("hi"))).rejects.toThrow("DeepSeek API error 401")
  })

  it("retains sanitized native-tool provider validation detail outside the public error message", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: { message: "invalid\n tool schema" } }),
    })

    const { createDeepseekToolClient } = await import("../providers/deepseek")
    const promise = createDeepseekToolClient("key").generate({
      messages: TOOL_TEST_MESSAGES,
      tools: [TOOL_TEST_REGISTRY.echo],
    })
    await expect(promise).rejects.toMatchObject({
      message: "DeepSeek tool request failed (400)",
      providerMessage: "invalid tool schema",
    })
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
    expect((mockFetch.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal)
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

  it("uses a request deadline for DeepSeek tool calls", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: "done" } }], usage: {} }),
    })

    const { createDeepseekToolClient } = await import("../providers/deepseek")
    await createDeepseekToolClient("key", undefined, { requestTimeoutMs: 1_000 }).generate({
      messages: TOOL_TEST_MESSAGES,
      tools: [TOOL_TEST_REGISTRY.echo],
    })

    expect((mockFetch.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal)
  })

  it("emits safe request-boundary events without provider payloads", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          choices: [
            { message: { tool_calls: [{ id: "call-1", function: { name: "echo", arguments: '{"value":"hi"}' } }] } },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 3 },
        }),
    })
    const events: Array<Record<string, unknown>> = []

    const { createDeepseekToolClient } = await import("../providers/deepseek")
    await createDeepseekToolClient("key", undefined, { onRequestEvent: (event) => events.push(event) }).generate({
      messages: TOOL_TEST_MESSAGES,
      tools: [TOOL_TEST_REGISTRY.echo],
    })

    expect(events).toMatchObject([
      { phase: "dispatched", durationMs: 0 },
      { phase: "http-response", status: 200 },
      { phase: "parsed", status: 200, toolCallCount: 1, inputTokens: 2, outputTokens: 3 },
    ])
  })

  it("uses DeepSeek's non-thinking required-tool mode and preserves native reasoning across tool turns", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: "Calling echo.",
                  reasoning_content: "internal reasoning",
                  tool_calls: [{ id: "call-1", function: { name: "echo", arguments: '{"value":"hi"}' } }],
                },
              },
            ],
            usage: {},
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: "done" } }], usage: {} }),
      })
    const { createDeepseekToolClient } = await import("../providers/deepseek")
    const client = createDeepseekToolClient("key")
    const first = await client.generate({
      messages: TOOL_TEST_MESSAGES,
      tools: [TOOL_TEST_REGISTRY.echo],
      toolChoice: "required",
      reasoning: "disabled",
    })
    await client.generate({
      messages: [
        ...TOOL_TEST_MESSAGES,
        {
          role: "assistant",
          toolCalls: first.toolCalls ?? [],
          text: first.text,
          reasoningContent: first.reasoningContent,
        },
        { role: "tool", toolCallId: "call-1", name: "echo", output: { ok: true, output: { value: "hi" } } },
      ],
      tools: [TOOL_TEST_REGISTRY.echo],
    })

    const firstBody = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
    const secondBody = JSON.parse((mockFetch.mock.calls[1][1] as RequestInit).body as string)
    expect(firstBody).toMatchObject({ tool_choice: "required", thinking: { type: "disabled" } })
    expect(secondBody.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: "Calling echo.",
        reasoning_content: "internal reasoning",
      }),
    )
  })

  it("does not mark optional calendar proposal details as required tool inputs", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: "done" } }], usage: {} }),
    })
    const { createDeepseekToolClient } = await import("../providers/deepseek")
    await createDeepseekToolClient("key").generate({ messages: TOOL_TEST_MESSAGES, tools: [SCHEDULING_TOOL] })

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string) as {
      tools: Array<{ function: { parameters: { required: string[] } } }>
    }
    expect(body.tools[0].function.parameters.required).toEqual(["title", "durationMinutes"])
  })

  it("preserves nested provenance objects in native tool declarations", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: "done" } }], usage: {} }),
    })
    const { createDeepseekToolClient } = await import("../providers/deepseek")
    await createDeepseekToolClient("key").generate({ messages: TOOL_TEST_MESSAGES, tools: [PROVENANCE_TOOL] })

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string) as {
      tools: Array<{
        function: {
          parameters: {
            properties: { title: { type: string; properties: Record<string, unknown>; required: string[] } }
          }
        }
      }>
    }
    expect(body.tools[0].function.parameters.properties.title).toEqual({
      type: "object",
      properties: {
        value: { type: "string" },
        source: { type: "string", enum: ["explicit", "inferred"] },
      },
      required: ["value", "source"],
      additionalProperties: false,
    })
  })

  it("projects discriminated Calendar candidates as provider-compatible object alternatives", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: "done" } }], usage: {} }),
    })
    const { createDeepseekToolClient } = await import("../providers/deepseek")
    await createDeepseekToolClient("key").generate({ messages: TOOL_TEST_MESSAGES, tools: [CANDIDATE_TOOL] })

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string) as {
      tools: Array<{ function: { parameters: { anyOf: Array<Record<string, unknown>> } } }>
    }
    expect(body.tools[0].function.parameters).toEqual({
      type: "object",
      anyOf: [
        {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["one_off"] },
            durationMinutes: { type: "integer" },
          },
          required: ["kind", "durationMinutes"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["recurring"] },
            end: {
              anyOf: [
                {
                  type: "object",
                  properties: { mode: { type: "string", enum: ["default_horizon"] } },
                  required: ["mode"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    mode: { type: "string", enum: ["count"] },
                    occurrences: { type: "integer" },
                  },
                  required: ["mode", "occurrences"],
                  additionalProperties: false,
                },
              ],
            },
          },
          required: ["kind", "end"],
          additionalProperties: false,
        },
      ],
    })
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

describe("tool declaration projection", () => {
  it("preserves descriptions on nested union shapes", () => {
    const describedTool: ToolDefinition = {
      ...ECHO_TOOL,
      input: z.object({
        recurrence: z
          .discriminatedUnion("cadence", [
            z
              .object({ cadence: z.literal("weekly") })
              .strict()
              .describe("Weekly shape"),
            z
              .object({ cadence: z.literal("biweekly") })
              .strict()
              .describe("Biweekly shape"),
          ])
          .describe("Choose one cadence shape"),
      }),
    }

    expect(toolDeclaration(describedTool).parameters).toMatchObject({
      properties: {
        recurrence: {
          description: "Choose one cadence shape",
          anyOf: [{ description: "Weekly shape" }, { description: "Biweekly shape" }],
        },
      },
    })
  })

  it("projects z.record shapes to object schemas with additionalProperties", () => {
    const recordTool: ToolDefinition = {
      ...ECHO_TOOL,
      input: z.object({
        grid: z.record(z.string().min(1), z.record(z.string().min(1), z.string())).describe("the week grid"),
      }),
    }
    expect(toolDeclaration(recordTool).parameters).toMatchObject({
      properties: {
        grid: {
          type: "object",
          description: "the week grid",
          additionalProperties: {
            type: "object",
            additionalProperties: { type: "string" },
          },
        },
      },
    })
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
