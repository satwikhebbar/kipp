import type { GenerateFn } from "../providers/llm"
import type { ClassificationResult } from "../types"

const SYSTEM_PROMPT = `Given a reply from the author of a LinkedIn post draft, classify their intent.

- "approve": the author is satisfied, wants to publish as-is or with minor polish
- "feedback": the author wants changes, has suggestions or requests edits

If feedback, extract the core request as feedbackText. If approve, set feedbackText to null.
Respond with JSON only: {"action": "approve"|"feedback", "feedbackText": string|null}`

export type ClassifyFn = (replyText: string) => Promise<ClassificationResult>

export function createClassifyAgent(generate: GenerateFn): ClassifyFn {
  return async (replyText) => {
    const res = await generate({ system: SYSTEM_PROMPT, prompt: `Author's reply: ${replyText}` })
    return JSON.parse(res.text) as ClassificationResult
  }
}
