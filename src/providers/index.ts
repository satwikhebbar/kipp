import { createDeepseekGenerator, createDeepseekToolClient } from "./deepseek"
import { createGeminiGenerator, createGeminiToolClient } from "./gemini"
import {
  type GenerateFn,
  type ToolProviderClient,
  type ToolProviderOptions,
  ToolProviderProtocolError,
  ToolProviderTimeoutError,
} from "./llm"

export {
  type GenerateFn,
  type GenerateOptions,
  type LLMMessage,
  type LLMRole,
  messages,
  parseLLMJson,
  type ToolChoice,
  type ToolConversationMessage,
  type ToolProviderClient,
  type ToolProviderResponse,
  type ToolReasoningMode,
} from "./llm"

/** Resolves a provider name to a default model if none is given. */
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

const DEFAULT_RETRIES = 3
const BACKOFF_BASE_MS = 1_000
const BACKOFF_JITTER_MS = 1_000
const BACKOFF_MAX_MS = 16_000

/** Creates a retry-wrapped LLM text generator for the given provider. */
export function createGenerator(
  apiKey: string,
  provider: string,
  modelName?: string,
  maxRetries = DEFAULT_RETRIES,
): GenerateFn {
  const retries = Number.isFinite(maxRetries) && maxRetries >= 0 ? Math.floor(maxRetries) : DEFAULT_RETRIES
  const inner = createInnerGenerator(apiKey, provider, modelName)
  return withRetry(inner, retries)
}

/** Creates a retry-wrapped tool-calling provider client. */
export function createToolProvider(
  apiKey: string,
  provider: string,
  modelName?: string,
  maxRetries = DEFAULT_RETRIES,
  options: ToolProviderOptions = {},
): ToolProviderClient {
  const retries = Number.isFinite(maxRetries) && maxRetries >= 0 ? Math.floor(maxRetries) : DEFAULT_RETRIES
  const inner = createInnerToolProvider(apiKey, provider, modelName, options)
  return {
    generate: withRetry(
      (input) => inner.generate(input),
      retries,
      (error) => !(error instanceof ToolProviderProtocolError || error instanceof ToolProviderTimeoutError),
    ),
  }
}

/** Dispatches to the provider-specific tool client factory. */
function createInnerToolProvider(
  apiKey: string,
  provider: string,
  modelName: string | undefined,
  options: ToolProviderOptions,
): ToolProviderClient {
  switch (provider) {
    case "gemini":
      return createGeminiToolClient(apiKey, modelName)
    case "deepseek":
      return createDeepseekToolClient(apiKey, modelName, options)
    default:
      throw new Error(`Unknown LLM provider: "${provider}". Supported: "gemini", "deepseek"`)
  }
}

/** Dispatches to the provider-specific generator factory. */
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

/** Wraps an async function with exponential-backoff retry logic. */
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
          const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempt + Math.random() * BACKOFF_JITTER_MS, BACKOFF_MAX_MS)
          await new Promise((r) => setTimeout(r, delay))
        }
      }
    }
    throw lastErr
  }
}
