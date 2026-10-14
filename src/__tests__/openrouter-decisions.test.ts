import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ToolProviderRequestEvent } from "../providers/llm"
import { createOpenRouterDecisionsClient } from "../providers/openrouter-decisions"

const mockFetch = vi.hoisted(() => vi.fn())
vi.stubGlobal("fetch", mockFetch)

const NOUL_QUESTIONS = { is_ordinary: { type: "noul" as const, instructions: "Is it ordinary?" } }

describe("OpenRouter Decisions client", () => {
  beforeEach(() => mockFetch.mockReset())

  it("posts the decisions request and reads the returned cost", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          id: "gen-dec-1",
          model: "openai/gpt-6-luna-decisions-20261006",
          provider: "OpenAI",
          answers: { is_ordinary: { type: "noul", noul: 0.96 } },
          usage: { input_tokens: 120, output_tokens: 0, cost: 0.000012 },
        }),
    })
    const events: ToolProviderRequestEvent[] = []
    const client = createOpenRouterDecisionsClient("key", undefined, { onRequestEvent: (event) => events.push(event) })
    const result = await client.decide({ state: "policy", questions: NOUL_QUESTIONS })
    expect(result.answers.is_ordinary).toEqual({ type: "noul", noul: 0.96 })
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 0, costUsd: 0.000012 })
    expect(result.model).toBe("openai/gpt-6-luna-decisions-20261006")
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer key")
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ model: "openai/gpt-6-luna-decisions", state: "policy" })
    expect(body.questions.is_ordinary.type).toBe("noul")
    expect(events.at(-1)).toMatchObject({ phase: "parsed", inputTokens: 120, outputTokens: 0 })
  })

  it("parses choice and score answers with optional probabilities", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          answers: {
            team: { type: "choice", choice: "payments", probabilities: { payments: 0.8, other: 0.2 }, confidence: 0.6 },
            urgency: { type: "score", score: 1.99, legend: { 0: "low", 1: "high" }, probabilities: { 0: 0, 1: 1 } },
          },
          usage: {},
        }),
    })
    const client = createOpenRouterDecisionsClient("key")
    const result = await client.decide({
      state: { ticket: "x" },
      questions: {
        team: { type: "choice", instructions: "Which team?", criteria: { payments: "billing", other: "none" } },
        urgency: { type: "score", instructions: "How urgent?", criteria: ["low", "high"] },
      },
    })
    expect(result.answers.team).toEqual({
      type: "choice",
      choice: "payments",
      probabilities: { payments: 0.8, other: 0.2 },
      confidence: 0.6,
    })
    expect(result.answers.urgency).toEqual({
      type: "score",
      score: 1.99,
      legend: { 0: "low", 1: "high" },
      probabilities: { 0: 0, 1: 1 },
    })
  })

  it("treats a missing or wrong-type answer as a protocol error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ answers: { is_ordinary: { type: "score", score: 1 } }, usage: {} }),
    })
    const client = createOpenRouterDecisionsClient("key")
    await expect(client.decide({ state: "policy", questions: NOUL_QUESTIONS })).rejects.toThrow(
      /missing or has an unexpected type/,
    )
  })

  it("surfaces an HTTP failure as a typed provider error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: () => Promise.resolve({ error: { message: "rate limited" } }),
    })
    const client = createOpenRouterDecisionsClient("key")
    await expect(client.decide({ state: "policy", questions: NOUL_QUESTIONS })).rejects.toThrow(
      "OpenRouter tool request failed (429)",
    )
  })
})
