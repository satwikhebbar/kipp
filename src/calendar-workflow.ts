import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import { z } from "zod"
import {
  CALENDAR_TIMEZONE_DEFAULT,
  calendarDayBounds,
  managedEvent,
  managedEventIdentity,
  type OneOffProposal,
  scheduleOneOff,
  suggestOneOffAlternative,
} from "./calendar-scheduling"
import { createGoogleCalendarClient, GoogleCalendarError } from "./integrations/google-calendar"
import { createTelegramClient } from "./integrations/telegram"
import { createInteractionRouter, type InteractionRegistration } from "./interaction-router-client"
import { createToolProvider } from "./providers"
import { ToolProviderHttpError, ToolProviderProtocolError } from "./providers/llm"
import { logRuntime } from "./runtime/logging"
import { runTools, type ToolExecutionSummary } from "./runtime/tool-runner"
import type { ToolRegistry } from "./runtime/tools"
import { type Env, INTERACTION_KIND, type WorkflowInteractionKind } from "./types"

export interface CalendarWorkflowParams {
  chatId: string
  requestText: string
  telegramMessageId: number
}

type CalendarPlanningFailureCategory =
  | "no-submitted-proposal"
  | "no-decision"
  | "provider-or-tool-failure"
  | "provider-protocol"
  | `provider-http-${number}`

interface CalendarPlanningResult {
  proposal: OneOffProposal | null
  clarification?: string
  failureCategory?: CalendarPlanningFailureCategory
  providerTurns?: number
  toolCallCount?: number
  toolRunCompleted?: boolean
  toolNames?: string[]
  toolExecutions?: ToolExecutionSummary[]
}

type CalendarPlanningDecision =
  | { kind: "proposal"; proposal: OneOffProposal }
  | { kind: "clarification"; message: string }

interface CalendarPlanningAttempt {
  decision: CalendarPlanningDecision | null
  providerTurns: number
  toolCallCount: number
  toolRunCompleted: boolean
  toolNames: string[]
  toolExecutions: ToolExecutionSummary[]
}

type CalendarActionResponse =
  | { type: "timeout" }
  | { type: "action"; kind: WorkflowInteractionKind }
  | { type: "reply"; text: string }

/** Maps a provider failure to a safe, metadata-only Calendar planning category. */
function plannerFailureCategory(error: unknown): CalendarPlanningFailureCategory {
  if (error instanceof ToolProviderHttpError) return `provider-http-${error.status}`
  if (error instanceof ToolProviderProtocolError) return "provider-protocol"
  return "provider-or-tool-failure"
}

const CALENDAR_TOOL = {
  GET_AVAILABLE_SLOTS: "get_available_slots",
  SUBMIT_ONE_OFF_PROPOSAL: "submit_one_off_proposal",
  REQUEST_CLARIFICATION: "request_clarification",
} as const
const CALENDAR_UNAVAILABLE =
  "Google Calendar is not connected. Open /setup/google-calendar to connect it, then try again."
const CALENDAR_UNDERSTANDING_FALLBACK =
  "I couldn't work out the scheduling details. Please say what you want to do and when."
const CALENDAR_PLANNER_UNAVAILABLE = "I couldn't reach the calendar planner. Please try again shortly."
const CALENDAR_PLANNER_NO_DECISION =
  "The calendar planner didn't return a scheduling decision. Please retry your /calendar request."
const CALENDAR_CONFLICT = "That time is not free. Please send another time that works."
const CALENDAR_FAILURE = "I couldn't create that calendar block. Please try again shortly."
const CALENDAR_INTERACTION_TTL_MINUTES = 15
const MILLISECONDS_PER_MINUTE = 60_000
const CALENDAR_INTERACTION_TTL_MS = CALENDAR_INTERACTION_TTL_MINUTES * MILLISECONDS_PER_MINUTE
/** Maximum user interaction cycles for one Calendar workflow execution. */
const MAX_CALENDAR_INTERACTION_TURNS = 4

const fieldSourceSchema = z.enum(["explicit", "inferred"])
const sourcedField = <Value extends z.ZodTypeAny>(value: Value) => z.object({ value, source: fieldSourceSchema })

/**
 * The model submits extracted values together with their provenance. This is
 * deliberately separate from OneOffProposal: deterministic policy decides
 * which inferred values are permitted before a Calendar read or write.
 */
