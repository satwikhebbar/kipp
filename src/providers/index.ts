import { createDeepseekGenerator } from "./deepseek"
import { createGeminiGenerator } from "./gemini"
import type { GenerateFn } from "./llm"

export type { GenerateFn, GenerateOptions } from "./llm"

export function createGenerator(apiKey: string, provider: string): GenerateFn {
  return provider === "deepseek" ? createDeepseekGenerator(apiKey) : createGeminiGenerator(apiKey)
}
