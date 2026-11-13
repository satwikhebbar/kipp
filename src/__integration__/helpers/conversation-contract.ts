import { expect } from "vitest"

interface Message {
  text: string
  replyMarkup?: Record<string, unknown>
}

/** Shared observable UX contract, applied to messages from real workflow/webhook journeys. */
export function expectConversationResponse(
  messages: Message[],
  kind: "connection" | "review" | "clarification" | "confirmation",
  sections: string[] = [],
): void {
  expect(messages.length).toBeGreaterThan(0)
  const text = messages.map((message) => message.text).join("")
  if (text.length <= 4000) expect(messages).toHaveLength(1)
  expect(messages.every((message) => message.text.length <= 4000)).toBe(true)
  expect(messages.slice(0, -1).every((message) => !message.replyMarkup)).toBe(true)
  const keyboard = messages.at(-1)?.replyMarkup?.inline_keyboard as unknown[][] | undefined
  if (keyboard) expect(keyboard.every((row) => row.length === 1)).toBe(true)
  let previous = -1
  for (const section of sections) {
    const index = text.indexOf(section, previous + 1)
    expect(index).toBeGreaterThan(previous)
    previous = index
  }
  if (kind === "connection") {
    expect(text).not.toContain("─── Note ───")
    expect(text).not.toContain("Will be posted as a LinkedIn draft:")
    const rows = messages.at(-1)?.replyMarkup?.inline_keyboard as Array<Array<{ text: string }>> | undefined
    expect(rows?.flat().some((button) => /^(?:Approve|Publish|Schedule|Add to queue)/i.test(button.text))).toBe(false)
  }
}
