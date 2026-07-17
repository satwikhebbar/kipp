import type { LLMResponse } from "../types"

export type LLMRole = "system" | "user" | "assistant"

export interface LLMMessage {
  role: LLMRole
  content: string
}

export interface GenerateOptions {
  messages: LLMMessage[]
}

export type GenerateFn = (opts: GenerateOptions) => Promise<LLMResponse>

export function parseLLMJson<T>(text: string): T {
  const cleaned = text.replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/m, "$1").trim()
  return JSON.parse(cleaned) as T
}

export function messages(system: string | undefined, user: string): GenerateOptions {
  const out: LLMMessage[] = []
  if (system) out.push({ role: "system", content: system })
  out.push({ role: "user", content: user })
  return { messages: out }
}
