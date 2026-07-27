import { createDeepseekGenerator, createDeepseekToolClient } from "./deepseek"
import { createGeminiGenerator, createGeminiToolClient } from "./gemini"
import { type GenerateFn, type ToolProviderClient, ToolProviderProtocolError } from "./llm"

export {
  type GenerateFn,
  type GenerateOptions,
  type LLMMessage,
  type LLMRole,
  messages,
  parseLLMJson,
  type ToolConversationMessage,
  type ToolProviderClient,
  type ToolProviderResponse,
} from "./llm"

export function resolveModel(provider: string, modelName?: string): string {
  if (modelName) return modelName
  switch (provider) {
    case "gemini":
      return "gemini-2.5-flash"
    case "deepseek":
      return "deepseek-chat"
    default:
      throw new Error(`Unknown LLM provider: "${provider}". Supported: "gemini", "deepseek"`)
  }
}

export function createGenerator(apiKey: string, provider: string, modelName?: string, maxRetries = 3): GenerateFn {
  const retries = Number.isFinite(maxRetries) && maxRetries >= 0 ? Math.floor(maxRetries) : 3
  const inner = createInnerGenerator(apiKey, provider, modelName)
  return withRetry(inner, retries)
}

export function createToolProvider(
  apiKey: string,
  provider: string,
  modelName?: string,
  maxRetries = 3,
): ToolProviderClient {
  const retries = Number.isFinite(maxRetries) && maxRetries >= 0 ? Math.floor(maxRetries) : 3
  const inner = createInnerToolProvider(apiKey, provider, modelName)
  return {
    generate: withRetry(
      (input) => inner.generate(input),
      retries,
      (error) => !(error instanceof ToolProviderProtocolError),
    ),
  }
}

function createInnerToolProvider(apiKey: string, provider: string, modelName?: string): ToolProviderClient {
  switch (provider) {
    case "gemini":
      return createGeminiToolClient(apiKey, modelName)
    case "deepseek":
      return createDeepseekToolClient(apiKey, modelName)
    default:
      throw new Error(`Unknown LLM provider: "${provider}". Supported: "gemini", "deepseek"`)
  }
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

function withRetry<TInput, TOutput>(
  fn: (input: TInput) => Promise<TOutput>,
  maxRetries: number,
  shouldRetry: (error: unknown) => boolean = () => true,
): (input: TInput) => Promise<TOutput> {
  return async (opts) => {
    let lastErr: unknown
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn(opts)
      } catch (err) {
        lastErr = err
        if (!shouldRetry(err)) throw err
        if (attempt < maxRetries) {
          const delay = Math.min(1000 * 2 ** attempt + Math.random() * 1000, 16000)
          await new Promise((r) => setTimeout(r, delay))
        }
      }
    }
    throw lastErr
  }
}
