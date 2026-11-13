import { type BufferCreateCommand, notesEventSchema } from "./types"

const HEX_RADIX = 16

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
    ...(command.timing.kind === "schedule" ? [command.timing.dueAt, command.timing.timeZone] : []),
  ])
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(HEX_RADIX).padStart(2, "0")).join("")
}

/** Splits Telegram text losslessly without dividing a UTF-16 surrogate pair. */
export { splitConversationText as splitNote } from "../core/conversation-presenter"

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
