import { z } from "zod"
import type { ToolConversationMessage, ToolProviderClient } from "../providers"
import { runTools, type ToolExecutionSummary, type ToolRunFailureReason } from "../runtime/tool-runner"
import type { ToolRegistry } from "../runtime/tools"
import type { LLMUsage } from "../types"
import type { DraftInput } from "./draft"

const SUBMIT_LINKEDIN_DRAFT = "submit_linkedin_draft"
const MAX_DRAFT_CHARACTERS = 10_000

const draftInputSchema = z.object({
  draft: z.string().trim().min(1).max(MAX_DRAFT_CHARACTERS),
})
const draftOutputSchema = z.object({ accepted: z.literal(true) })

const LINKEDIN_AGENT_PROMPT = `You are Kipp's LinkedIn writing agent.

Write a concise LinkedIn post of 150–300 words with:
- an engaging first-line hook;
- a brief personal story or observation;
- a clear takeaway or lesson;
- a final question or prompt for engagement; and
- a professional but conversational tone.

Use the supplied style instructions and source material. Silently review the complete draft against every requirement before submitting it. When the user supplies revision feedback, return a complete replacement draft that preserves the established topic and style while applying that feedback.

Call submit_linkedin_draft exactly once with the final draft. This is the only available action. Never request or claim to publish, archive, notify, or access credentials. Do not answer with prose outside the tool call.`

export interface LinkedInToolSessionResult {
  draft: string | null
  messages: ToolConversationMessage[]
  completed: boolean
  failureReason?: ToolRunFailureReason
  providerTurns: number
  toolCallCount: number
  toolNames: string[]
  toolExecutions: ToolExecutionSummary[]
  usage: LLMUsage
}

/** Builds the canonical native-tool transcript for a new LinkedIn draft. */
export function createLinkedInConversation(stylePrompt: string, input: DraftInput): ToolConversationMessage[] {
  const source = [
    input.title ? `Write a LinkedIn post about: ${input.title}` : "Write a LinkedIn post",
    `Context:\n${input.body}`,
  ]
  if (input.substackBody) source.push(`Reference material:\n${input.substackBody}`)
  return [
    { role: "system", text: `${LINKEDIN_AGENT_PROMPT}\n\nStyle instructions:\n${stylePrompt}` },
    { role: "user", text: source.join("\n\n") },
  ]
}

/** Adds real user revision feedback to a prior LinkedIn native-tool transcript. */
export function appendLinkedInFeedback(
  messages: ToolConversationMessage[],
  feedback: string,
): ToolConversationMessage[] {
  return [...messages, { role: "user", text: feedback }]
}

/** Runs one bounded LinkedIn generation or revision session and captures its typed draft handoff. */
export async function runLinkedInToolSession(
  provider: ToolProviderClient,
  initialMessages: ToolConversationMessage[],
): Promise<LinkedInToolSessionResult> {
  let draft: string | null = null
  const registry: ToolRegistry = {
    [SUBMIT_LINKEDIN_DRAFT]: {
      name: SUBMIT_LINKEDIN_DRAFT,
      description:
        "Submit the complete LinkedIn draft candidate for deterministic workflow validation and human review. This does not publish.",
      input: draftInputSchema,
      output: draftOutputSchema,
      privacy: "private",
      handler: async ({ draft: candidate }) => {
        draft = candidate.trim()
        return { accepted: true as const }
      },
    },
  }
  const result = await runTools(
    provider,
    registry,
    {
      allowedTools: [SUBMIT_LINKEDIN_DRAFT],
      handoffTools: [SUBMIT_LINKEDIN_DRAFT],
      requireHandoff: true,
      maxToolCallsPerTurn: 1,
      toolChoice: "required",
      reasoning: "disabled",
    },
    initialMessages,
  )
  return {
    draft: result.completed ? draft : null,
    messages: result.messages,
    completed: result.completed,
    failureReason: result.failureReason,
    providerTurns: result.providerTurns,
    toolCallCount: result.toolCallCount,
    toolNames: result.toolNames,
    toolExecutions: result.toolExecutions,
    usage: result.usage,
  }
}
