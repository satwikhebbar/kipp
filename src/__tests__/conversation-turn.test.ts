import { describe, expect, it, vi } from "vitest"
import { presentConversationTurn, renderConversationTurn, splitConversationText } from "../core/conversation-presenter"
import { type ConversationTurn, createConversationTurn } from "../core/conversation-turn"

const controls = {
  kind: "inline",
  rows: [[{ intent: "approve", label: "Approve", callbackToken: "opaque-token" }]],
} as const
const review: ConversationTurn = {
  kind: "review",
  sections: ["Commentary", "Timing", "─── Draft ───\n\nLiteral *draft*"],
  controls,
}

describe("conversation presenter", () => {
  it("combines ordered sections with clear separators in one literal message", () => {
    expect(renderConversationTurn(review)).toEqual([
      {
        text: "Commentary\n\nTiming\n\n─── Draft ───\n\nLiteral *draft*",
        options: {
          plainText: true,
          disableLinkPreview: true,
          replyMarkup: { inline_keyboard: [[{ text: "Approve", callback_data: "opaque-token" }]] },
        },
      },
    ])
  })

  it.each([
    3999, 4000, 4001, 8000, 8001,
  ])("preserves all %i characters and attaches controls only to the final part", (size) => {
    const text = "x".repeat(size)
    const parts = renderConversationTurn({ kind: "review", sections: [text], controls })
    expect(parts).toHaveLength(Math.ceil(size / 4000))
    expect(parts.map((part) => part.text).join("")).toBe(text)
    expect(parts.every((part) => part.text.length <= 4000)).toBe(true)
    expect(parts.slice(0, -1).every((part) => !part.options.replyMarkup)).toBe(true)
    expect(parts.at(-1)?.options.replyMarkup).toBeDefined()
  })

  it("preserves whitespace, links and emoji across a surrogate boundary", () => {
    const text = `${"a".repeat(3999)}😀\n\n  https://example.com/?a=1&b=2\n `
    const parts = splitConversationText(text)
    expect(parts[0]).toHaveLength(3999)
    expect(parts[1].startsWith("😀")).toBe(true)
    expect(parts.join("")).toBe(text)
  })

  it("keeps a draft section intact when commentary makes the combined review too long", () => {
    const commentary = "c".repeat(1500)
    const draft = `─── Draft ───\n\n${"d".repeat(2900)}`
    const parts = renderConversationTurn({ kind: "review", sections: [commentary, draft], controls })
    expect(parts.map((part) => part.text)).toEqual([`${commentary}\n\n`, draft])
    expect(parts[0].options.replyMarkup).toBeUndefined()
    expect(parts[1].options.replyMarkup).toBeDefined()
  })

  it.each([3999, 4000, 7999, 8000])("does not send a separator-only message after a %i-character section", (length) => {
    const sections = ["x".repeat(length), "Draft body"]
    const parts = renderConversationTurn({ kind: "review", sections })
    expect(parts.every((part) => part.text.trim().length > 0 && part.text.length <= 4000)).toBe(true)
    expect(parts.map((part) => part.text).join("")).toBe(sections.join("\n\n"))
  })

  it("splits clarification too, placing force-reply only on its final part", () => {
    const parts = renderConversationTurn({
      kind: "clarification",
      message: `${"a".repeat(4000)}What time?`,
      controls: { kind: "reply" },
    })
    expect(parts[0].options.replyMarkup).toBeUndefined()
    expect(parts[1].options.replyMarkup).toEqual({ force_reply: true })
  })

  it("offers connection links and resume without approval", () => {
    const parts = renderConversationTurn({
      kind: "connection",
      message: "Connect, then Continue.",
      controls: {
        kind: "inline",
        rows: [
          [{ intent: "link", label: "Connect", url: "https://example.com/setup" }],
          [
            { intent: "resume", label: "Continue", callbackToken: "resume" },
            { intent: "cancel", label: "Cancel", callbackToken: "cancel" },
          ],
        ],
      },
    })
    expect(parts[0].options.replyMarkup).toEqual({
      inline_keyboard: [
        [{ text: "Connect", url: "https://example.com/setup" }],
        [{ text: "Continue", callback_data: "resume" }],
        [{ text: "Cancel", callback_data: "cancel" }],
      ],
    })
  })

  it("rejects an untyped connection/approval combination before delivering any part", async () => {
    const deliver = vi.fn()
    const invalid = { kind: "connection", message: "Connect", controls } as unknown as ConversationTurn
    await expect(presentConversationTurn(invalid, deliver)).rejects.toThrow("cannot offer approval")
    expect(deliver).not.toHaveBeenCalled()
  })

  it.each(["", "  \n "])("rejects an empty response %j before sending", (message) => {
    expect(() => renderConversationTurn({ kind: "failure", message })).toThrow("must not be empty")
  })

  it.each([1, 0, -1, 2.5, 4001, Number.NaN])("rejects invalid split limits %s", (limit) => {
    expect(() => splitConversationText("text", limit)).toThrow("Invalid")
  })

  it("returns all message IDs in delivery order for workflow reply binding", async () => {
    const seen: number[] = []
    const sent = await presentConversationTurn(
      { kind: "review", sections: ["x".repeat(8001)] },
      async (_message, index) => {
        seen.push(index)
        await Promise.resolve()
        expect(seen).toHaveLength(index + 1)
        return { messageId: index + 10 }
      },
    )
    expect(sent).toEqual([{ messageId: 10 }, { messageId: 11 }, { messageId: 12 }])
  })

  it("stops on a failed part, preserving the transport error for durable retry", async () => {
    const error = new Error("transport interrupted")
    const deliver = vi.fn().mockResolvedValueOnce({ messageId: 1 }).mockRejectedValueOnce(error)
    await expect(presentConversationTurn({ kind: "review", sections: ["x".repeat(8001)] }, deliver)).rejects.toBe(error)
    expect(deliver).toHaveBeenCalledTimes(2)
  })
})

