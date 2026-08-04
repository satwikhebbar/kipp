import type { LLMUsage } from "../core/types"
import type { ToolConversationMessage } from "../providers"
import type { ToolExecutionSummary, ToolRunFailureReason } from "./tool-runner"

/** Shared result envelope for one bounded workflow-specific native-tool session. */
export interface AgentSessionResult<TTerminal> {
  terminal: TTerminal | null
  messages: ToolConversationMessage[]
  completed: boolean
  failureReason?: ToolRunFailureReason
  providerTurns: number
  toolCallCount: number
  toolNames: string[]
  toolExecutions: ToolExecutionSummary[]
  usage: LLMUsage
}

/** Removes provider reasoning before a workflow persists or resumes a bounded transcript. */
export function persistableAgentMessages(messages: ToolConversationMessage[]): ToolConversationMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || !("toolCalls" in message)) return message
    return {
      role: "assistant",
      toolCalls: message.toolCalls,
      ...(message.text === undefined ? {} : { text: message.text }),
    }
  })
}
