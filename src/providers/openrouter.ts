import type { LLMResponse } from "../core/types"
import {
  type DeepseekToolWireMessage,
  type GenerateOptions,
  strictToolDeclaration,
  type ToolProviderClient,
  ToolProviderHttpError,
  type ToolProviderOptions,
  ToolProviderProtocolError,
  ToolProviderTimeoutError,
} from "./llm"

const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions"
const OPENROUTER_DEFAULT_REQUEST_TIMEOUT_MS = 180_000
const FUNCTION_TOOL_TYPE = "function"
const MAX_PROVIDER_ERROR_MESSAGE_CHARACTERS = 500

interface OpenRouterToolResponse {
  choices?: Array<{
    message?: {
      content?: string | null
      reasoning?: string | null
      reasoning_details?: unknown[]
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    completion_tokens_details?: { reasoning_tokens?: number }
  }
}

/** Creates an OpenRouter chat-completions generator. */
export function createOpenRouterGenerator(apiKey: string, modelName: string) {
  return async ({ messages }: GenerateOptions): Promise<LLMResponse> => {
    const response = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: modelName, messages }),
      signal: AbortSignal.timeout(OPENROUTER_DEFAULT_REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`OpenRouter API error ${response.status}`)
    const data = (await response.json()) as OpenRouterToolResponse
    const message = data.choices?.[0]?.message
    if (!message) throw new Error("OpenRouter returned empty choices")
    return {
      text: message.content ?? "",
      usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
    }
  }
}

/** Creates an OpenAI-compatible OpenRouter tool client. */
export function createOpenRouterToolClient(
  apiKey: string,
  modelName: string,
  options: ToolProviderOptions = {},
): ToolProviderClient {
  return {
    async generate({ messages, tools, toolChoice, reasoning }) {
      const wireMessages: DeepseekToolWireMessage[] = messages.map((message) => {
        if (message.role === "tool")
          return { role: "tool", tool_call_id: message.toolCallId, content: JSON.stringify(message.output) }
        if ("toolCalls" in message)
          return {
            role: "assistant",
            content: message.text ?? "",
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: FUNCTION_TOOL_TYPE,
              function: { name: call.name, arguments: JSON.stringify(call.input) },
            })),
            ...(message.reasoningContent ? { reasoning: message.reasoningContent } : {}),
            ...(message.reasoningDetails ? { reasoning_details: message.reasoningDetails } : {}),
          }
        return { role: message.role, content: message.text }
      })
      const wireTools = tools.map((tool) => ({ type: FUNCTION_TOOL_TYPE, function: strictToolDeclaration(tool) }))
      const effort = reasoning === "enabled" ? undefined : reasoning === "disabled" ? "none" : reasoning
      const requestBody = JSON.stringify({
        model: modelName,
        messages: wireMessages,
        tools: wireTools,
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
        ...(effort ? { reasoning: { effort } } : {}),
        provider: { require_parameters: true },
      })
      const timeoutMs = options.requestTimeoutMs ?? OPENROUTER_DEFAULT_REQUEST_TIMEOUT_MS
      const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
      const startedAt = Date.now()
      options.onRequestEvent?.({
        phase: "dispatched",
        durationMs: 0,
        messageCharacters: wireMessages.reduce((total, message) => total + JSON.stringify(message).length, 0),
        toolSchemaCharacters: JSON.stringify(wireTools).length,
        requestBodyCharacters: requestBody.length,
      })
      let response: Response
      try {
        response = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: requestBody,
          ...(signal ? { signal } : {}),
        })
      } catch (error) {
        options.onRequestEvent?.({
          phase: "failed",
          durationMs: Date.now() - startedAt,
          failureCategory: signal?.aborted ? "timeout" : error instanceof Error ? error.name : "transport-error",
        })
        throw normalizeTimeout(error, signal, timeoutMs)
      }
      options.onRequestEvent?.({ phase: "http-response", durationMs: Date.now() - startedAt, status: response.status })
      if (!response.ok) {
        const providerMessage = await readProviderErrorMessage(response)
        options.onRequestEvent?.({
          phase: "failed",
          durationMs: Date.now() - startedAt,
          status: response.status,
          failureCategory: "http-error",
        })
        throw new ToolProviderHttpError("OpenRouter", response.status, providerMessage)
      }
      let data: OpenRouterToolResponse
      try {
        data = (await response.json()) as OpenRouterToolResponse
      } catch (error) {
        options.onRequestEvent?.({
          phase: "failed",
          durationMs: Date.now() - startedAt,
          status: response.status,
          failureCategory: signal?.aborted ? "timeout" : error instanceof Error ? error.name : "response-parse-error",
        })
        throw normalizeTimeout(error, signal, timeoutMs)
      }
      const message = data.choices?.[0]?.message
      if (!message) {
        options.onRequestEvent?.({
          phase: "failed",
          durationMs: Date.now() - startedAt,
          status: response.status,
          failureCategory: "protocol-error",
        })
        throw new ToolProviderProtocolError("OpenRouter returned empty choices")
      }
      const toolCalls = message.tool_calls?.map((call) => {
        try {
          return { id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) }
        } catch {
          options.onRequestEvent?.({
            phase: "failed",
            durationMs: Date.now() - startedAt,
            status: response.status,
            failureCategory: "protocol-error",
          })
          throw new ToolProviderProtocolError("OpenRouter returned malformed tool arguments")
        }
      })
      options.onRequestEvent?.({
        phase: "parsed",
        durationMs: Date.now() - startedAt,
        status: response.status,
        toolCallCount: toolCalls?.length ?? 0,
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      })
      return {
        text: message.content ?? undefined,
        toolCalls,
        reasoningContent: message.reasoning ?? undefined,
        reasoningDetails: message.reasoning_details,
        usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
      }
    },
  }
}

/** Normalize timeout. */
function normalizeTimeout(error: unknown, signal: AbortSignal | undefined, timeoutMs: number | undefined): unknown {
  if (signal?.aborted && timeoutMs !== undefined) return new ToolProviderTimeoutError("OpenRouter", timeoutMs)
  return error
}

/** Read provider error message. */
async function readProviderErrorMessage(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } }
    if (typeof body.error?.message !== "string") return undefined
    return body.error.message.replace(/\s+/g, " ").trim().slice(0, MAX_PROVIDER_ERROR_MESSAGE_CHARACTERS) || undefined
  } catch {
    return undefined
  }
}
