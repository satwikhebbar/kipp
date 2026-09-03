import type { LLMUsage } from "../core/types"
import type { ToolChoice, ToolConversationMessage, ToolProviderClient, ToolReasoningMode } from "../providers"
import { ToolGuard, type ToolRegistry, type ToolResult } from "./tools"

export const MAX_TOOL_PROVIDER_TURNS = 3
export const MAX_TOOL_CALLS = 4
const REQUIRED_HANDOFF_REPAIR_MESSAGE =
  "The previous response did not invoke a required handoff action. Call exactly one provided tool now; do not answer with prose."

export type ToolRunFailureReason =
  | "missing-required-handoff"
  | "tool-call-limit"
  | "provider-turn-limit"
  | "tool-failed"

export interface ToolExecutionSummary {
  tool: string
  outcome: "succeeded" | "failed"
  failureCategory?: Extract<ToolResult, { ok: false }>["category"]
  /** Input-schema paths only; excludes values and provider text. */
  validationPaths?: string[]
  /** Safe schema expectations only; excludes values and provider text. */
  validationErrors?: string[]
  /** Safe upstream HTTP status when explicitly surfaced by the handler. */
  status?: number
}

export interface ToolRunResult {
  messages: ToolConversationMessage[]
  finalText?: string
  completed: boolean
  failureReason?: ToolRunFailureReason
  providerTurns: number
  toolCallCount: number
  toolNames: string[]
  toolExecutions: ToolExecutionSummary[]
  usage: LLMUsage
}