const proposalSchema = z.object({
  title: sourcedField(z.string()),
  localDate: sourcedField(z.string()).optional(),
  startTime: sourcedField(z.string()).optional(),
  durationMinutes: sourcedField(z.number().int()),
  classification: sourcedField(
    z.enum(["ordinary", "family-social", "school-pickup", "appointment", "maintenance", "physical"]),
  ),
  description: sourcedField(z.string()).optional(),
  location: sourcedField(z.string()).optional(),
  reminderMinutes: sourcedField(z.number().int()).optional(),
})
type SubmittedOneOffProposal = z.infer<typeof proposalSchema>

const MIN_DURATION_MINUTES = 15
const MAX_AVAILABILITY_DURATION_MINUTES = 240
const MAX_CLARIFICATION_MESSAGE_LENGTH = 240
const availabilityInputSchema = z.object({
  localDate: z.string(),
  durationMinutes: z.number().int().min(MIN_DURATION_MINUTES).max(MAX_AVAILABILITY_DURATION_MINUTES),
})
const availabilityOutputSchema = z.object({ slots: z.array(z.string()) })
const proposalOutputSchema = z.object({ accepted: z.literal(true) })
const MAX_CLARIFICATION_LENGTH = 240
const clarificationInputSchema = z.object({ message: z.string().trim().min(1).max(MAX_CLARIFICATION_LENGTH) })
const clarificationOutputSchema = z.object({ accepted: z.literal(true) })

/** Builds the static system prompt for the calendar planner agent. */
function plannerPrompt(): string {
  return "You are Kipp's personal calendar planner. Interpret the user's request, but do not invent facts.\n\nCall exactly one decision action: submit_one_off_proposal when you have enough information, or request_clarification when you do not. Use get_available_slots only when you need to choose a time. There are no other actions. Every submitted proposal field has a source: use explicit only when the user supplied or unambiguously confirmed that fact, and inferred only when you derived it. Do not submit a date unless the user supplied a specific date or relative-date phrase. Omit startTime when the user did not give a time; do not invent a clock time. If a prior clarification offered a specific available date and time, and the user clearly accepts it, do not look up availability again: submit that offered date and time with source explicit. Omit description, location, and reminderMinutes unless the user explicitly supplied them. A proposal must have a YYYY-MM-DD date and HH:mm time when time is explicit. A clarification must ask for the one specific missing or ambiguous detail; never use a generic request for more detail. After get_available_slots, use only submit_one_off_proposal or request_clarification. Generic defaults: personal calls 30 minutes, professional calls 15 minutes. Family/social without a usable time requires clarification. Do not include attendees, video links, private Calendar details, or any unsupported recurrence."
}

/** Builds the dynamic user context for the calendar planner agent. */
function plannerUserMessage(requestText: string, now: number, timeZone: string): string {
  const todayParts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(now))
    .filter((part) => part.type !== "literal")
  const localToday = Object.fromEntries(todayParts.map((part) => [part.type, part.value]))
  return `Today is ${localToday.year}-${localToday.month}-${localToday.day} in ${timeZone}.\n\nUser request: ${requestText}`
}

/** Preserves the immediately preceding Calendar question so concise replies such as “Proceed” retain their referent. */
function appendClarificationReply(requestText: string, question: string, reply: string): string {
  return `${requestText}\n\nCalendar planner asked: ${question}\nUser replied: ${reply}`
}

/** Returns calendar day bounds for a date, used by the planner's availability tool. */
function dateTimeForTool(localDate: string, timeZone: string): { timeMin: string; timeMax: string } | null {
  return calendarDayBounds(localDate, timeZone)
}

