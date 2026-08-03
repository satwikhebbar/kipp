import type { ToolConversationMessage } from "../providers"
import { persistableAgentMessages } from "../runtime/agent-session"
import { CALENDAR_AGENT_TOOL } from "./calendar"

/** Removes reasoning and compacts obsolete Calendar event-list payloads to safe count metadata. */
export function persistableCalendarMessages(messages: ToolConversationMessage[]): ToolConversationMessage[] {
  const persistable = persistableAgentMessages(messages)
  let latestEventListIndex = -1
  persistable.forEach((message, index) => {
    if (message.role === "tool" && message.name === CALENDAR_AGENT_TOOL.LIST_EVENTS) latestEventListIndex = index
  })
  return persistable.map((message, index) => {
    if (index === latestEventListIndex || message.role !== "tool" || message.name !== CALENDAR_AGENT_TOOL.LIST_EVENTS)
      return message
    const metadata = eventListMetadata(message.output)
    return { ...message, output: { ok: true, output: { compacted: true, ...metadata } } }
  })
}

/** Extracts only safe count/truncation metadata from a guarded Calendar event-list result. */
function eventListMetadata(output: unknown): { eventCount: number; truncated: boolean } {
  if (!output || typeof output !== "object") return { eventCount: 0, truncated: false }
  const guarded = output as { ok?: unknown; output?: unknown }
  if (guarded.ok !== true || !guarded.output || typeof guarded.output !== "object")
    return { eventCount: 0, truncated: false }
  const list = guarded.output as { events?: unknown; truncated?: unknown }
  return {
    eventCount: Array.isArray(list.events) ? list.events.length : 0,
    truncated: list.truncated === true,
  }
}
