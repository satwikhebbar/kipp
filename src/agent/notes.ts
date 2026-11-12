import { z } from "zod"
import { MAX_NOTE_CHARACTERS } from "../notes/types"
import type { ToolConversationMessage, ToolProviderClient } from "../providers"
import { persistableAgentMessages } from "../runtime/agent-session"
import { runTools } from "../runtime/tool-runner"
import type { ToolRegistry } from "../runtime/tools"

export const DEFAULT_NOTES_PROMPT = `Write a brief Substack Note around one clear idea from the author's thoughts.
Audience: thoughtful readers interested in the author's observations and practical insights.
Voice: direct, natural and specific. Preserve the author's meaning and uncertainty. Avoid generic hooks, inflated claims, hashtags and invented personal experiences or facts.
Make the idea compelling without manufacturing controversy. Prefer a short paragraph or a few short paragraphs readable in under a minute.
This is a provisional default; the workflow owner's style prompt defines audience, voice and general editorial rules.`
const MAX_COMMENTARY_CHARACTERS = 1500
const TOOL = "submit_note"
const inputSchema = z
  .object({
    commentary: z.string().trim().min(1).max(MAX_COMMENTARY_CHARACTERS),
    text: z.string().trim().min(1).max(MAX_NOTE_CHARACTERS),
  })
  .strict()
export type NotesDraft = z.infer<typeof inputSchema>
const MAX_TRANSCRIPT_CHARS = 100_000

/** Builds a drafting conversation whose only tool returns text for human review. */
export function createNotesConversation(prompt: string, thoughts: string): ToolConversationMessage[] {
  return [
    {
      role: "system",
      text: `You are Kipp's Notes writing agent. Follow the supplied style prompt. Call submit_note with concise author-facing commentary and the exact complete Note text. Commentary never becomes part of the Note. You cannot publish or access credentials. Do not claim publication. This phase supports immediate text-only Notes; do not invent links or a posting schedule.\n\n${prompt}`,
    },
    { role: "user", text: thoughts },
  ]
}

/** Runs one bounded, non-mutating writing session using the shared native-tool runtime. */
export async function runNotesSession(provider: ToolProviderClient, messages: ToolConversationMessage[]) {
  if (JSON.stringify(messages).length > MAX_TRANSCRIPT_CHARS) throw new Error("Notes transcript limit")
  let draft: NotesDraft | null = null
  const registry: ToolRegistry = {
    [TOOL]: {
      name: TOOL,
      description: "Return exact Note text and separate review commentary. Does not publish.",
      input: inputSchema,
      output: z.object({ accepted: z.literal(true) }),
      privacy: "private",
      batching: "isolated",
      handler: async (input) => {
        draft = input
        return { accepted: true as const }
      },
    },
  }
  const result = await runTools(
    provider,
    registry,
    { allowedTools: [TOOL], handoffTools: [TOOL], requireHandoff: true },
    messages,
  )
  const persisted = persistableAgentMessages(result.messages)
  return {
    draft: result.completed ? (draft as NotesDraft | null) : null,
    messages: JSON.stringify(persisted).length <= MAX_TRANSCRIPT_CHARS ? persisted : messages,
    usage: result.usage,
    providerTurns: result.providerTurns,
    completed: result.completed,
  }
}