describe("exclusive conversation turn", () => {
  const turns: ConversationTurn[] = [
    { kind: "connection", message: "Connect" },
    { kind: "clarification", message: "Which time?" },
    review,
    { kind: "confirmation", message: "Accepted" },
    { kind: "failure", message: "Failed" },
  ]
  it.each(
    turns.map((first) => [first.kind, first] as const),
  )("prevents every competing response after %s", async (_name, first) => {
    const turn = createConversationTurn()
    const send = vi.fn().mockResolvedValue({ messageId: 1 })
    await turn.respond(first, send)
    for (const next of turns) await expect(turn.respond(next, send)).rejects.toThrow("already reserved")
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("reserves synchronously before pending delivery so simultaneous responses cannot both send", async () => {
    const turn = createConversationTurn()
    let finish!: () => void
    const pending = turn.respond(
      { kind: "connection", message: "Connect" },
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const competing = vi.fn()
    await expect(turn.respond(review, competing)).rejects.toThrow("already reserved for connection")
    expect(competing).not.toHaveBeenCalled()
    finish()
    await pending
  })

  it("does not release a failed response to send a contradictory alternative", async () => {
    const turn = createConversationTurn()
    await expect(
      turn.respond(review, async () => {
        throw new Error("send failed")
      }),
    ).rejects.toThrow("send failed")
    await expect(turn.respond({ kind: "connection", message: "Connect" }, vi.fn())).rejects.toThrow("already reserved")
  })

  it("allows review on the next accepted input without reusing the connection turn", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 1 })
    await createConversationTurn().respond({ kind: "connection", message: "Connect" }, send)
    await createConversationTurn().respond(review, send)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it("reconstructs the reservation when checkpoint delivery is replayed from cache", async () => {
    let cached: unknown
    const send = vi.fn().mockResolvedValue({ messageId: 1 })
    for (let replay = 0; replay < 2; replay++) {
      const turn = createConversationTurn()
      turn.claim("connection") // Outside the checkpoint, on every replay.
      cached ??= await presentConversationTurn({ kind: "connection", message: "Connect" }, send)
      expect(cached).toEqual([{ messageId: 1 }])
      await expect(turn.respond(review, send)).rejects.toThrow("already reserved")
    }
    expect(send).toHaveBeenCalledTimes(1)
  })
})
