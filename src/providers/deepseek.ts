import type { LLMResponse } from "../core/types"
import {
  type DeepseekToolWireMessage,
  type GenerateOptions,
  type ToolProviderClient,
  ToolProviderHttpError,
  type ToolProviderOptions,
  ToolProviderProtocolError,
  ToolProviderTimeoutError,
  toolDeclaration,
} from "./llm"

const DEEPSEEK_CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions"
const DEEPSEEK_DEFAULT_MODEL = "deepseek-chat"
const DEEPSEEK_DEFAULT_REQUEST_TIMEOUT_MS = 180_000
const FUNCTION_TOOL_TYPE = "function"
const MAX_PROVIDER_ERROR_MESSAGE_CHARACTERS = 500

interface DeepseekToolResponse {
  choices?: Array<{
    message?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
    }
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/** Creates a DeepSeek chat completion generator (non-tool-calling). */
export function createDeepseekGenerator(apiKey: string, modelName = DEEPSEEK_DEFAULT_MODEL) {
  return async ({ messages }: GenerateOptions): Promise<LLMResponse> => {
    const signal = AbortSignal.timeout(DEEPSEEK_DEFAULT_REQUEST_TIMEOUT_MS)
    const res = await fetch(DEEPSEEK_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: modelName, messages }),
      signal,
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`DeepSeek API error ${res.status}: ${body}`)
    }

    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>
      usage: { prompt_tokens: number; completion_tokens: number }
    }

    if (!data.choices?.length) {
      throw new Error("DeepSeek returned empty choices")
    }

    return {
      text: data.choices[0].message.content,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
    }
  }
}

/** Creates a DeepSeek tool-calling client. */
export function createDeepseekToolClient(
  apiKey: string,
  modelName = DEEPSEEK_DEFAULT_MODEL,
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
            ...(message.reasoningContent ? { reasoning_content: message.reasoningContent } : {}),
          }
        return {
          role: message.role,
          content: message.text,
        }
      })
      const thinkingEnabled = reasoning !== undefined && reasoning !== "disabled"
      const effort = reasoning === "enabled" ? undefined : thinkingEnabled ? reasoning : undefined
      const timeoutMs = options.requestTimeoutMs ?? DEEPSEEK_DEFAULT_REQUEST_TIMEOUT_MS
      const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
      const requestStartedAt = Date.now()
      options.onRequestEvent?.({ phase: "dispatched", durationMs: 0 })
      let response: Response
      try {
        response = await fetch(DEEPSEEK_CHAT_COMPLETIONS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: modelName,
            messages: wireMessages,
            tools: tools.map((tool) => ({ type: FUNCTION_TOOL_TYPE, function: toolDeclaration(tool) })),
            ...(toolChoice ? { tool_choice: toolChoice } : {}),
            ...(reasoning ? { thinking: { type: thinkingEnabled ? "enabled" : "disabled" } } : {}),
            ...(effort ? { reasoning_effort: effort } : {}),
          }),
          ...(signal ? { signal } : {}),
        })
      } catch (error) {
        const failureCategory = signal?.aborted ? "timeout" : error instanceof Error ? error.name : "transport-error"
        options.onRequestEvent?.({
          phase: "failed",
          durationMs: Date.now() - requestStartedAt,
          failureCategory,
        })
        if (signal?.aborted && timeoutMs !== undefined) throw new ToolProviderTimeoutError("DeepSeek", timeoutMs)
        throw error
      }
      options.onRequestEvent?.({
        phase: "http-response",
        durationMs: Date.now() - requestStartedAt,
        status: response.status,
      })
      if (!response.ok) {
        const providerMessage = await readProviderErrorMessage(response)
        options.onRequestEvent?.({
          phase: "failed",
          durationMs: Date.now() - requestStartedAt,
          status: response.status,
          failureCategory: "http-error",
        })
        throw new ToolProviderHttpError("DeepSeek", response.status, providerMessage)
      }
      let data: DeepseekToolResponse
      try {
        data = (await response.json()) as DeepseekToolResponse
      } catch (error) {
        options.onRequestEvent?.({
          phase: "failed",
          durationMs: Date.now() - requestStartedAt,
          status: response.status,
          failureCategory: error instanceof Error ? error.name : "response-parse-error",
        })
        throw error
      }
      const message = data.choices?.[0]?.message
      if (!message) {
        options.onRequestEvent?.({
          phase: "failed",
          durationMs: Date.now() - requestStartedAt,
          status: response.status,
          failureCategory: "empty-choices",
        })
        throw new ToolProviderProtocolError("DeepSeek returned empty choices")
      }
      const toolCalls = message.tool_calls?.map((call) => {
        try {
          return { id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) }
        } catch {
          options.onRequestEvent?.({
            phase: "failed",
            durationMs: Date.now() - requestStartedAt,
            status: response.status,
            failureCategory: "malformed-tool-arguments",
          })
          throw new ToolProviderProtocolError("DeepSeek returned malformed tool arguments")
        }
      })
      options.onRequestEvent?.({
        phase: "parsed",
        durationMs: Date.now() - requestStartedAt,
        status: response.status,
        toolCallCount: toolCalls?.length ?? 0,
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      })
      return {
        text: message.content ?? undefined,
        toolCalls,
        reasoningContent: message.reasoning_content ?? undefined,
        usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
      }
    },
  }
}

/** Extracts only DeepSeek's bounded validation message, never the request or raw response body. */
async function readProviderErrorMessage(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } }
    if (typeof body.error?.message !== "string") return undefined
    return body.error.message.replace(/\s+/g, " ").trim().slice(0, MAX_PROVIDER_ERROR_MESSAGE_CHARACTERS) || undefined
  } catch {
    return undefined
  }
}
