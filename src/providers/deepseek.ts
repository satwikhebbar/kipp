import type { LLMResponse } from "../types"
import {
  type DeepseekToolWireMessage,
  type GenerateOptions,
  type ToolProviderClient,
  ToolProviderProtocolError,
  toolDeclaration,
} from "./llm"

const DEEPSEEK_CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions"
const DEEPSEEK_DEFAULT_MODEL = "deepseek-chat"
const FUNCTION_TOOL_TYPE = "function"

interface DeepseekToolResponse {
  choices?: Array<{
    message?: {
      content?: string
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
    }
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/** Creates a DeepSeek chat completion generator (non-tool-calling). */
export function createDeepseekGenerator(apiKey: string, modelName = DEEPSEEK_DEFAULT_MODEL) {
  return async ({ messages }: GenerateOptions): Promise<LLMResponse> => {
    const res = await fetch(DEEPSEEK_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: modelName, messages }),
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
export function createDeepseekToolClient(apiKey: string, modelName = DEEPSEEK_DEFAULT_MODEL): ToolProviderClient {
  return {
    async generate({ messages, tools }) {
      const wireMessages: DeepseekToolWireMessage[] = messages.map((message) => {
        if ("text" in message) return { role: message.role, content: message.text }
        if (message.role === "tool")
          return { role: "tool", tool_call_id: message.toolCallId, content: JSON.stringify(message.output) }
        return {
          role: "assistant",
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: FUNCTION_TOOL_TYPE,
            function: { name: call.name, arguments: JSON.stringify(call.input) },
          })),
        }
      })
      const response = await fetch(DEEPSEEK_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: modelName,
          messages: wireMessages,
          tools: tools.map((tool) => ({ type: FUNCTION_TOOL_TYPE, function: toolDeclaration(tool) })),
        }),
      })
      if (!response.ok) throw new Error(`DeepSeek tool request failed (${response.status})`)
      const data = (await response.json()) as DeepseekToolResponse
      const message = data.choices?.[0]?.message
      if (!message) throw new ToolProviderProtocolError("DeepSeek returned empty choices")
      const toolCalls = message.tool_calls?.map((call) => {
        try {
          return { id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) }
        } catch {
          throw new ToolProviderProtocolError("DeepSeek returned malformed tool arguments")
        }
      })
      return {
        text: message.content ?? undefined,
        toolCalls,
        usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
      }
    },
  }
}
