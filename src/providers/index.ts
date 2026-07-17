import { createDeepseekGenerator } from "./deepseek"
import { createGeminiGenerator } from "./gemini"
import type { GenerateFn } from "./llm"

export { type GenerateFn, type GenerateOptions, type LLMMessage, type LLMRole, messages, parseLLMJson } from "./llm"

export function createGenerator(apiKey: string, provider: string, modelName?: string, maxRetries = 3): GenerateFn {
  const retries = Number.isFinite(maxRetries) && maxRetries >= 0 ? Math.floor(maxRetries) : 3
  const inner = createInnerGenerator(apiKey, provider, modelName)
  return withRetry(inner, retries)
}

function createInnerGenerator(apiKey: string, provider: string, modelName?: string): GenerateFn {
  switch (provider) {
    case "gemini":
      return createGeminiGenerator(apiKey, modelName)
    case "deepseek":
      return createDeepseekGenerator(apiKey, modelName)
    default:
      throw new Error(`Unknown LLM provider: "${provider}". Supported: "gemini", "deepseek"`)
  }
}

function withRetry(fn: GenerateFn, maxRetries: number): GenerateFn {
  return async (opts) => {
    let lastErr: unknown
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn(opts)
      } catch (err) {
        lastErr = err
        if (attempt < maxRetries) {
          const delay = Math.min(1000 * 2 ** attempt + Math.random() * 1000, 16000)
          await new Promise((r) => setTimeout(r, delay))
        }
      }
    }
    throw lastErr
  }
}