/** Controls a bounded native-tool session without exposing unapproved tools to the provider. */
export interface ToolRunOptions {
  allowedTools: readonly string[]
  /** A successful call to one of these tools hands control away from the model loop immediately. */
  handoffTools?: readonly string[]
  /** Requires a successful handoff tool call; prose-only responses receive bounded repair turns. */
  requireHandoff?: boolean
  toolChoice?: ToolChoice
  reasoning?: ToolReasoningMode
  /** Chooses the allowlist for the next provider turn after a successful tool batch. */
  nextAllowedTools?: (executedTools: readonly string[]) => readonly string[]
  /** Adds concise state-specific guidance before the next provider turn after a successful tool batch. */
  nextInstruction?: (executedTools: readonly string[]) => string | undefined
  /** Provider-turn budget for this session; defaults to the global MAX_TOOL_PROVIDER_TURNS. */
  maxProviderTurns?: number
  /** Aggregate tool-call budget for this session; defaults to the global MAX_TOOL_CALLS. */
  maxToolCalls?: number
  /** Development-only hook invoked before and after each provider turn. */
  onProviderTurnStart?: (turn: number, messages: readonly ToolConversationMessage[]) => void
  onProviderTurn?: (turn: number, messages: readonly ToolConversationMessage[], durationMs: number) => void
  onProviderTurnFailure?: (turn: number, durationMs: number, error: unknown) => void
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
  const usage: LLMUsage = { inputTokens: 0, outputTokens: 0 }
  // Cumulative across turns: once a tool has succeeded, later failures in the
  // session must not revoke the tools the model already unlocked.
  const successfulTools: string[] = []
  const maxTurns = options.maxProviderTurns ?? MAX_TOOL_PROVIDER_TURNS
  const maxCalls = options.maxToolCalls ?? MAX_TOOL_CALLS
  for (let turn = 0; turn < maxTurns; turn++) {
    options.onProviderTurnStart?.(turn + 1, messages)
    const guard = new ToolGuard(registry, allowedTools)
    const providerStartedAt = Date.now()
    let response: Awaited<ReturnType<ToolProviderClient["generate"]>>
    try {
      response = await provider.generate({
        messages,
        tools: allowedTools.flatMap((name) => (registry[name] ? [registry[name]] : [])),
        toolChoice: options.toolChoice,
        reasoning: options.reasoning,
      })
    } catch (error) {
      options.onProviderTurnFailure?.(turn + 1, Date.now() - providerStartedAt, error)
      throw error
    }
    usage.inputTokens += response.usage.inputTokens ?? 0
    usage.outputTokens += response.usage.outputTokens ?? 0
    if (!response.toolCalls?.length) {
      if (options.requireHandoff) {
        if (response.text) messages.push({ role: "assistant", text: response.text })
        options.onProviderTurn?.(turn + 1, messages, Date.now() - providerStartedAt)
        messages.push({ role: "user", text: REQUIRED_HANDOFF_REPAIR_MESSAGE })
        if (turn + 1 < maxTurns) continue
        return {
          messages,
          completed: false,
          failureReason: "missing-required-handoff",
          providerTurns: turn + 1,
          toolCallCount: toolCalls,
          toolNames,
          toolExecutions,
          usage,
        }
      }
      return {
        messages,
        finalText: response.text,
        completed: true,
        providerTurns: turn + 1,
        toolCallCount: toolCalls,
        toolNames,
        toolExecutions,
        usage,
      }
    }
    if (toolCalls + response.toolCalls.length > maxCalls)
      return {
        messages,
        completed: false,
        failureReason: "tool-call-limit",
        providerTurns: turn + 1,
        toolCallCount: toolCalls,
        toolNames,
        toolExecutions,
        usage,
      }
    messages.push({
      role: "assistant",
      toolCalls: response.toolCalls,
      text: response.text,
      reasoningContent: response.reasoningContent,
      reasoningDetails: response.reasoningDetails,
    })
    options.onProviderTurn?.(turn + 1, messages, Date.now() - providerStartedAt)
    const isBatch = response.toolCalls.length > 1
    const allowedNonHandoffCalls = response.toolCalls.filter(
      (call) => allowedTools.includes(call.name) && !options.handoffTools?.includes(call.name),
    )
    let handoffActionCompleted = false
    let fatalToolFailure = false
    for (const call of response.toolCalls) {
      const definition = registry[call.name]
      const tool = definition ? call.name : "unknown"
      const isHandoff = definition && options.handoffTools?.includes(call.name) === true
      const batchingRejected =
        isBatch &&
        Boolean(definition) &&
        (isHandoff ||
          (allowedTools.includes(call.name) && definition?.batching !== "allowed" && allowedNonHandoffCalls.length > 1))
      const result: ToolResult = batchingRejected
        ? { ok: false, category: "batching-not-allowed" }
        : await guard.execute(call.name, stripNullProperties(call.input))
      toolNames.push(tool)
      toolExecutions.push(
        result.ok
          ? { tool, outcome: "succeeded" }
          : {
              tool,
              outcome: "failed",
              failureCategory: result.category,
              ...(result.validationPaths?.length ? { validationPaths: result.validationPaths } : {}),
              ...(result.validationErrors?.length ? { validationErrors: result.validationErrors } : {}),
              ...(result.status === undefined ? {} : { status: result.status }),
            },
      )
      toolCalls++
      if (result.ok) successfulTools.push(tool)
      else if (["handler-failed", "invalid-output", "authorization-failed"].includes(result.category))
        fatalToolFailure = true
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
        usage,
      }
    if (fatalToolFailure)
      return {
        messages,
        completed: false,
        failureReason: "tool-failed",
        providerTurns: turn + 1,
        toolCallCount: toolCalls,
        toolNames,
        toolExecutions,
        usage,
      }
    allowedTools = options.nextAllowedTools?.(successfulTools) ?? allowedTools
    const instruction = options.nextInstruction?.(successfulTools)
    if (instruction) messages.push({ role: "user", text: instruction })
  }
  return {
    messages,
    completed: false,
    failureReason: "provider-turn-limit",
    providerTurns: maxTurns,
    toolCallCount: toolCalls,
    toolNames,
    toolExecutions,
    usage,
  }
}

/** Strict OpenAI-compatible schemas represent omitted optional fields as null. */
export function stripNullProperties(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(stripNullProperties)
  if (!input || typeof input !== "object") return input
  return Object.fromEntries(
    Object.entries(input)
      .filter(([, value]) => value !== null)
      .map(([key, value]) => [key, stripNullProperties(value)]),
  )
}
