import { describe, expect, it, vi } from "vitest"
import { appendLinkedInFeedback, createLinkedInConversation, runLinkedInToolSession } from "../agent/linkedin"
import type { ToolProviderClient } from "../providers"

function providerWith(...responses: Awaited<ReturnType<ToolProviderClient["generate"]>>[]): ToolProviderClient {
  return { generate: vi.fn().mockImplementation(async () => responses.shift()) }
}

describe("LinkedIn native-tool agent", () => {
  it("submits a trimmed draft through the one workflow-scoped handoff tool", async () => {
    const provider = providerWith({
      toolCalls: [{ id: "draft-1", name: "submit_linkedin_draft", input: { draft: "  Final draft  " } }],
      usage: { inputTokens: 11, outputTokens: 7 },
    })

    const result = await runLinkedInToolSession(
      provider,
      createLinkedInConversation("Use crisp sentences.", { title: "Typed tools", body: "Source material" }),
    )

    expect(result.completed).toBe(true)
    expect(result.draft).toBe("Final draft")
    expect(result.toolNames).toEqual(["submit_linkedin_draft"])
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7 })
    expect(provider.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        toolChoice: "required",
        reasoning: "disabled",
        tools: [expect.objectContaining({ name: "submit_linkedin_draft" })],
      }),
    )
  })

  it("preserves the native transcript and appends real revision feedback", async () => {
    const initial = createLinkedInConversation("Professional tone.", {
      title: "First title",
      body: "First body",
    })
    const first = await runLinkedInToolSession(
      providerWith({
        toolCalls: [{ id: "first", name: "submit_linkedin_draft", input: { draft: "First draft" } }],
        usage: { inputTokens: 5, outputTokens: 3 },
      }),
      initial,
    )
    const revisedInput = appendLinkedInFeedback(first.messages, "Make it shorter")
    const revisionProvider = providerWith({
      toolCalls: [{ id: "second", name: "submit_linkedin_draft", input: { draft: "Short draft" } }],
      usage: { inputTokens: 9, outputTokens: 4 },
    })

    const second = await runLinkedInToolSession(revisionProvider, revisedInput)

    expect(second.draft).toBe("Short draft")
    expect(revisedInput.at(-1)).toEqual({ role: "user", text: "Make it shorter" })
    expect(revisionProvider.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            toolCalls: [expect.objectContaining({ name: "submit_linkedin_draft" })],
          }),
          {
            role: "tool",
            toolCallId: "first",
            name: "submit_linkedin_draft",
            output: { ok: true, output: { accepted: true } },
          },
          { role: "user", text: "Make it shorter" },
        ]),
      }),
    )
  })

  it("repairs a prose-only response and aggregates usage across provider turns", async () => {
    const result = await runLinkedInToolSession(
      providerWith(
        { text: "Here is a draft.", usage: { inputTokens: 4, outputTokens: 2 } },
        {
          toolCalls: [{ id: "repair", name: "submit_linkedin_draft", input: { draft: "Repaired draft" } }],
          usage: { inputTokens: 6, outputTokens: 3 },
        },
      ),
      createLinkedInConversation("Direct.", { body: "Topic" }),
    )

    expect(result.draft).toBe("Repaired draft")
    expect(result.providerTurns).toBe(2)
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
  })

  it("denies hallucinated publishing and fails closed without a candidate", async () => {
    const denied = {
      toolCalls: [{ id: "publish", name: "publish_linkedin_draft", input: { draft: "Unsafe" } }],
      usage: { inputTokens: 1, outputTokens: 1 },
    }
    const result = await runLinkedInToolSession(
      providerWith(denied, denied, denied),
      createLinkedInConversation("Direct.", { body: "Topic" }),
    )

    expect(result.completed).toBe(false)
    expect(result.draft).toBeNull()
    expect(result.failureReason).toBe("provider-turn-limit")
    expect(result.toolExecutions).toEqual([
      expect.objectContaining({ tool: "unknown", outcome: "failed", failureCategory: "unknown-tool" }),
      expect.objectContaining({ tool: "unknown", outcome: "failed", failureCategory: "unknown-tool" }),
      expect.objectContaining({ tool: "unknown", outcome: "failed", failureCategory: "unknown-tool" }),
    ])
  })

  it("rejects empty draft input and never exposes a publishing declaration", async () => {
    const provider = providerWith(
      {
        toolCalls: [{ id: "empty", name: "submit_linkedin_draft", input: { draft: "   " } }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      {
        toolCalls: [{ id: "empty-2", name: "submit_linkedin_draft", input: { draft: "" } }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      {
        toolCalls: [{ id: "empty-3", name: "submit_linkedin_draft", input: { draft: "" } }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    )

    const result = await runLinkedInToolSession(provider, createLinkedInConversation("Direct.", { body: "Topic" }))

    expect(result.draft).toBeNull()
    expect(result.toolExecutions[0]).toEqual(
      expect.objectContaining({ outcome: "failed", failureCategory: "invalid-input" }),
    )
    expect(provider.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.not.arrayContaining([expect.objectContaining({ name: "publish_linkedin_draft" })]),
      }),
    )
  })
})
