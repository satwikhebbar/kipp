import { describe, expect, it } from "vitest"
import { authorizedNotesEvent, fingerprintCommand, splitNote } from "../notes/review"
import { type BufferCreateCommand, commandSchema } from "../notes/types"

const noteCommand: BufferCreateCommand = {
  destination: {
    accountId: "account",
    connectionId: "connection",
    organizationId: "org",
    channelId: "channel",
    service: "substack",
  },
  text: "Keep *this* exact. 😀",
  attachmentUrl: null,
  timing: { kind: "now" },
}
const expected = {
  workflowId: "wf",
  userId: "42",
  chatId: "100",
  version: 1,
  fingerprint: "hash",
  actions: { action: "notes-publish" },
  deadlineMs: 1000,
}
const event = {
  deliveryId: "delivery",
  workflowId: "wf",
  userId: "42",
  chatId: "100",
  version: 1,
  fingerprint: "hash",
  interactionId: "action",
  kind: "notes-publish",
  telegramUpdateId: 5,
  receivedAtMs: 100,
}

describe("Notes review authority", () => {
  it("fingerprints exact text and destination independently of property insertion order", async () => {
    const original = await fingerprintCommand(noteCommand)
    expect(await fingerprintCommand({ ...noteCommand, text: `${noteCommand.text} ` })).not.toBe(original)
    for (const field of ["accountId", "connectionId", "organizationId", "channelId"] as const)
      expect(
        await fingerprintCommand({ ...noteCommand, destination: { ...noteCommand.destination, [field]: "other" } }),
      ).not.toBe(original)
    expect(await fingerprintCommand({ ...noteCommand, destination: { ...noteCommand.destination } })).toBe(original)
  })
  it.each([
    { userId: "43" },
    { chatId: "101" },
    { workflowId: "other" },
    { version: 2 },
    { fingerprint: "other" },
    { interactionId: "other" },
    { kind: "notes-feedback" },
    { receivedAtMs: 1000 },
    { kind: "notes-publish", text: "__approve__", interactionId: "unknown" },
  ])("rejects changed authority %j", (patch) => {
    expect(authorizedNotesEvent({ ...event, ...patch }, expected, 500)).toBeNull()
  })
  it("requires a live exact action and rejects arbitrary text and expiry", () => {
    expect(authorizedNotesEvent(event, expected, 500)).toEqual(event)
    expect(authorizedNotesEvent(event, expected, 1000)).toBeNull()
    expect(authorizedNotesEvent("publish", expected, 500)).toBeNull()
  })
  it("splits text losslessly while preserving emoji and Markdown-looking characters", () => {
    const text = `${"a".repeat(3999)}😀 *literal*\n\n${"b".repeat(5000)}`
    const chunks = splitNote(text)
    expect(chunks.join("")).toBe(text)
    expect(chunks[0]).toHaveLength(3999)
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true)
    expect(chunks[1].startsWith("😀")).toBe(true)
  })
  it("does not silently accept later-phase links or timing commands", () => {
    expect(commandSchema.safeParse({ ...noteCommand, attachmentUrl: "https://example.com" }).success).toBe(false)
    expect(commandSchema.safeParse({ ...noteCommand, timing: { kind: "queue" } }).success).toBe(false)
    expect(commandSchema.safeParse({ ...noteCommand, timing: { kind: "now", dueAt: "later" } }).success).toBe(false)
  })
})
