import type { GenerateFn, LLMMessage } from "../providers/llm"

export interface DraftInput {
  title?: string
  body: string
  substackBody?: string
}

export type DraftFn = (input: DraftInput) => Promise<string>

const FORMAT_DIRECTIVE =
  "Write a concise LinkedIn post (150-300 words) with an engaging hook, a short personal angle, a clear takeaway, and a question or prompt to drive engagement."

export function createDraftConversation(stylePrompt: string, input: DraftInput): LLMMessage[] {
  const parts = [
    input.title ? `Write a LinkedIn post about: ${input.title}` : "Write a LinkedIn post",
    `Context:\n${input.body}`,
  ]
  if (input.substackBody) parts.push(`Reference material:\n${input.substackBody}`)
  parts.push(FORMAT_DIRECTIVE)
  return [
    { role: "system", content: stylePrompt },
    { role: "user", content: parts.join("\n\n") },
  ]
}

export function createDraftAgent(generate: GenerateFn, stylePrompt: string): DraftFn {
  return async (input) => {
    const res = await generate({ messages: createDraftConversation(stylePrompt, input) })
    return res.text.trim()
  }
}
