import type { ToolConversationMessage, ToolProviderClient } from "../providers"
import { ToolGuard, type ToolRegistry } from "./tools"

export const MAX_TOOL_PROVIDER_TURNS = 3
export const MAX_TOOL_CALLS = 4

export interface ToolRunResult {
  messages: ToolConversationMessage[]
  finalText?: string
  completed: boolean
}

/**
 * Runs a workflow's static, allowlisted tool set serially against a provider conversation.
 * Inputs are the provider, complete registry, workflow-specific allowlist, and initial messages; the result
 * contains the accumulated transcript plus completion state and final provider text when available.
 */
export async function runTools(
  provider: ToolProviderClient,
  registry: ToolRegistry,
  allowedTools: readonly string[],
  initialMessages: ToolConversationMessage[],
): Promise<ToolRunResult> {
  const guard = new ToolGuard(registry, allowedTools)
  const messages = [...initialMessages]
  let toolCalls = 0
  for (let turn = 0; turn < MAX_TOOL_PROVIDER_TURNS; turn++) {
    const response = await provider.generate({ messages, tools: Object.values(registry) })
    if (!response.toolCalls?.length) return { messages, finalText: response.text, completed: true }
    if (toolCalls + response.toolCalls.length > MAX_TOOL_CALLS) return { messages, completed: false }
    messages.push({ role: "assistant", toolCalls: response.toolCalls })
    for (const call of response.toolCalls) {
      const result = await guard.execute(call.name, call.input)
      toolCalls++
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, output: result })
    }
  }
  return { messages, completed: false }
}
