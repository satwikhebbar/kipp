import type { ToolDefinition } from "../runtime/tools"
import type { LLMResponse } from "../types"

export type LLMRole = "system" | "user" | "assistant"

export interface LLMMessage {
  role: LLMRole
  content: string
}

export interface GenerateOptions {
  messages: LLMMessage[]
}

export type GenerateFn = (opts: GenerateOptions) => Promise<LLMResponse>

export type ToolConversationMessage =
  | { role: "system" | "user" | "assistant"; text: string }
  | { role: "assistant"; toolCalls: Array<{ id: string; name: string; input: unknown }> }
  | { role: "tool"; toolCallId: string; name: string; output: unknown }

export interface ToolProviderResponse {
  text?: string
  toolCalls?: Array<{ id: string; name: string; input: unknown }>
  usage: LLMResponse["usage"]
}

export interface ToolProviderClient {
  generate(input: {
    messages: ToolConversationMessage[]
    tools: readonly ToolDefinition[]
  }): Promise<ToolProviderResponse>
}

export type DeepseekToolWireMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "tool"; tool_call_id: string; content: string }
  | {
      role: "assistant"
      tool_calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>
    }

/** Non-retriable malformed provider response. */
export class ToolProviderProtocolError extends Error {}

/** Small JSON-schema projection used by providers; schemas remain enforced by ToolGuard. */
export function toolDeclaration(tool: ToolDefinition): {
  name: string
  description: string
  parameters: Record<string, unknown>
} {
  const schema = tool.input as unknown as { _def?: { typeName?: string; shape?: () => Record<string, unknown> } }
  const shape = schema._def?.shape?.() ?? {}
  const properties = Object.fromEntries(Object.entries(shape).map(([name, value]) => [name, zodProperty(value)]))
  return {
    name: tool.name,
    description: tool.description,
    parameters: { type: "object", properties, required: Object.keys(properties) },
  }
}

function zodProperty(schema: unknown): Record<string, unknown> {
  const typeName = (schema as { _def?: { typeName?: string } })._def?.typeName
  if (typeName === "ZodNumber") return { type: "number" }
  if (typeName === "ZodBoolean") return { type: "boolean" }
  if (typeName === "ZodArray") return { type: "array" }
  return { type: "string" }
}

export function parseLLMJson<T>(text: string): T {
  const cleaned = text.replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/m, "$1").trim()
  return JSON.parse(cleaned) as T
}

export function messages(system: string | undefined, user: string): GenerateOptions {
  const out: LLMMessage[] = []
  if (system) out.push({ role: "system", content: system })
  out.push({ role: "user", content: user })
  return { messages: out }
}