/** Converts source-tagged model extraction into a policy-approved proposal, or a focused clarification. */
function normalizeSubmittedProposal(
  submitted: SubmittedOneOffProposal,
): { proposal: OneOffProposal } | { clarification: string } {
  // The model may normalize an explicit phrase such as “next Friday” to ISO,
  // but it may never choose a calendar date the user did not supply.
  if (submitted.localDate?.source !== "explicit") {
    return { clarification: "What date should I schedule this for?" }
  }
  // A missing time is allowed: deterministic scheduling can choose a slot.
  // A supplied time, however, must come from the user's words.
  if (submitted.startTime && submitted.startTime.source !== "explicit")
    return { clarification: "What time would you like?" }
  // These fields are copied into the Calendar event, so never accept model-invented content.
  if (submitted.description && submitted.description.source !== "explicit")
    return { clarification: "Please provide the description you want included." }
  if (submitted.location && submitted.location.source !== "explicit")
    return { clarification: "Please provide the location you want included." }
  if (submitted.reminderMinutes && submitted.reminderMinutes.source !== "explicit")
    return { clarification: "What reminder would you like?" }
  return {
    proposal: {
      title: submitted.title.value,
      localDate: submitted.localDate.value,
      startTime: submitted.startTime?.value,
      durationMinutes: submitted.durationMinutes.value,
      dateIsExplicit: true,
      timeIsExplicit: Boolean(submitted.startTime),
      classification: submitted.classification.value,
      description: submitted.description?.value,
      location: submitted.location?.value,
      reminderMinutes: submitted.reminderMinutes?.value,
      needsClarification: false,
    },
  }
}

/** Uses the planner's bounded tool session to return either a proposal or one focused clarification question. */
async function planOneOff(env: Env, requestText: string): Promise<CalendarPlanningAttempt> {
  const timeZone = env.TIMEZONE || CALENDAR_TIMEZONE_DEFAULT
  const calendar = createGoogleCalendarClient(env)
  let decision: CalendarPlanningDecision | null = null
  function recordDecision(next: CalendarPlanningDecision): void {
    if (decision) throw new Error("Calendar planner attempted multiple decision actions")
    decision = next
  }
  const registry: ToolRegistry = {
    [CALENDAR_TOOL.GET_AVAILABLE_SLOTS]: {
      name: CALENDAR_TOOL.GET_AVAILABLE_SLOTS,
      description:
        "Return safe free start-time candidates for a local date and duration. It never returns Calendar event details.",
      input: availabilityInputSchema,
      output: availabilityOutputSchema,
      privacy: "private",
      handler: async ({ localDate, durationMinutes }) => {
        const bounds = dateTimeForTool(localDate, timeZone)
        if (!bounds) return { slots: [] }
        const busy = await calendar.getBusyIntervals(bounds.timeMin, bounds.timeMax)
        const synthetic: OneOffProposal = {
          title: "Availability search",
          localDate,
          durationMinutes,
          dateIsExplicit: true,
          timeIsExplicit: false,
          classification: "ordinary",
          needsClarification: false,
        }
        const scheduled = scheduleOneOff(synthetic, busy, timeZone)
        return { slots: "localStartTime" in scheduled ? [scheduled.localStartTime] : [] }
      },
    },
    [CALENDAR_TOOL.SUBMIT_ONE_OFF_PROPOSAL]: {
      name: CALENDAR_TOOL.SUBMIT_ONE_OFF_PROPOSAL,
      description:
        'Submit the single structured one-off proposal. This does not create a Calendar event. Every supplied proposal field MUST be an object, never a bare value: { value: <field value>, source: "explicit" | "inferred" }. For example, use title: { value: "Call Jamie", source: "explicit" }, localDate: { value: "2026-08-03", source: "explicit" }, and startTime: { value: "15:00", source: "explicit" }.',
      input: proposalSchema,
      output: proposalOutputSchema,
      privacy: "private",
      handler: async (submitted) => {
        const normalized = normalizeSubmittedProposal(submitted)
        recordDecision(
          "proposal" in normalized
            ? { kind: "proposal", proposal: normalized.proposal }
            : { kind: "clarification", message: normalized.clarification },
        )
        return { accepted: true }
      },
    },
    [CALENDAR_TOOL.REQUEST_CLARIFICATION]: {
      name: CALENDAR_TOOL.REQUEST_CLARIFICATION,
      description: "Ask one concise question for the specific missing or ambiguous scheduling detail.",
      input: clarificationInputSchema,
      output: clarificationOutputSchema,
      privacy: "private",
      handler: async ({ message }) => {
        recordDecision({ kind: "clarification", message })
        return { accepted: true }
      },
    },
  }
  const provider = createToolProvider(
    env.LLM_API_KEY,
    env.LLM_PROVIDER,
    env.LLM_MODEL,
    Number(env.LLM_MAX_RETRIES || "3"),
  )
  const handoffTools = [CALENDAR_TOOL.SUBMIT_ONE_OFF_PROPOSAL, CALENDAR_TOOL.REQUEST_CLARIFICATION]
  const result = await runTools(
    provider,
    registry,
    {
      allowedTools: Object.values(CALENDAR_TOOL),
      handoffTools,
      maxToolCallsPerTurn: 1,
      // DeepSeek V4 defaults to thinking mode. Calendar uses a bounded non-thinking native-tool session instead.
      reasoning: "disabled",
      // A Calendar turn must either read availability or produce a decision; prose is not an action.
      toolChoice: "required",
      // After an availability lookup, expose only the two handoff actions and require one of them.
      // An availability result or a rejected proposal is enough context to finish this decision.
      // Do not let the model repeat a private availability read after either one.
      nextAllowedTools: (executedTools) =>
        executedTools.some(
          (tool) => tool === CALENDAR_TOOL.GET_AVAILABLE_SLOTS || tool === CALENDAR_TOOL.SUBMIT_ONE_OFF_PROPOSAL,
        )
          ? handoffTools
          : Object.values(CALENDAR_TOOL),
    },
    [
      { role: "system", text: plannerPrompt() },
      { role: "user", text: plannerUserMessage(requestText, Date.now(), timeZone) },
    ],
  )
  return {
    decision: result.completed ? decision : null,
    providerTurns: result.providerTurns,
    toolCallCount: result.toolCallCount,
    toolRunCompleted: result.completed,
    toolNames: result.toolNames,
    toolExecutions: result.toolExecutions,
  }
}

