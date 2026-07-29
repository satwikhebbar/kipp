import type { ToolChoice, ToolConversationMessage, ToolProviderClient, ToolReasoningMode } from "../providers"
import { ToolGuard, type ToolRegistry, type ToolResult } from "./tools"

export const MAX_TOOL_PROVIDER_TURNS = 3
export const MAX_TOOL_CALLS = 4

export interface ToolExecutionSummary {
  tool: string
  outcome: "succeeded" | "failed"
  failureCategory?: Extract<ToolResult, { ok: false }>["category"]
}

export interface ToolRunResult {
  messages: ToolConversationMessage[]
  finalText?: string
  completed: boolean
  providerTurns: number
  toolCallCount: number
  toolNames: string[]
  toolExecutions: ToolExecutionSummary[]
}

/** Controls a bounded native-tool session without exposing unapproved tools to the provider. */
export interface ToolRunOptions {
  allowedTools: readonly string[]
  /** A successful call to one of these tools hands control away from the model loop immediately. */
  handoffTools?: readonly string[]
  /** Restricts a provider turn to one action, preventing mixed availability and handoff batches. */
  maxToolCallsPerTurn?: number
  toolChoice?: ToolChoice
  reasoning?: ToolReasoningMode
  /** Chooses the allowlist for the next provider turn after a successful tool batch. */
  nextAllowedTools?: (executedTools: readonly string[]) => readonly string[]
}

/**
 * Runs a workflow's static, allowlisted tool set serially against a provider conversation.
 * Inputs are the provider, complete registry, workflow-specific allowlist, and initial messages; the result
 * contains the accumulated transcript plus completion state and final provider text when available.
 */
export async function runTools(
  provider: ToolProviderClient,
  registry: ToolRegistry,
  options: ToolRunOptions,
  initialMessages: ToolConversationMessage[],
): Promise<ToolRunResult> {
  const messages = [...initialMessages]
  let allowedTools = options.allowedTools
  let toolCalls = 0
  const toolNames: string[] = []
  const toolExecutions: ToolExecutionSummary[] = []
  for (let turn = 0; turn < MAX_TOOL_PROVIDER_TURNS; turn++) {
    const guard = new ToolGuard(registry, allowedTools)
    const response = await provider.generate({
      messages,
      tools: allowedTools.flatMap((name) => (registry[name] ? [registry[name]] : [])),
      toolChoice: options.toolChoice,
      reasoning: options.reasoning,
    })
    if (!response.toolCalls?.length)
      return {
        messages,
        finalText: response.text,
        completed: true,
        providerTurns: turn + 1,
        toolCallCount: toolCalls,
        toolNames,
        toolExecutions,
      }
    if (
      toolCalls + response.toolCalls.length > MAX_TOOL_CALLS ||
      (options.maxToolCallsPerTurn !== undefined && response.toolCalls.length > options.maxToolCallsPerTurn)
    )
      return {
        messages,
        completed: false,
        providerTurns: turn + 1,
        toolCallCount: toolCalls,
        toolNames,
        toolExecutions,
      }
    messages.push({ role: "assistant", toolCalls: response.toolCalls, reasoningContent: response.reasoningContent })
    const executedTools: string[] = []
    let handoffActionCompleted = false
    for (const call of response.toolCalls) {
      const result = await guard.execute(call.name, call.input)
      const tool = allowedTools.includes(call.name) ? call.name : "unknown"
      toolNames.push(tool)
      toolExecutions.push(
        result.ok ? { tool, outcome: "succeeded" } : { tool, outcome: "failed", failureCategory: result.category },
      )
      toolCalls++
      executedTools.push(tool)
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, output: result })
      if (result.ok && options.handoffTools?.includes(call.name)) handoffActionCompleted = true
    }
    if (handoffActionCompleted)
      return {
        messages,
        completed: true,
        providerTurns: turn + 1,
        toolCallCount: toolCalls,
        toolNames,
        toolExecutions,
      }
    allowedTools = options.nextAllowedTools?.(executedTools) ?? allowedTools
  }
  return {
    messages,
    completed: false,
    providerTurns: MAX_TOOL_PROVIDER_TURNS,
    toolCallCount: toolCalls,
    toolNames,
    toolExecutions,
  }
}
