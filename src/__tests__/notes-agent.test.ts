import { expect, it, vi } from "vitest"
import { createNotesConversation, runNotesSession } from "../agent/notes"
import type { ToolProviderClient } from "../providers"

it("exposes only a review handoff, separates commentary, and uses the configured style prompt", async () => {
  const generate = vi.fn(async (_request: Parameters<ToolProviderClient["generate"]>[0]) => ({
    toolCalls: [
      {
        id: "1",
        name: "submit_note",
        input: { commentary: "Why this hook.", text: "Exact *Note*.", timing: { kind: "unchanged" } },
      },
    ],
    usage: { inputTokens: 10, outputTokens: 20 },
  }))
  const messages = createNotesConversation("Audience: builders. Voice: plain.", "Small steps teach us faster.")
  const result = await runNotesSession({ generate } as ToolProviderClient, messages)
  expect(result.draft).toEqual({
    commentary: "Why this hook.",
    text: "Exact *Note*.",
    linkCardAction: "keep",
    timing: { kind: "unchanged" },
  })
  expect(messages[0]).toMatchObject({ text: expect.stringContaining("Audience: builders.") })
  expect(generate.mock.calls[0][0].tools.map((tool: { name: string }) => tool.name)).toEqual([
    "submit_note",
    "ask_note_question",
  ])
  expect(generate.mock.calls[0][0].reasoning).toBe("disabled")
  expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 })
})

it("bounds malformed or prose-only sessions without publication authority", async () => {
  const generate = vi.fn(async () => ({ text: "Published!", usage: { inputTokens: 1, outputTokens: 1 } }))
  const result = await runNotesSession({ generate }, createNotesConversation("plain", "thought"))
  expect(generate).toHaveBeenCalledTimes(3)
  expect(result.draft).toBeNull()
  expect(result.completed).toBe(false)
})

it("rejects oversized transcripts before provider dispatch", async () => {
  const generate = vi.fn()
  await expect(runNotesSession({ generate }, [{ role: "user", text: "a".repeat(100_001) }])).rejects.toThrow(
    "transcript limit",
  )
  expect(generate).not.toHaveBeenCalled()
})

it("hands off a necessary clarification without creating a draft", async () => {
  const result = await runNotesSession(
    {
      generate: async () => ({
        toolCalls: [{ id: "q", name: "ask_note_question", input: { question: "Which experiment do you mean?" } }],
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    },
    createNotesConversation("plain", "That experiment"),
  )
  expect(result.question).toBe("Which experiment do you mean?")
  expect(result.draft).toBeNull()
  expect(result.completed).toBe(true)
})

it("names link card actions and extracts publication timing separately", async () => {
  const messages = createNotesConversation("plain", "thoughts")
  expect(messages[0]).toMatchObject({ text: expect.stringContaining("linkCardAction controls the embedded link card") })
  expect(messages[0]).not.toMatchObject({ text: expect.stringContaining("ask them to confirm immediate publication") })
  const generate = vi.fn(async () => ({
    toolCalls: [
      {
        id: "1",
        name: "submit_note",
        input: {
          commentary: "A clear idea.",
          text: "A brief Note.",
          linkCardAction: "remove",
          timing: { kind: "unchanged" },
        },
      },
    ],
    usage: { inputTokens: 1, outputTokens: 1 },
  }))
  expect((await runNotesSession({ generate }, messages)).draft?.linkCardAction).toBe("remove")
})

it("accepts structured elapsed durations and instructs extraction without clock arithmetic", async () => {
  const messages = createNotesConversation("plain", "Publish this three hours later.")
  expect(messages[0]).toMatchObject({ text: expect.stringContaining("Use relative-duration for elapsed delays") })
  const result = await runNotesSession(
    {
      generate: async () => ({
        toolCalls: [
          {
            id: "relative",
            name: "submit_note",
            input: {
              commentary: "Kept the idea.",
              text: "A useful thought.",
              timing: { kind: "relative-duration", minutes: 180, source: "current", timeZone: null },
            },
          },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    },
    messages,
  )
  expect(result.completed).toBe(true)
  expect(result.draft?.timing).toEqual({ kind: "relative-duration", minutes: 180, source: "current", timeZone: null })
  expect(result.question).toBeNull()
})