/**
 * The Calendar workflow is deliberately separate from LinkedIn. Its planning
 * and deterministic write stages are added incrementally in this milestone.
 */
export class CalendarWorkflow extends WorkflowEntrypoint<Env, CalendarWorkflowParams> {
  override async run(event: WorkflowEvent<CalendarWorkflowParams>, step: WorkflowStep): Promise<void> {
    logRuntime(this.env, { workflow: event.instanceId, event: "calendar-workflow-run", outcome: "started" })
    let requestText = event.payload.requestText
    let interactionVersion = 0
    let retryUsed = false
    let editing = false
    // Keep Calendar's state transitions explicit; revisit a shared feedback-loop wrapper once its semantics align with LinkedIn.
    for (let interactionTurn = 0; interactionTurn < MAX_CALENDAR_INTERACTION_TURNS; interactionTurn++) {
      logRuntime(this.env, {
        workflow: event.instanceId,
        event: "calendar-planner-turn",
        outcome: "started",
        metrics: { turn: interactionTurn + 1 },
      })
      const planning = await step.do(`calendar-plan-${interactionTurn}`, async (): Promise<CalendarPlanningResult> => {
        try {
          const attempt = await planOneOff(this.env, requestText)
          const metrics = {
            providerTurns: attempt.providerTurns,
            toolCallCount: attempt.toolCallCount,
            toolRunCompleted: attempt.toolRunCompleted,
            toolNames: attempt.toolNames,
            toolExecutions: attempt.toolExecutions,
          }
          if (!attempt.decision) return { proposal: null, failureCategory: "no-decision", ...metrics }
          return attempt.decision.kind === "proposal"
            ? { proposal: attempt.decision.proposal, ...metrics }
            : { proposal: null, clarification: attempt.decision.message, ...metrics }
        } catch (error) {
          return { proposal: null, failureCategory: plannerFailureCategory(error) }
        }
      })
      const plannerDecision = planning.proposal ? "proposal" : planning.clarification ? "clarification" : "none"
      for (const toolExecution of planning.toolExecutions ?? []) {
        logRuntime(this.env, {
          workflow: event.instanceId,
          event: "calendar-planner-tool",
          tool: toolExecution.tool,
          outcome: toolExecution.outcome,
          failureCategory: toolExecution.failureCategory,
          ...(toolExecution.validationPaths?.length || toolExecution.validationErrors?.length
            ? {
                details: {
                  ...(toolExecution.validationPaths?.length
                    ? { validationPaths: toolExecution.validationPaths.join(",") }
                    : {}),
                  ...(toolExecution.validationErrors?.length
                    ? { validationErrors: toolExecution.validationErrors.join(";") }
                    : {}),
                },
              }
            : {}),
        })
      }
      logRuntime(this.env, {
        workflow: event.instanceId,
        event: `calendar-planner:${plannerDecision}`,
        outcome: planning.proposal || planning.clarification ? "succeeded" : "failed",
        failureCategory: planning.failureCategory,
        ...(planning.toolNames?.length ? { tool: planning.toolNames.join(",") } : {}),
        ...(planning.providerTurns === undefined
          ? {}
          : {
              metrics: {
                providerTurns: planning.providerTurns,
                toolCallCount: planning.toolCallCount ?? 0,
                toolRunCompleted: planning.toolRunCompleted ?? false,
              },
            }),
      })
      if (planning.clarification) {
        logRuntime(this.env, {
          workflow: event.instanceId,
          event: "calendar-transition",
          outcome: "succeeded",
          details: { from: "planning", to: "clarification" },
        })
        const reply = await this.promptForReply(
          step,
          event,
          ++interactionVersion,
          `calendar-clarification-${interactionTurn}`,
          planning.clarification,
          INTERACTION_KIND.CALENDAR_CLARIFICATION,
        )
        if (!reply) return
        requestText = appendClarificationReply(requestText, planning.clarification, reply)
        continue
      }
      if (!planning.proposal) {
        await this.notify(
          step,
          event.payload.chatId,
          planning.failureCategory === "no-submitted-proposal"
            ? CALENDAR_UNDERSTANDING_FALLBACK
            : planning.failureCategory === "no-decision"
              ? CALENDAR_PLANNER_NO_DECISION
              : CALENDAR_PLANNER_UNAVAILABLE,
        )
        return
      }
      const proposal = planning.proposal
      logRuntime(this.env, {
        workflow: event.instanceId,
        event: "calendar-transition",
        outcome: "succeeded",
        details: { from: "planning", to: "availability" },
      })
      const timeZone = this.env.TIMEZONE || CALENDAR_TIMEZONE_DEFAULT
      const bounds = proposal.localDate ? calendarDayBounds(proposal.localDate, timeZone) : null
      if (!bounds) {
        const reply = await this.promptForReply(
          step,
          event,
          ++interactionVersion,
          `calendar-date-${interactionTurn}`,
          "What date should I schedule this for?",
          INTERACTION_KIND.CALENDAR_CLARIFICATION,
        )
        if (!reply) return
        requestText = appendClarificationReply(requestText, "What date should I schedule this for?", reply)
        continue
      }
      try {
        const calendar = createGoogleCalendarClient(this.env)
        const busy = await step.do(`calendar-availability-${interactionTurn}`, () =>
          calendar.getBusyIntervals(bounds.timeMin, bounds.timeMax),
        )
        const scheduled = scheduleOneOff(proposal, busy, timeZone)
        if ("clarification" in scheduled) {
          const reply = await this.promptForReply(
            step,
            event,
            ++interactionVersion,
            `calendar-policy-${interactionTurn}`,
            scheduled.clarification,
            INTERACTION_KIND.CALENDAR_CLARIFICATION,
          )
          if (!reply) return
          requestText = appendClarificationReply(requestText, scheduled.clarification, reply)
          continue
        }
        if ("conflict" in scheduled) {
          logRuntime(this.env, {
            workflow: event.instanceId,
            event: "calendar-transition",
            outcome: "succeeded",
            details: { from: "availability", to: "conflict" },
          })
          const alternative = suggestOneOffAlternative(proposal, busy, timeZone)
          const response = await this.promptForConflict(
            step,
            event,
            ++interactionVersion,
            interactionTurn,
            alternative?.localStartTime,
          )
          if (response.type === "timeout") return
          if (response.type === "action" && response.kind === INTERACTION_KIND.CALENDAR_CONFLICT_CANCEL) return
          if (
            response.type === "action" &&
            response.kind === INTERACTION_KIND.CALENDAR_CONFLICT_ALTERNATIVE &&
            alternative
          ) {
            const correction = await this.writeAndConfirm(
              step,
              event,
              proposal,
              alternative,
              editing,
              ++interactionVersion,
            )
            if (!correction) return
            requestText = `${event.payload.requestText}\n\nCorrection: ${correction}`
            editing = true
            continue
          }
          const replacement =
            response.type === "reply"
              ? response.text
              : await this.promptForReply(
                  step,
                  event,
                  ++interactionVersion,
                  `calendar-replacement-time-${interactionTurn}`,
                  "Reply with a replacement time for this calendar block.",
                  INTERACTION_KIND.CALENDAR_CONFLICT_REPLACE,
                )
          if (!replacement) return
          requestText = `${requestText}\n\nReplacement time: ${replacement}`
          continue
        }
        const correction = await this.writeAndConfirm(step, event, proposal, scheduled, editing, ++interactionVersion)
        if (!correction) return
        requestText = `${event.payload.requestText}\n\nCorrection: ${correction}`
        editing = true
      } catch (error) {
        if (error instanceof GoogleCalendarError && error.kind === "authorization" && !retryUsed) {
          const retry = await this.promptForActions(
            step,
            event,
            ++interactionVersion,
            `calendar-reconnect-${interactionTurn}`,
            `${CALENDAR_UNAVAILABLE}\n\nReconnect, then tap Retry within 15 minutes.`,
            [
              ["Retry", INTERACTION_KIND.CALENDAR_RETRY],
              ["Cancel", INTERACTION_KIND.CALENDAR_CANCEL],
            ],
          )
          if (retry.type === "action" && retry.kind === INTERACTION_KIND.CALENDAR_RETRY) {
            retryUsed = true
            continue
          }
          return
        }
        await this.notify(step, event.payload.chatId, CALENDAR_FAILURE)
        return
      }
    }
    await this.notify(
      step,
      event.payload.chatId,
      "I still need one clear date and time. Please start a new /calendar request.",
    )
    logRuntime(this.env, { workflow: event.instanceId, event: "calendar-workflow-run", outcome: "succeeded" })
  }

