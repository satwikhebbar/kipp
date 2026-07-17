import { GoogleGenerativeAI } from "@google/generative-ai"
import type { LLMResponse } from "../types"
import type { GenerateOptions } from "./llm"

export function createGeminiGenerator(apiKey: string, modelName = "gemini-2.0-flash") {
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
