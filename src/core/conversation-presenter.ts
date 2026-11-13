import type { ConversationControls, ConversationTurn } from "./conversation-turn"

const TELEGRAM_MESSAGE_LIMIT = 4000
const HIGH_SURROGATE_START = 0xd800
const HIGH_SURROGATE_END = 0xdbff

export interface ConversationMessage {
  text: string
  options: {
    plainText: true
    disableLinkPreview: true
    replyMarkup?: Record<string, unknown>
  }
}

/** Splits literal text losslessly, leaving headroom below Telegram's limit and preserving surrogate pairs. */
export function splitConversationText(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (!Number.isInteger(limit) || limit < 2 || limit > TELEGRAM_MESSAGE_LIMIT)
    throw new Error("Invalid conversation message limit")
  const chunks: string[] = []
  let offset = 0
  while (text.length - offset > limit) {
    let end = offset + limit
    const code = text.charCodeAt(end - 1)
    if (code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END) end--
    chunks.push(text.slice(offset, end))
    offset = end
  }
  if (offset < text.length) chunks.push(text.slice(offset))
  return chunks
}

/** Converts semantic controls to Telegram markup without granting any application authority. */
function controlMarkup(controls: ConversationControls): Record<string, unknown> {
  if (controls.kind === "reply") return { force_reply: true }
  return {
    inline_keyboard: controls.rows.map((row) =>
      row.map((action) =>
        action.intent === "link"
          ? { text: action.label, url: action.url }
          : { text: action.label, callback_data: action.callbackToken },
      ),
    ),
  }
}

/** Keeps a section intact when it fits a message, preserving every separator across split parts. */
function reviewChunks(sections: readonly string[]): string[] {
  const chunks: string[] = []
  let pending = ""
  for (const section of sections.filter((section) => section.length > 0)) {
    if (
      pending &&
      pending.length + 2 + section.length > TELEGRAM_MESSAGE_LIMIT &&
      section.length <= TELEGRAM_MESSAGE_LIMIT
    ) {
      const previous = splitConversationText(pending)
      const last = previous.length - 1
      // Avoid emitting a separator-only message when the previous section exactly fills a part.
      if (previous[last].length + 2 <= TELEGRAM_MESSAGE_LIMIT) {
        previous[last] += "\n\n"
        pending = section
      } else {
        pending = `\n\n${section}`
      }
      chunks.push(...previous)
    } else {
      pending += `${pending ? "\n\n" : ""}${section}`
    }
  }
  chunks.push(...splitConversationText(pending))
  return chunks
}

/** Composes one response, splitting only on size; controls always accompany its final part. */
export function renderConversationTurn(turn: ConversationTurn): ConversationMessage[] {
  // Also defend untyped callers before any part is sent.
  if (
    turn.kind === "connection" &&
    turn.controls?.kind === "inline" &&
    turn.controls.rows.some((row) =>
      row.some((action) => !["link", "resume", "cancel", "revise"].includes(action.intent)),
    )
  )
    throw new Error("Connection turns cannot offer approval controls")
  const text =
    turn.kind === "review" ? turn.sections.filter((section) => section.length > 0).join("\n\n") : turn.message
  if (!text.trim()) throw new Error("Conversation response must not be empty")
  const chunks = turn.kind === "review" ? reviewChunks(turn.sections) : splitConversationText(text)
  return chunks.map((text, index) => ({
    text,
    options: {
      plainText: true,
      disableLinkPreview: true,
      ...(turn.controls && index === chunks.length - 1 ? { replyMarkup: controlMarkup(turn.controls) } : {}),
    },
  }))
}

/** Delivers sequentially through caller-owned checkpoints and returns every result for reply binding. */
export async function presentConversationTurn<T>(
  turn: ConversationTurn,
  deliver: (message: ConversationMessage, index: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = []
  for (const [index, message] of renderConversationTurn(turn).entries()) results.push(await deliver(message, index))
  return results
}
