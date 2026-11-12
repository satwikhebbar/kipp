import { expect, it, vi } from "vitest"
import { createNotesConversation, runNotesSession } from "../agent/notes"
import type { ToolProviderClient } from "../providers"

it("exposes only a review handoff, separates commentary, and uses the configured style prompt", async () => {
  const generate = vi.fn(async (_request: Parameters<ToolProviderClient["generate"]>[0]) => ({
    toolCalls: [{ id: "1", name: "submit_note", input: { commentary: "Why this hook.", text: "Exact *Note*." } }],
    usage: { inputTokens: 10, outputTokens: 20 },
  }))
  const messages = createNotesConversation("Audience: builders. Voice: plain.", "Small steps teach us faster.")
  const result = await runNotesSession({ generate } as ToolProviderClient, messages)
  expect(result.draft).toEqual({ commentary: "Why this hook.", text: "Exact *Note*." })
  expect(messages[0]).toMatchObject({ text: expect.stringContaining("Audience: builders.") })
  expect(generate.mock.calls[0][0].tools.map((tool: { name: string }) => tool.name)).toEqual(["submit_note"])
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
