import type { ClassificationResult } from "../core/types"
import { type GenerateFn, messages, parseLLMJson } from "../providers/llm"

const SYSTEM_PROMPT = `Given a reply from the author of a LinkedIn post draft, classify their intent.

- "approve": the author is satisfied, wants to publish as-is or with minor polish
- "feedback": the author wants changes, has suggestions or requests edits

If feedback, extract the core request as feedbackText. If approve, set feedbackText to null.
Respond with JSON only: {"action": "approve"|"feedback", "feedbackText": string|null}`

export type ClassifyFn = (replyText: string) => Promise<ClassificationResult>

/** Creates an agent that classifies author intent (approve/feedback) from a reply. */
export function createClassifyAgent(generate: GenerateFn): ClassifyFn {
  return async (replyText) => {
    const res = await generate(messages(SYSTEM_PROMPT, `Author's reply: ${replyText}`))
    return parseLLMJson<ClassificationResult>(res.text)
  }
}
