import type { LLMResponse } from "../core/types"
import type { ToolDefinition } from "../runtime/tools"

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
  | {
      role: "assistant"
      toolCalls: Array<{ id: string; name: string; input: unknown }>
      /** Assistant content accompanying a native tool call; some providers require it on continuation. */
      text?: string
      /** Provider reasoning carried forward only when its native API requires it. */
      reasoningContent?: string
      /** Opaque native reasoning state required by some OpenAI-compatible APIs. */
      reasoningDetails?: unknown[]
    }
  | { role: "tool"; toolCallId: string; name: string; output: unknown }

export interface ToolProviderResponse {
  text?: string
  toolCalls?: Array<{ id: string; name: string; input: unknown }>
  /** Opaque native reasoning state; never log this field. */
  reasoningContent?: string
  /** Opaque native reasoning state; never log this field. */
  reasoningDetails?: unknown[]
  usage: LLMResponse["usage"]
}

export type ToolChoice = "auto" | "required"
/** Provider reasoning mode; effort levels map to provider-native effort controls where supported. */
export type ToolReasoningMode = "disabled" | "enabled" | "low" | "high" | "max"

export interface ToolProviderClient {
  generate(input: {
    messages: ToolConversationMessage[]
    tools: readonly ToolDefinition[]
    toolChoice?: ToolChoice
    reasoning?: ToolReasoningMode
  }): Promise<ToolProviderResponse>
}

/** Optional transport controls for tool-provider callers such as live evals. */
export interface ToolProviderOptions {
  /** Abort an individual provider request after this many milliseconds. */
  requestTimeoutMs?: number
  /** Emits safe request-boundary metadata; callers must never log provider payloads. */
  onRequestEvent?: (event: ToolProviderRequestEvent) => void
}

export type ToolProviderRequestEvent = {
  phase: "dispatched" | "http-response" | "parsed" | "failed"
  durationMs: number
  status?: number
  toolCallCount?: number
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  messageCharacters?: number
  toolSchemaCharacters?: number
  requestBodyCharacters?: number
  failureCategory?: string
}

/** Non-sensitive provider failure metadata for runtime observability. */
export class ToolProviderHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    /** Sanitized provider validation detail for diagnostics; excluded from the public error message. */
    readonly providerMessage?: string,
  ) {
    super(`${provider} tool request failed (${status})`)
    this.name = "ToolProviderHttpError"
  }
}

export type DeepseekToolWireMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "tool"; tool_call_id: string; content: string }
  | {
      role: "assistant"
      tool_calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>
      content?: string | null
      reasoning_content?: string
      reasoning?: string
      reasoning_details?: unknown[]
    }

/** Non-retriable malformed provider response. */
export class ToolProviderProtocolError extends Error {}

/** A caller-configured request deadline elapsed before the provider responded. */
export class ToolProviderTimeoutError extends Error {
  constructor(provider: string, timeoutMs: number) {
    super(`${provider} tool request timed out after ${timeoutMs}ms`)
    this.name = "ToolProviderTimeoutError"
  }
}

/** Small JSON-schema projection used by providers; schemas remain enforced by ToolGuard. */
export function toolDeclaration(tool: ToolDefinition): {
  name: string
  description: string
  parameters: Record<string, unknown>
} {
  const parameters = zodProperty(tool.input)
  return {
    name: tool.name,
    description: tool.description,
    parameters: parameters.type === "object" ? parameters : { ...parameters, type: "object" },
  }
}

/** Projects a tool schema into the stricter JSON Schema subset required by OpenAI-compatible tools. */
export function strictToolDeclaration(tool: ToolDefinition): {
  name: string
  description: string
  parameters: Record<string, unknown>
  strict?: true
} {
  const declaration = toolDeclaration(tool)
  if (!supportsStrictJsonSchema(declaration.parameters)) return declaration
  return { ...declaration, parameters: strictJsonSchema(declaration.parameters), strict: true }
}

/** Strict function schemas cannot represent arbitrary-key records. */
function supportsStrictJsonSchema(schema: Record<string, unknown>): boolean {
  if (schema.type === "object") {
    if (
      Object.keys((schema.properties ?? {}) as Record<string, unknown>).length === 0 &&
      schema.additionalProperties &&
      typeof schema.additionalProperties === "object"
    )
      return false
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
    if (Object.values(properties).some((property) => !supportsStrictJsonSchema(property))) return false
    if (schema.additionalProperties && typeof schema.additionalProperties === "object")
      return supportsStrictJsonSchema(schema.additionalProperties as Record<string, unknown>)
  }
  if (schema.type === "array" && schema.items && typeof schema.items === "object")
    return supportsStrictJsonSchema(schema.items as Record<string, unknown>)
  if (Array.isArray(schema.anyOf))
    return schema.anyOf.every((option) => supportsStrictJsonSchema(option as Record<string, unknown>))
  return true
}

