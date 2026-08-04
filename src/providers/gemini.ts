import { GoogleGenerativeAI } from "@google/generative-ai"
import type { LLMResponse } from "../core/types"
import { type GenerateOptions, type ToolProviderClient, ToolProviderProtocolError, toolDeclaration } from "./llm"

const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash"

/** Creates a Gemini text generation client (non-tool-calling). */
export function createGeminiGenerator(apiKey: string, modelName = GEMINI_DEFAULT_MODEL) {
  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({ model: modelName })

  return async ({ messages }: GenerateOptions): Promise<LLMResponse> => {
    const systemText = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n")
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }))

    const result = await model.generateContent({
      systemInstruction: systemText ? { role: "system", parts: [{ text: systemText }] } : undefined,
      contents,
    })

    const response = result.response

    if (!response.candidates?.length) {
      const reason = response.promptFeedback?.blockReason
      throw new Error(`Gemini returned no candidates${reason ? ` (blocked: ${reason})` : ""}`)
    }

    const text = response.text()
    const usage = response.usageMetadata

    return {
      text,
      usage: {
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
      },
    }
  }
}

/** Creates a Gemini tool-calling client. */
export function createGeminiToolClient(apiKey: string, modelName = GEMINI_DEFAULT_MODEL): ToolProviderClient {
  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({ model: modelName })
  return {
    async generate({ messages, tools }) {
      const system = messages
        .filter((m) => "text" in m && m.role === "system")
        .map((m) => (m as { text: string }).text)
        .join("\n\n")
      const contents = messages
        .filter((m) => !("text" in m && m.role === "system"))
        .map((message) => {
          if ("toolCalls" in message)
            return {
              role: "model",
              parts: [
                ...(message.text ? [{ text: message.text }] : []),
                ...message.toolCalls.map((call) => ({ functionCall: { name: call.name, args: call.input } })),
              ],
            }
          if ("text" in message)
            return { role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.text }] }
          if (message.role === "tool")
            return {
              role: "user",
              parts: [{ functionResponse: { name: message.name, response: { result: message.output } } }],
            }
          return message satisfies never
        })
      const result = await model.generateContent({
        systemInstruction: system ? { role: "system", parts: [{ text: system }] } : undefined,
        contents,
        tools: [{ functionDeclarations: tools.map(toolDeclaration) }],
      } as never)
      const response = result.response
      const candidate = response.candidates?.[0]
      if (!candidate) throw new ToolProviderProtocolError("Gemini returned no candidates")
      const parts = candidate.content.parts ?? []
      return {
        text: parts.map((part) => part.text ?? "").join("") || undefined,
        toolCalls: parts.flatMap((part) =>
          part.functionCall
            ? [{ id: crypto.randomUUID(), name: part.functionCall.name, input: part.functionCall.args }]
            : [],
        ),
        usage: {
          inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        },
      }
    },
  }
}
