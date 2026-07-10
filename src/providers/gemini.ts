import { GoogleGenerativeAI } from "@google/generative-ai"
import type { LLMResponse } from "../types"
import type { GenerateOptions } from "./llm"

export function createGeminiGenerator(apiKey: string) {
  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" })

  return async ({ system, prompt }: GenerateOptions): Promise<LLMResponse> => {
    const result = await model.generateContent({
      systemInstruction: system ? { role: "system", parts: [{ text: system }] } : undefined,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
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