/** Internal helper. */
function strictJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const type = schema.type
  if (type === "object") {
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
    const required = new Set(Array.isArray(schema.required) ? schema.required : [])
    return {
      ...schema,
      properties: Object.fromEntries(
        Object.entries(properties).map(([name, property]) => {
          const projected = strictJsonSchema(property)
          return [name, required.has(name) ? projected : { anyOf: [projected, { type: "null" }] }]
        }),
      ),
      required: Object.keys(properties),
      additionalProperties: false,
    }
  }
  if (type === "array" && schema.items && typeof schema.items === "object")
    return { ...schema, items: strictJsonSchema(schema.items as Record<string, unknown>) }
  if (Array.isArray(schema.anyOf))
    return { ...schema, anyOf: schema.anyOf.map((option) => strictJsonSchema(option as Record<string, unknown>)) }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object")
    return { ...schema, additionalProperties: strictJsonSchema(schema.additionalProperties as Record<string, unknown>) }
  return { ...schema }
}

/** Maps a Zod property to a JSON Schema type descriptor. */
function zodProperty(schema: unknown): Record<string, unknown> {
  const unwrapped = unwrapZodProperty(schema)
  const definition = unwrapped._def
  const typeName = definition?.typeName
  const described = (property: Record<string, unknown>): Record<string, unknown> =>
    unwrapped.description ? { ...property, description: unwrapped.description } : property
  if (typeName === "ZodObject") {
    const entries = Object.entries(definition?.shape?.() ?? {})
    return described({
      type: "object",
      properties: Object.fromEntries(entries.map(([name, value]) => [name, zodProperty(value)])),
      required: entries.filter(([, value]) => !isOptionalZodProperty(value)).map(([name]) => name),
      additionalProperties: false,
    })
  }
  if (typeName === "ZodDiscriminatedUnion" || typeName === "ZodUnion")
    return described({ anyOf: (definition?.options ?? []).map((option) => zodProperty(option)) })
  if (typeName === "ZodNumber")
    return { type: definition?.checks?.some((check) => check.kind === "int") ? "integer" : "number" }
  if (typeName === "ZodBoolean") return { type: "boolean" }
  if (typeName === "ZodArray") return { type: "array", items: zodProperty(definition?.type) }
  if (typeName === "ZodRecord")
    return {
      type: "object",
      additionalProperties: definition?.valueType ? zodProperty(definition?.valueType) : {},
      ...(definition?.description ? { description: definition.description } : {}),
    }
  if (typeName === "ZodEnum") return { type: "string", enum: definition?.values }
  if (typeName === "ZodLiteral") return literalProperty(definition?.value)
  return { type: "string" }
}

/** Uses an enum for literals because it is accepted by every supported tool-schema provider. */
function literalProperty(value: unknown): Record<string, unknown> {
  const type = typeof value
  if (type === "string" || type === "number" || type === "boolean") return { type, enum: [value] }
  return { enum: [value] }
}

type ZodProperty = {
  description?: string
  _def?: {
    typeName?: string
    innerType?: ZodProperty
    valueType?: ZodProperty
    values?: readonly string[]
    value?: unknown
    type?: ZodProperty
    options?: ZodProperty[]
    checks?: Array<{ kind?: string }>
    shape?: () => Record<string, ZodProperty>
    description?: string
  }
}

/** Identifies fields callers may omit when invoking a tool. */
function isOptionalZodProperty(schema: unknown): boolean {
  const typeName = (schema as ZodProperty)._def?.typeName
  return typeName === "ZodOptional" || typeName === "ZodDefault"
}

/** Removes optional/default wrappers before projecting a field's JSON Schema type. */
function unwrapZodProperty(schema: unknown): ZodProperty {
  const property = schema as ZodProperty
  const typeName = property._def?.typeName
  if ((typeName === "ZodOptional" || typeName === "ZodDefault") && property._def?.innerType)
    return unwrapZodProperty(property._def.innerType)
  return property
}

/** Parses JSON from an LLM response, stripping markdown code fences if present. */
export function parseLLMJson<T>(text: string): T {
  const cleaned = text.replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/m, "$1").trim()
  return JSON.parse(cleaned) as T
}

/** Builds a GenerateOptions with optional system message and a single user message. */
export function messages(system: string | undefined, user: string): GenerateOptions {
  const out: LLMMessage[] = []
  if (system) out.push({ role: "system", content: system })
  out.push({ role: "user", content: user })
  return { messages: out }
}
