import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers"
import { type ActionPromptOutcome, promptForActions } from "../core/action-prompt"
import { presentConversationTurn } from "../core/conversation-presenter"
import { createConversationTurn } from "../core/conversation-turn"
import { CALENDAR_INVITE_ACTION_GROUP, type Env, type WorkflowInteractionKind } from "../core/types"
import { createTelegramClient } from "../integrations/telegram"
import type { CalendarWorkflowParams } from "./workflow"

const CALENDAR_INTERACTION_TTL_MINUTES = 15
const MILLISECONDS_PER_MINUTE = 60_000
export const CALENDAR_INTERACTION_TTL_MS = CALENDAR_INTERACTION_TTL_MINUTES * MILLISECONDS_PER_MINUTE
export const CALENDAR_CANCELLED = "Cancelled. No calendar event was created."

type CalendarActionResponse = ActionPromptOutcome

/** Calendar-scoped adapter over the shared action prompt that keeps caller ergonomics stable. */
export function calendarPromptForActions(
  env: Env,
  step: WorkflowStep,
  event: WorkflowEvent<CalendarWorkflowParams>,
  version: number,
  name: string,
  message: string,
  actions: Array<[string, WorkflowInteractionKind]>,
  keyboard = true,
  turn = createConversationTurn(),
  kind: "connection" | "clarification" = "clarification",
  inviteActions = false,
): Promise<CalendarActionResponse> {
  return promptForActions({
    env,
    step,
    instanceId: event.instanceId,
    chatId: event.payload.chatId,
    version,
    name,
    message,
    actions,
    keyboard,
    turn,
    kind,
    ttlMs: CALENDAR_INTERACTION_TTL_MS,
    interactionGroup: inviteActions ? `${CALENDAR_INVITE_ACTION_GROUP}${event.instanceId}` : "calendar",
    logEventName: "calendar-interaction",
    ...(inviteActions ? { requireCallbackId: true, maxLabelChars: 20 } : {}),
  })
}

/** Returns the browser URL to authorize Google Calendar and Contacts together. */
export function calendarSetupUrl(env: Env, setupOrigin?: string): string {
  const origin = env.GOOGLE_CALENDAR_REDIRECT_ORIGIN?.trim() || setupOrigin?.trim()
  return `${origin?.replace(/\/+$/, "") ?? ""}/setup/google-calendar`
}

/** Sends one deterministic workflow notification through a durable step. */
export async function notify(
  env: Env,
  step: WorkflowStep,
  chatId: string,
  message: string,
  name: string,
  turn = createConversationTurn(),
): Promise<void> {
  turn.claim("failure")
  await presentConversationTurn({ kind: "failure", message }, ({ text, options }, index) =>
    step.do(`calendar-agent-notify-${name}${index ? `-${index}` : ""}`, () =>
      createTelegramClient(env.TELEGRAM_BOT_TOKEN).sendMessage(chatId, text, options),
    ),
  )
}

/** Sends a force-reply prompt and returns only a routed free-text response. */
export async function promptForReply(
  env: Env,
  step: WorkflowStep,
  event: WorkflowEvent<CalendarWorkflowParams>,
  version: number,
  name: string,
  message: string,
  kind: WorkflowInteractionKind,
  turn = createConversationTurn(),
): Promise<string | null> {
  const response = await calendarPromptForActions(
    env,
    step,
    event,
    version,
    name,
    message,
    [["Reply", kind]],
    false,
    turn,
  )
  return response.type === "reply" ? response.text : null
}
