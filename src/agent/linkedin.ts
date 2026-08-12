import { z } from "zod"
import type { ToolConversationMessage, ToolProviderClient } from "../providers"
import { type AgentSessionResult, persistableAgentMessages } from "../runtime/agent-session"
import { runTools } from "../runtime/tool-runner"
import type { ToolRegistry } from "../runtime/tools"
import type { DraftInput } from "./draft"

const SUBMIT_LINKEDIN_RESPONSE = "submit_linkedin_response"
const MAX_RESPONSE_CHARACTERS = 10_000

const responseInputSchema = z.object({
  response: z.string().trim().min(1).max(MAX_RESPONSE_CHARACTERS),
})
const draftOutputSchema = z.object({ accepted: z.literal(true) })

const LINKEDIN_AGENT_PROMPT = `You are Kipp's LinkedIn writing agent.

Use the supplied style instructions and source material as the authoritative requirements for the complete response. When the user supplies revision feedback, return a complete replacement response that preserves the established topic and style while applying that feedback.

Call submit_linkedin_response exactly once with the complete response exactly as it should appear for human review, including every requested alternative or recommendation. This is the only available action. Never request or claim to publish, archive, notify, or access credentials. Do not answer with prose outside the tool call.`

export type LinkedInTerminalOutcome = { kind: "ready_for_review"; response: string }
export type LinkedInToolSessionResult = AgentSessionResult<LinkedInTerminalOutcome>

/** Builds the canonical native-tool transcript for a new LinkedIn response. */
export function createLinkedInConversation(stylePrompt: string, input: DraftInput): ToolConversationMessage[] {
  const source = [input.title ? `Topic: ${input.title}` : "Topic: LinkedIn post", `Context:\n${input.body}`]
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

/** Runs one bounded LinkedIn generation or revision session and captures its complete response handoff. */
export async function runLinkedInToolSession(
  provider: ToolProviderClient,
  initialMessages: ToolConversationMessage[],
): Promise<LinkedInToolSessionResult> {
  let response: string | null = null
  const registry: ToolRegistry = {
    [SUBMIT_LINKEDIN_RESPONSE]: {
      name: SUBMIT_LINKEDIN_RESPONSE,
      description:
        "Submit the complete LinkedIn response for deterministic workflow delivery and human review. This does not publish.",
      input: responseInputSchema,
      output: draftOutputSchema,
      privacy: "private",
      batching: "isolated",
      handler: async ({ response: candidate }) => {
        response = candidate.trim()
        return { accepted: true as const }
      },
    },
  }
  const result = await runTools(
    provider,
    registry,
    {
      allowedTools: [SUBMIT_LINKEDIN_RESPONSE],
      handoffTools: [SUBMIT_LINKEDIN_RESPONSE],
      requireHandoff: true,
    },
    initialMessages,
  )
  return {
    terminal: result.completed && response ? { kind: "ready_for_review", response } : null,
    messages: persistableAgentMessages(result.messages),
    completed: result.completed,
    failureReason: result.failureReason,
    providerTurns: result.providerTurns,
    toolCallCount: result.toolCallCount,
    toolNames: result.toolNames,
    toolExecutions: result.toolExecutions,
    usage: result.usage,
  }
}
