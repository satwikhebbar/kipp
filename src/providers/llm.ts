import type { LLMResponse } from "../types"

export interface GenerateOptions {
  system?: string
  prompt: string
}

export type GenerateFn = (opts: GenerateOptions) => Promise<LLMResponse>

export function parseLLMJson<T>(text: string): T {
  const cleaned = text.replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/m, "$1").trim()
  return JSON.parse(cleaned) as T
}
