import { z } from "zod"
import { timingInstructionSchema } from "../notes/timing"
import { MAX_NOTE_CHARACTERS } from "../notes/types"
import type { ToolConversationMessage, ToolProviderClient } from "../providers"
import { persistableAgentMessages } from "../runtime/agent-session"
import { runTools } from "../runtime/tool-runner"
import type { ToolRegistry } from "../runtime/tools"

export const NOTES_PROVIDER = "openrouter"
export const NOTES_MODEL = "openai/gpt-6-luna"

export const DEFAULT_NOTES_PROMPT = `Write a brief Substack Note around one clear idea from the author's thoughts.
Audience: thoughtful readers interested in the author's observations and practical insights.
Voice: direct, natural and specific. Preserve the author's meaning and uncertainty. Avoid generic hooks, inflated claims, hashtags and invented personal experiences or facts.
Make the idea compelling without manufacturing controversy. Prefer a short paragraph or a few short paragraphs readable in under a minute.
This is a provisional default; the workflow owner's style prompt defines audience, voice and general editorial rules.`
const MAX_COMMENTARY_CHARACTERS = 1500
const TOOL = "submit_note"
const QUESTION_TOOL = "ask_note_question"
const inputSchema = z
  .object({
    commentary: z.string().trim().min(1).max(MAX_COMMENTARY_CHARACTERS),
    text: z.string().trim().min(1).max(MAX_NOTE_CHARACTERS),
    timing: timingInstructionSchema,
    linkCardAction: z.enum(["keep", "use-input", "remove"]).default("keep"),
  })
  .strict()
export type NotesDraft = z.infer<typeof inputSchema>
const MAX_TRANSCRIPT_CHARS = 100_000

/** Builds a drafting conversation whose tools return a draft or a necessary writing clarification for human review. */
export function createNotesConversation(prompt: string, thoughts: string): ToolConversationMessage[] {
  return [
    {
      role: "system",
      text: `You are Kipp's Notes writing agent. Follow the supplied style prompt. Call submit_note with concise author-facing commentary and the exact complete Note text. Commentary never becomes part of the Note. You cannot publish or access credentials. Do not claim publication. Ask ask_note_question only when necessary to clarify intent or facts; otherwise draft directly. Never invent facts. Link context is supplied separately. linkCardAction controls the embedded link card: keep preserves the existing card; use-input selects only the deterministic first input URL; remove explicitly removes the card. Omit card URLs from the Note body; ignore subsequent URLs. Never invent a card destination. Extract publication instructions separately in the required timing field. Use unchanged when no posting instruction is supplied (initial default: now; revisions: preserve current timing). Use now for explicit immediate publication; queue for the next available Buffer queue slot (no date/time). Use schedule for an exact date and HH:mm wall time, with an explicit IANA timezone or null for the configured default. Represent today/tomorrow/in N days as relative-days from this source message's receipt, never your clock; explicit calendar dates use absolute YYYY-MM-DD. For schedule source, use initial when preserving an unresolved instruction from the initial message, or current for a new/corrected timing instruction in the current message. Interpret weekdays/other date expressions using the supplied receipt and timezone context, never invent a timezone. Scheduling instructions never belong in the published Note. Vague timing, missing time/date, ambiguous zone abbreviations, or conflicting queue and exact-time instructions require timing kind clarify with a concise question. Timezone/DST/future validation is owned by code, not the style prompt. If answering an earlier timing question, supply the complete corrected schedule; if answering a writing question, preserve any original requested posting timing until resolved. Necessary clarifications count toward the same five writing sessions. Do not invent a posting schedule.\n\n${prompt}`,
    },
    { role: "user", text: thoughts },
  ]
}

/** Runs one bounded, non-mutating writing session using the shared native-tool runtime. */
export async function runNotesSession(provider: ToolProviderClient, messages: ToolConversationMessage[]) {
  if (JSON.stringify(messages).length > MAX_TRANSCRIPT_CHARS) throw new Error("Notes transcript limit")
  let draft: NotesDraft | null = null
  let question: string | null = null
  const registry: ToolRegistry = {
    [QUESTION_TOOL]: {
      name: QUESTION_TOOL,
      description: "Ask one concise necessary clarification before drafting. Cannot publish.",
      input: z.object({ question: z.string().trim().min(1).max(MAX_COMMENTARY_CHARACTERS) }).strict(),
      output: z.object({ accepted: z.literal(true) }),
      privacy: "private",
      batching: "isolated",
      handler: async (input) => {
        question = input.question
        return { accepted: true as const }
      },
    },
    [TOOL]: {
      name: TOOL,
      description:
        "Return exact Note text, separate commentary and a card action: keep, use-input, or remove. Does not publish.",
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
    {
      allowedTools: [TOOL, QUESTION_TOOL],
      handoffTools: [TOOL, QUESTION_TOOL],
      requireHandoff: true,
      reasoning: "disabled",
    },
    messages,
  )
  const persisted = persistableAgentMessages(result.messages)
  return {
    question: result.completed ? (question as string | null) : null,
    draft: result.completed ? (draft as NotesDraft | null) : null,
    messages: JSON.stringify(persisted).length <= MAX_TRANSCRIPT_CHARS ? persisted : messages,
    usage: result.usage,
    providerTurns: result.providerTurns,
    completed: result.completed,
  }
}
