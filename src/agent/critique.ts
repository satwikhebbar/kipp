import type { ChecklistItem } from "../core/types"
import { type GenerateFn, messages, parseLLMJson } from "../providers/llm"

const CHECKLIST = [
  "Opening hook grabs attention within the first line",
  "Post is between 150 and 300 words",
  "Includes a brief personal story or observation",
  "Ends with a clear takeaway or lesson",
  "Ends with a question or prompt for engagement",
  "Tone is professional but conversational",
] as const

const SYSTEM_PROMPT = `You evaluate LinkedIn post drafts against a checklist.

For each item return:
{ "check": "<exact check text>", "passed": true/false, "feedback": "<what to fix or null if passed>" }

Only provide feedback for failed checks. Be specific and actionable.
Respond with a JSON array only, no explanation.`

export type CritiqueFn = (draft: string) => Promise<ChecklistItem[]>

/** Creates an agent that evaluates drafts against a LinkedIn post checklist. */
export function createCritiqueAgent(generate: GenerateFn): CritiqueFn {
  return async (draft) => {
    const prompt = [
      `Evaluate this draft:\n\n${draft}\n`,
      `Checklist:\n${CHECKLIST.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
    ].join("\n\n")

    const res = await generate(messages(SYSTEM_PROMPT, prompt))
    const items = parseLLMJson<ChecklistItem[]>(res.text)
    return items.map((item) => ({
      ...item,
      feedback: item.passed ? null : (item.feedback ?? null),
    }))
  }
}

export { CHECKLIST }
