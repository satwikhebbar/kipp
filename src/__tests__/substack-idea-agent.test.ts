import { describe, expect, it, vi } from "vitest"
import type { ToolProviderClient } from "../providers"
import {
  assembleSubstackIdeaBody,
  createSubstackIdeaConversation,
  runSubstackIdeaToolSession,
} from "../substack/idea-agent"

const article = {
  title: "Article title",
  subtitle: "Article subtitle",
  sourceUrl: "https://example.substack.com/p/article",
  sections: [
    { heading: null, content: "Opening context." },
    { heading: "A useful section", content: "Author's first paragraph.\n\nAuthor's second paragraph." },
  ],
}

function providerWith(...responses: Awaited<ReturnType<ToolProviderClient["generate"]>>[]): ToolProviderClient {
  return { generate: vi.fn().mockImplementation(async () => responses.shift()) }
}

const validIdeas = [
  {
    title: "Working title",
    context: "Required context.",
    excerpt: "Author's first paragraph.\n\nAuthor's second paragraph.",
    coreArgument: "The core argument.",
    viralityScore: 8,
    scoreJustification: "A concrete professional tension with a useful, source-grounded reframing.",
  },
]

describe("Substack idea native-tool agent", () => {
  it("receives the complete parsed article in its initial user message and accepts a valid submission", async () => {
    const provider = providerWith({
      toolCalls: [{ id: "submit", name: "submit_substack_ideas", input: { ideas: validIdeas } }],
      usage: { inputTokens: 11, outputTokens: 7 },
    })

    const result = await runSubstackIdeaToolSession(provider, article)

    expect(result.terminal).toEqual({ kind: "ideas_ready", ideas: validIdeas })
    const firstRequest = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(firstRequest.tools).toEqual([expect.objectContaining({ name: "submit_substack_ideas" })])
    expect(firstRequest.messages.slice(0, 2)).toEqual(createSubstackIdeaConversation(article))
    expect(firstRequest.messages[0]).toEqual(
      expect.objectContaining({ text: expect.stringContaining("title (string), excerpt (string)") }),
    )
  })

  it("returns schema feedback to the provider and accepts a repaired submission", async () => {
    const provider = providerWith(
      {
        toolCalls: [
          {
            id: "invalid",
            name: "submit_substack_ideas",
            input: { ideas: [{ ...validIdeas[0], excerpt: [] }] },
          },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      {
        toolCalls: [{ id: "repaired", name: "submit_substack_ideas", input: { ideas: validIdeas } }],
        usage: { inputTokens: 2, outputTokens: 2 },
      },
    )

    const result = await runSubstackIdeaToolSession(provider, article)

    expect(result.terminal).toEqual({ kind: "ideas_ready", ideas: validIdeas })
    expect(result.toolExecutions).toEqual([
      expect.objectContaining({ outcome: "failed", failureCategory: "invalid-input" }),
      expect.objectContaining({ outcome: "succeeded" }),
    ])
    expect(provider.generate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "tool", output: expect.objectContaining({ category: "invalid-input" }) }),
        ]),
      }),
    )
  })

  it("accepts a descriptive title without an arbitrary length cap", async () => {
    const longTitle =
      "A deliberately descriptive working title that remains useful even when it runs well past eighty characters"
    const result = await runSubstackIdeaToolSession(
      providerWith({
        toolCalls: [
          { id: "submit", name: "submit_substack_ideas", input: { ideas: [{ ...validIdeas[0], title: longTitle }] } },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
      article,
    )

    expect(result.terminal).toEqual({ kind: "ideas_ready", ideas: [{ ...validIdeas[0], title: longTitle }] })
  })

  it("rejects candidates that duplicate a title, argument, or passage set", async () => {
    const duplicate = [{ ...validIdeas[0] }, { ...validIdeas[0], context: "Different context." }]
    const response = {
      toolCalls: [{ id: "duplicate", name: "submit_substack_ideas", input: { ideas: duplicate } }],
      usage: { inputTokens: 1, outputTokens: 1 },
    }
    const result = await runSubstackIdeaToolSession(providerWith(response, response, response), article)

    expect(result.terminal).toBeNull()
    expect(result.toolExecutions).toEqual(
      expect.arrayContaining([expect.objectContaining({ outcome: "failed", failureCategory: "invalid-input" })]),
    )
  })

  it("rejects a missing or overly long score justification", async () => {
    const { scoreJustification: _, ...missingJustification } = validIdeas[0]
    const tooLongJustification = { ...validIdeas[0], scoreJustification: "x".repeat(281) }
    const result = await runSubstackIdeaToolSession(
      providerWith(
        {
          toolCalls: [{ id: "missing", name: "submit_substack_ideas", input: { ideas: [missingJustification] } }],
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        {
          toolCalls: [{ id: "long", name: "submit_substack_ideas", input: { ideas: [tooLongJustification] } }],
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        {
          toolCalls: [{ id: "long-again", name: "submit_substack_ideas", input: { ideas: [tooLongJustification] } }],
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      ),
      article,
    )

    expect(result.terminal).toBeNull()
    expect(result.toolExecutions).toEqual(
      expect.arrayContaining([expect.objectContaining({ outcome: "failed", failureCategory: "invalid-input" })]),
    )
  })

  it("assembles the raw body without template labels or truncation", () => {
    expect(assembleSubstackIdeaBody(validIdeas[0])).toBe(
      "Required context.\n\nAuthor's first paragraph.\n\nAuthor's second paragraph.\n\nThe core argument.",
    )
  })

  it("keeps only the highest-scoring candidates at or above the saving threshold", async () => {
    const { selectSubstackIdeas } = await import("../substack/idea-agent")
    const selected = selectSubstackIdeas([
      { ...validIdeas[0], title: "Below threshold", viralityScore: 4 },
      { ...validIdeas[0], title: "Six", viralityScore: 6 },
      { ...validIdeas[0], title: "Ten", viralityScore: 10 },
      { ...validIdeas[0], title: "Seven", viralityScore: 7 },
      { ...validIdeas[0], title: "Eight", viralityScore: 8 },
      { ...validIdeas[0], title: "Nine", viralityScore: 9 },
      { ...validIdeas[0], title: "Five", viralityScore: 5 },
      { ...validIdeas[0], title: "Extra", viralityScore: 6 },
    ])

    expect(selected.map((idea) => idea.title)).toEqual(["Ten", "Nine", "Eight", "Seven", "Six"])
  })
})