  private async writeAndConfirm(
    step: WorkflowStep,
    event: WorkflowEvent<CalendarWorkflowParams>,
    proposal: OneOffProposal,
    scheduled: { start: string; end: string; reminderMinutes: number; localStartTime: string },
    editing: boolean,
    version: number,
  ): Promise<string | null> {
    const timeZone = this.env.TIMEZONE || CALENDAR_TIMEZONE_DEFAULT
    await step.do(`calendar-${editing ? "update" : "create"}-${version}`, async () => {
      const calendar = createGoogleCalendarClient(this.env)
      const identity = await managedEventIdentity(event.payload.chatId, event.payload.telegramMessageId)
      const managed = managedEvent(identity, proposal, scheduled, timeZone)
      if (editing) await calendar.updateManagedEvent(managed)
      else await calendar.createManagedEvent(managed)
    })
    logRuntime(this.env, {
      workflow: event.instanceId,
      event: "calendar-write",
      outcome: "succeeded",
      details: { operation: editing ? "update" : "create" },
    })
    const edit = await this.promptForActions(
      step,
      event,
      version,
      `calendar-confirmation-${version}`,
      `Added: ${proposal.title.trim()} on ${proposal.localDate} at ${scheduled.localStartTime} for ${proposal.durationMinutes} min. Reminder: ${scheduled.reminderMinutes} min.`,
      [["Edit", INTERACTION_KIND.CALENDAR_EDIT]],
    )
    if (edit.type !== "action" || edit.kind !== INTERACTION_KIND.CALENDAR_EDIT) return null
    const correction = await this.promptForReply(
      step,
      event,
      version + 1,
      `calendar-edit-feedback-${version}`,
      "Reply with the correction for this calendar block.",
      INTERACTION_KIND.CALENDAR_EDIT_FEEDBACK,
    )
    return correction
  }

