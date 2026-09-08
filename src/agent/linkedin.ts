import { z } from "zod"
import type { ToolConversationMessage, ToolProviderClient } from "../providers"
import { type AgentSessionResult, persistableAgentMessages } from "../runtime/agent-session"
import { runTools } from "../runtime/tool-runner"
import type { ToolRegistry } from "../runtime/tools"
import type { DraftInput } from "./draft"

const SUBMIT_LINKEDIN_RESPONSE = "submit_linkedin_response"
const MAX_RESPONSE_CHARACTERS = 10_000 // bounds the conversational review message
export const MAX_POST_CHARACTERS = 3_000 // ponytail: LinkedIn UGC shareCommentary text limit

const linkedInInputSchema = z.object({
  response: z.string().trim().min(1).max(MAX_RESPONSE_CHARACTERS),
  post: z.string().trim().min(1).max(MAX_POST_CHARACTERS),
})
const draftOutputSchema = z.object({ accepted: z.literal(true) })

const LINKEDIN_AGENT_PROMPT = `You are Kipp's LinkedIn writing agent.

Use the supplied style instructions and source material as the authoritative requirements for the complete response. When the user supplies revision feedback, return a complete replacement of both response and post that preserves the established topic and style while applying that feedback.

Call submit_linkedin_response exactly once with both fields filled:
- post: the exact final LinkedIn post text, free of any conversational framing, alternatives, image suggestions, or explanatory headings. This is the only text that will be created as a LinkedIn draft.
- response: the author-facing review message. Any conversational context the author should see while reviewing (why a hook was chosen, image ideas, options considered) belongs here only.

This is the only available action. Never request or claim to publish, archive, notify, or access credentials. Do not answer with prose outside the tool call.`

export type LinkedInTerminalOutcome = { kind: "ready_for_review"; response: string; post: string }
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
  let post: string | null = null
  const registry: ToolRegistry = {
    [SUBMIT_LINKEDIN_RESPONSE]: {
      name: SUBMIT_LINKEDIN_RESPONSE,
      description:
        "Submit the LinkedIn review response and the exact post text for deterministic workflow delivery and human review. This does not publish.",
      input: linkedInInputSchema,
      output: draftOutputSchema,
      privacy: "private",
      batching: "isolated",
      handler: async ({ response: responseCandidate, post: postCandidate }) => {
        response = responseCandidate.trim()
        post = postCandidate.trim()
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
    terminal: result.completed && response && post ? { kind: "ready_for_review", response, post } : null,
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
