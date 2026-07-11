import type { GenerateFn } from "../providers/llm"
import type { ChecklistItem } from "../types"

export interface ReviseInput {
  draft: string
  failedItems: ChecklistItem[]
  humanFeedback?: string
}

export type ReviseFn = (input: ReviseInput) => Promise<string>

const SYSTEM_PROMPT = `You revise LinkedIn post drafts based on critique feedback.

Preserve what works. Fix only the issues listed. Keep the same general topic and tone.
Output the revised draft text only — no preamble, no JSON, no commentary.`

export function createReviseAgent(generate: GenerateFn): ReviseFn {
  return async ({ draft, failedItems, humanFeedback }) => {
    const parts = [
      `Original draft:\n${draft}`,
      `Issues to fix:\n${failedItems.map((i) => `- ${i.check}${i.feedback ? `: ${i.feedback}` : ""}`).join("\n")}`,
    ]
    if (humanFeedback) parts.push(`Additional feedback from the author:\n${humanFeedback}`)

    const res = await generate({ system: SYSTEM_PROMPT, prompt: parts.join("\n\n") })
    return res.text.trim()
  }
}
