import type { ChecklistItem } from "../core/types"
import type { GenerateFn, LLMMessage } from "../providers/llm"

export interface ReviseInput {
  messages: LLMMessage[]
  failedItems: ChecklistItem[]
  humanFeedback?: string
}

export type ReviseFn = (input: ReviseInput) => Promise<string>

const REVISION_INSTRUCTION = `Revise the latest draft in this conversation. Preserve the established style and topic. Fix only the issues listed below. Output the revised draft text only — no preamble, no JSON, no commentary.`

/** Builds the conversation messages for revision with feedback. */
export function buildReviseConversation(input: ReviseInput): LLMMessage[] {
  const out: LLMMessage[] = [...input.messages]
  const parts = [REVISION_INSTRUCTION]
  const failed = input.failedItems.filter((c) => !c.passed)
  if (failed.length > 0) {
    parts.push(`Issues to fix:\n${failed.map((i) => `- ${i.check}${i.feedback ? `: ${i.feedback}` : ""}`).join("\n")}`)
  }
  out.push({ role: "user", content: parts.join("\n\n") })
  if (input.humanFeedback) {
    out.push({ role: "user", content: input.humanFeedback })
  }
  return out
}

/** Creates a revision agent that revises drafts based on checklist feedback. */
export function createReviseAgent(generate: GenerateFn): ReviseFn {
  return async (input) => {
    const res = await generate({ messages: buildReviseConversation(input) })
    return res.text.trim()
  }
}
