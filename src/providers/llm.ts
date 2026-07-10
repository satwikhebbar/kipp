import type { LLMResponse } from "../types"

export interface GenerateOptions {
  system?: string
  prompt: string
}

export type GenerateFn = (opts: GenerateOptions) => Promise<LLMResponse>
