import { createDeepseekGenerator } from "./deepseek"
import { createGeminiGenerator } from "./gemini"
import type { GenerateFn } from "./llm"

export type { GenerateFn, GenerateOptions } from "./llm"

export function createGenerator(apiKey: string, provider: string): GenerateFn {
  switch (provider) {
    case "gemini":
      return createGeminiGenerator(apiKey)
    case "deepseek":
      return createDeepseekGenerator(apiKey)
    default:
      throw new Error(`Unknown LLM provider: "${provider}". Supported: "gemini", "deepseek"`)
  }
}
