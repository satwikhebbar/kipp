import type { GenerateFn } from "../providers/llm"

export interface DraftInput {
  title: string
  body: string
  substackBody?: string
}

export type DraftFn = (input: DraftInput) => Promise<string>

export function createDraftAgent(generate: GenerateFn, stylePrompt: string): DraftFn {
  return async ({ title, body, substackBody }) => {
    const parts = [`Write a LinkedIn post about: ${title}`, `Context:\n${body}`]
    if (substackBody) parts.push(`Reference material:\n${substackBody}`)
    parts.push(
      "Write a concise LinkedIn post (150-300 words) with an engaging hook, a short personal angle, a clear takeaway, and a question or prompt to drive engagement.",
    )

    const res = await generate({ system: stylePrompt, prompt: parts.join("\n\n") })
    return res.text.trim()
  }
}