  private async notify(step: WorkflowStep, chatId: string, message: string): Promise<void> {
    await step.do(`calendar-notify-${crypto.randomUUID()}`, async () => {
      await createTelegramClient(this.env.TELEGRAM_BOT_TOKEN).sendMessage(chatId, message)
    })
  }

  private async promptForReply(
    step: WorkflowStep,
    event: WorkflowEvent<CalendarWorkflowParams>,
    version: number,
    name: string,
    message: string,
    kind: WorkflowInteractionKind,
  ): Promise<string | null> {
    const response = await this.promptForActions(step, event, version, name, message, [["Reply", kind]], false)
    return response.type === "reply" ? response.text : null
  }

  private async promptForConflict(
    step: WorkflowStep,
    event: WorkflowEvent<CalendarWorkflowParams>,
    version: number,
    turn: number,
    alternative?: string,
  ): Promise<CalendarActionResponse> {
    const actions: Array<[string, WorkflowInteractionKind]> = []
    if (alternative) actions.push([`Use ${alternative}`, INTERACTION_KIND.CALENDAR_CONFLICT_ALTERNATIVE])
    actions.push(
      ["Choose another time", INTERACTION_KIND.CALENDAR_CONFLICT_REPLACE],
      ["Cancel", INTERACTION_KIND.CALENDAR_CONFLICT_CANCEL],
    )
    return this.promptForActions(
      step,
      event,
      version,
      `calendar-conflict-${turn}`,
      alternative ? `That time is not free. ${alternative} is available instead.` : CALENDAR_CONFLICT,
      actions,
    )
  }

