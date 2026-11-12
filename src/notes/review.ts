import { type BufferCreateCommand, notesEventSchema } from "./types"

const HEX_RADIX = 16
const HIGH_SURROGATE_START = 0xd800
const HIGH_SURROGATE_END = 0xdbff

/** Hashes the exact versioned publication tuple, excluding commentary and presentation. */
export async function fingerprintCommand(command: BufferCreateCommand): Promise<string> {
  const d = command.destination
  const canonical = JSON.stringify([
    1,
    command.text,
    command.attachmentUrl,
    d.accountId,
    d.connectionId,
    d.organizationId,
    d.channelId,
    d.service,
    command.timing.kind,
  ])
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(HEX_RADIX).padStart(2, "0")).join("")
}

/** Splits Telegram text losslessly without dividing a UTF-16 surrogate pair. */
export function splitNote(text: string, limit = 4000): string[] {
  if (limit < 2) throw new Error("Invalid message limit")
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > limit) {
    let end = limit
    const code = remaining.charCodeAt(end - 1)
    if (code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END) end--
    chunks.push(remaining.slice(0, end))
    remaining = remaining.slice(end)
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

/** Validates independent owner, candidate, action and fixed-deadline authority. Text cannot approve. */
export function authorizedNotesEvent(
  input: unknown,
  expected: {
    workflowId: string
    userId: string
    chatId: string
    version: number
    fingerprint: string
    actions: Record<string, string>
    deadlineMs: number
  },
  now = Date.now(),
) {
  const parsed = notesEventSchema.safeParse(input)
  if (!parsed.success) return null
  const event = parsed.data
  if (
    now >= expected.deadlineMs ||
    event.receivedAtMs >= expected.deadlineMs ||
    event.receivedAtMs > now ||
    event.workflowId !== expected.workflowId ||
    event.userId !== expected.userId ||
    event.chatId !== expected.chatId ||
    event.version !== expected.version ||
    event.fingerprint !== expected.fingerprint ||
    expected.actions[event.interactionId] !== event.kind
  )
    return null
  return event
}