  private async promptForActions(
    step: WorkflowStep,
    event: WorkflowEvent<CalendarWorkflowParams>,
    version: number,
    name: string,
    message: string,
    actions: Array<[string, WorkflowInteractionKind]>,
    keyboard = true,
  ): Promise<CalendarActionResponse> {
    const prepared = actions.map(([label, kind]) => ({
      label,
      kind,
      interactionId: crypto.randomUUID(),
      callbackToken: keyboard ? crypto.randomUUID() : undefined,
    }))
    const sent = await step.do(`${name}-notify`, async () =>
      createTelegramClient(this.env.TELEGRAM_BOT_TOKEN).sendMessage(
        event.payload.chatId,
        message,
        keyboard
          ? {
              replyMarkup: {
                inline_keyboard: [
                  prepared
                    .filter((action) => action.callbackToken)
                    .map((action) => ({ text: action.label, callback_data: action.callbackToken })),
                ],
              },
            }
          : { replyMarkup: { force_reply: true } },
      ),
    )
    await step.do(`${name}-register`, async () => {
      const router = createInteractionRouter(this.env.INTERACTION_ROUTER, event.payload.chatId)
      const expiresAt = Date.now() + CALENDAR_INTERACTION_TTL_MS
      await Promise.all(
        prepared.map(
          (action): Promise<{ ok: boolean }> =>
            router.register({
              interactionId: action.interactionId,
              version,
              workflowId: event.instanceId,
              kind: action.kind,
              callbackToken: action.callbackToken,
              botMessageId: sent.messageId,
              expiresAt,
              interactionGroup: "calendar",
            } satisfies InteractionRegistration),
        ),
      )
    })
    for (const action of prepared) {
      logRuntime(this.env, {
        workflow: event.instanceId,
        interactionId: action.interactionId,
        event: "calendar-interaction",
        outcome: "started",
        details: { interactionKind: action.kind, mode: action.callbackToken ? "callback" : "reply", version },
      })
    }
    const reply = await step.waitForEvent<{ text?: string }>(`${name}-wait`, {
      type: "telegram-reply",
      timeout: "15 minutes" as never,
    })
    if (reply.type === "timeout") {
      logRuntime(this.env, {
        workflow: event.instanceId,
        event: "calendar-interaction",
        outcome: "ignored",
        details: { reason: "timeout", version },
      })
      return { type: "timeout" }
    }
    const text = reply.payload?.text
    if (!text) {
      logRuntime(this.env, {
        workflow: event.instanceId,
        event: "calendar-interaction",
        outcome: "ignored",
        details: { reason: "empty-event", version },
      })
      return { type: "timeout" }
    }
    const matchedAction = prepared.find((action) => text === `__${action.kind}__`)
    logRuntime(this.env, {
      workflow: event.instanceId,
      interactionId: (reply.payload as { interactionId?: string } | undefined)?.interactionId,
      event: "calendar-interaction",
      outcome: "succeeded",
      details: {
        response: matchedAction ? "action" : "reply",
        ...(matchedAction ? { interactionKind: matchedAction.kind } : {}),
        version,
      },
    })
    return matchedAction ? { type: "action", kind: matchedAction.kind } : { type: "reply", text }
  }
}
