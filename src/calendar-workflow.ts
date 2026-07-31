import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import { z } from "zod"
import {
  evaluateRecurrenceAvailability,
  expandRecurrence,
  managedRecurringEvent,
  type RecurrenceAdjustment,
  type RecurrenceAvailability,
  type RecurringOccurrence,
  type RecurringProposal,
} from "./calendar-recurrence"
import {
  CALENDAR_TIMEZONE_DEFAULT,
  calendarDayBounds,
  managedEvent,
  managedEventIdentity,
  type OneOffProposal,
  type ScheduledOneOff,
  scheduleOneOff,
  suggestOneOffAlternative,
} from "./calendar-scheduling"
import {
  type BusyInterval,
  createGoogleCalendarClient,
  GoogleCalendarError,
  type ManagedCalendarException,
} from "./integrations/google-calendar"
import { createTelegramClient } from "./integrations/telegram"
import { createInteractionRouter, type InteractionRegistration } from "./interaction-router-client"
import { createToolProvider } from "./providers"
import { ToolProviderHttpError, ToolProviderProtocolError } from "./providers/llm"
import { logRuntime } from "./runtime/logging"
import { runTools, type ToolExecutionSummary, type ToolRunFailureReason } from "./runtime/tool-runner"
import { ToolHandlerError, type ToolRegistry } from "./runtime/tools"
import { type Env, INTERACTION_KIND, type WorkflowInteractionKind } from "./types"

export interface CalendarWorkflowParams {
  chatId: string
  requestText: string
  telegramMessageId: number
}

type CalendarPlanningFailureCategory =
  | "no-submitted-proposal"
  | "no-decision"
  | "missing-required-handoff"
  | "provider-or-tool-failure"
  | "provider-protocol"
  | `provider-http-${number}`

interface CalendarPlanningResult {
  proposal: CalendarProposal | null
  clarification?: string
  dialogueFields?: CalendarDialogueFields
  failureCategory?: CalendarPlanningFailureCategory
  providerTurns?: number
  toolCallCount?: number
  toolRunCompleted?: boolean
  toolNames?: string[]
  toolExecutions?: ToolExecutionSummary[]
}

type CalendarPlanningDecision =
  | { kind: "proposal"; proposal: CalendarProposal; dialogueFields: CalendarDialogueFields }
  | { kind: "clarification"; message: string; dialogueFields: CalendarDialogueFields }

export interface CalendarPlanningAttempt {
  decision: CalendarPlanningDecision | null
  failureReason?: ToolRunFailureReason
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

/** The persisted block that an Edit correction may retain without re-scheduling it. */
interface CalendarEditBaseline {
  kind: "one-off"
  proposal: OneOffProposal
  scheduled: ScheduledOneOff
}

interface CalendarRecurringEditBaseline {
  kind: "recurring"
  proposal: RecurringProposal
  occurrences: RecurringOccurrence[]
  adjustments: RecurrenceAdjustment[]
  rrule: string
  humanCadence: string
  reminderMinutes: number
}

type CalendarProposal = OneOffProposal | RecurringProposal
type CalendarAnyEditBaseline = CalendarEditBaseline | CalendarRecurringEditBaseline

interface CalendarPendingConflict {
  localDate?: string
  requestedStartTime?: string
  offeredStartTime?: string
}

interface CalendarDialogueState {
  fields: CalendarDialogueFields
  recurringFields?: Partial<SubmittedRecurringProposal>
  pendingQuestion?: string
  pendingConflict?: CalendarPendingConflict
}

/** Maps a provider failure to a safe, metadata-only Calendar planning category. */
function plannerFailureCategory(error: unknown): CalendarPlanningFailureCategory {
  if (error instanceof ToolProviderHttpError) return `provider-http-${error.status}`
  if (error instanceof ToolProviderProtocolError) return "provider-protocol"
  return "provider-or-tool-failure"
}

const CALENDAR_TOOL = {
  SUBMIT_ONE_OFF_PROPOSAL: "submit_one_off_proposal",
  SUBMIT_RECURRING_PROPOSAL: "submit_recurring_proposal",
  REQUEST_CLARIFICATION: "request_clarification",
} as const
/**
 * Returns the browser URL for the Calendar OAuth setup route. The configured
 * redirect origin is also the public origin that serves this route. Workflows
 * have no request URL of their own, so they cannot otherwise derive it.
 */
function calendarSetupUrl(env: Env): string {
  const origin = env.GOOGLE_CALENDAR_REDIRECT_ORIGIN?.replace(/\/+$/, "")
  return origin ? `${origin}/setup/google-calendar` : "/setup/google-calendar"
}

/** Builds the user-facing Calendar authorization recovery message. */
function calendarUnavailableMessage(env: Env): string {
  return `Google Calendar is not connected. Open ${calendarSetupUrl(env)} to connect it, then try again.`
}
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
const MAX_CALENDAR_INTERACTION_TURNS = 8

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

const explicitSourceSchema = z.literal("explicit")
const providedField = <Value extends z.ZodTypeAny>(value: Value) =>
  z.object({ state: z.literal("provided"), value, source: explicitSourceSchema })
const omittedField = z.object({ state: z.literal("omitted") })
const recurringStartTimeSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("provided"), value: z.string(), source: explicitSourceSchema }),
  z.object({ state: z.literal("policy_default") }),
])
const recurrenceRuleSchema = z.discriminatedUnion("cadence", [
  z.object({ cadence: z.literal("daily"), source: explicitSourceSchema }),
  z.object({
    cadence: z.literal("weekly"),
    source: explicitSourceSchema,
    weekdays: z.discriminatedUnion("mode", [
      z.object({
        mode: z.literal("named"),
        values: z.array(z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"])).min(1),
        source: explicitSourceSchema,
      }),
      z.object({ mode: z.literal("first_date_weekday") }),
    ]),
  }),
  z.object({ cadence: z.literal("biweekly"), source: explicitSourceSchema }),
  z.object({ cadence: z.literal("monthly"), source: explicitSourceSchema }),
  z.object({ cadence: z.literal("bimonthly"), source: explicitSourceSchema }),
])
const recurrenceEndSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("default_horizon") }),
  z.object({ mode: z.literal("until"), inclusiveDate: z.string(), source: explicitSourceSchema }),
  z.object({ mode: z.literal("count"), occurrences: z.number().int(), source: explicitSourceSchema }),
])
const recurringProposalSchema = z.object({
  title: sourcedField(z.string()),
  firstDate: z.object({ value: z.string(), source: explicitSourceSchema }),
  startTime: recurringStartTimeSchema,
  durationMinutes: sourcedField(z.number().int()),
  classification: sourcedField(
    z.enum(["ordinary", "family-social", "school-pickup", "appointment", "maintenance", "physical"]),
  ),
  recurrence: recurrenceRuleSchema,
  end: recurrenceEndSchema,
  description: z.discriminatedUnion("state", [providedField(z.string()), omittedField]),
  location: z.discriminatedUnion("state", [providedField(z.string()), omittedField]),
  reminderMinutes: z.discriminatedUnion("state", [providedField(z.number().int()), omittedField]),
})
type SubmittedRecurringProposal = z.infer<typeof recurringProposalSchema>
const dialogueFieldsSchema = proposalSchema.partial()
type CalendarDialogueFields = z.infer<typeof dialogueFieldsSchema>
const dialogueSnapshotField = <Value extends z.ZodTypeAny>(value: Value) =>
  z.object({
    source: z.enum(["missing", "explicit", "inferred"]),
    value: value.optional(),
  })
const dialogueSnapshotSchema = z.object({
  title: dialogueSnapshotField(z.string()),
  localDate: dialogueSnapshotField(z.string()),
  startTime: dialogueSnapshotField(z.string()),
  durationMinutes: dialogueSnapshotField(z.number().int()),
  classification: dialogueSnapshotField(
    z.enum(["ordinary", "family-social", "school-pickup", "appointment", "maintenance", "physical"]),
  ),
  description: dialogueSnapshotField(z.string()),
  location: dialogueSnapshotField(z.string()),
  reminderMinutes: dialogueSnapshotField(z.number().int()),
})
type CalendarDialogueSnapshot = z.infer<typeof dialogueSnapshotSchema>
const calendarFieldNameSchema = z.enum([
  "title",
  "localDate",
  "startTime",
  "durationMinutes",
  "classification",
  "description",
  "location",
  "reminderMinutes",
  "firstDate",
  "recurrence",
  "end",
])

const proposalOutputSchema = z.object({ accepted: z.literal(true) })
const MAX_CLARIFICATION_LENGTH = 240
const clarificationInputSchema = z.object({
  message: z.string().trim().min(1).max(MAX_CLARIFICATION_LENGTH),
  missingField: calendarFieldNameSchema,
  fields: dialogueSnapshotSchema,
  recurringFields: recurringProposalSchema.partial().optional(),
})
const clarificationOutputSchema = z.object({ accepted: z.literal(true) })

/** Builds the static system prompt for the calendar planner agent. */
function plannerPrompt(): string {
  return "You are Kipp's personal calendar planner. Interpret the user's request, but do not invent facts.\n\nCall exactly one decision action: submit_one_off_proposal for a one-off, submit_recurring_proposal for a supported recurrence, or request_clarification when a required fact is missing or ambiguous. There are no other actions. The supported recurrence classifications are daily, weekly, biweekly (every two weeks), monthly, and bimonthly (every two months). Clarify annual, ordinal, business-day, custom-interval, compound, or ambiguous recurrence phrases; never emit raw RRULE text. A recurring firstDate must be a user-explicit YYYY-MM-DD first occurrence. Weekly may carry one or more explicit named weekdays; biweekly is always anchored to firstDate. Recurrence end must be exactly default_horizon, an explicit inclusive until date, or an explicit occurrence count. Six calendar months is the hard maximum. Every key in submit_recurring_proposal is required: use policy_default for an unstated start time and omitted for unstated description, location, and reminderMinutes. Never omit those keys.\n\nEvery decision must preserve calendar fields learned so far with their source. Treat accumulated dialogue state as authoritative. Use explicit when the user's words supplied a fact, even when normalized, and inferred only for policy defaults. Do not submit a date unless the user supplied a specific date or relative-date phrase. During an Edit, retain unchanged baseline fields. Availability is checked by deterministic workflow code after handoff; occurrence alternatives are selected there too. Never claim a series or occurrence is free or unavailable. Calendar event details are not available to you. If the user asks why a time is unavailable, explain that only occupancy is visible. Description, location, and reminder overrides must be explicit. A clarification asks for one specific missing or ambiguous detail. Generic defaults: personal calls 30 minutes, professional calls 15 minutes. Family/social without a usable time requires clarification. Do not include attendees, video links, or private Calendar details."
}

/** Builds the dynamic user context for the calendar planner agent. */
function plannerUserMessage(
  requestText: string,
  now: number,
  timeZone: string,
  dialogueState?: CalendarDialogueState,
): string {
  const todayParts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(now))
    .filter((part) => part.type !== "literal")
  const localToday = Object.fromEntries(todayParts.map((part) => [part.type, part.value]))
  const state =
    dialogueState &&
    (Object.keys(dialogueState.fields).length || dialogueState.pendingQuestion || dialogueState.pendingConflict)
      ? `\n\nAccumulated Calendar dialogue state: ${JSON.stringify(dialogueState)}`
      : ""
  return `Today is ${localToday.year}-${localToday.month}-${localToday.day} in ${timeZone}.\n\nUser request: ${requestText}${state}`
}

/** Preserves the immediately preceding Calendar question so concise replies such as “Proceed” retain their referent. */
function appendClarificationReply(requestText: string, question: string, reply: string): string {
  return `${requestText}\n\nCalendar planner asked: ${question}\nUser replied: ${reply}`
}

/** Keeps a free-text response to a deterministic conflict neutral so the planner can infer its intent. */
function appendConflictReply(requestText: string, conflictMessage: string, reply: string): string {
  return `${requestText}\n\nCalendar workflow reported: ${conflictMessage}\nUser replied: ${reply}`
}

/** Preserves the persisted Calendar block as edit context without treating it as new user input. */
function appendEditCorrection(requestText: string, baseline: CalendarAnyEditBaseline, correction: string): string {
  if (baseline.kind === "one-off")
    return `${requestText}\n\nCurrent scheduled Calendar block (retain its date and time unless the correction changes them): ${baseline.proposal.localDate} at ${baseline.scheduled.localStartTime} for ${baseline.proposal.durationMinutes} min.\nUser correction: ${correction}`
  return `${requestText}\n\nCurrent recurring Calendar series (retain every field unless the correction changes it): ${JSON.stringify(
    {
      title: baseline.proposal.title,
      firstDate: baseline.proposal.firstDate,
      startTime: baseline.occurrences[0]?.localStartTime,
      durationMinutes: baseline.proposal.durationMinutes,
      recurrence: baseline.proposal.recurrence,
      end: baseline.proposal.end,
      description: baseline.proposal.description,
      location: baseline.proposal.location,
      reminderMinutes: baseline.proposal.reminderMinutes,
    },
  )}\nUser correction for the entire series: ${correction}`
}

/** Keeps earlier explicit facts when a later model turn merely infers or omits them. */
function mergeDialogueFields(current: CalendarDialogueFields, next: CalendarDialogueFields): CalendarDialogueFields {
  const merged: Record<string, unknown> = { ...current }
  for (const [name, value] of Object.entries(next)) {
    if (!value) continue
    const previous = merged[name] as { source?: string } | undefined
    if (previous?.source === "explicit" && value.source === "inferred") continue
    merged[name] = value
  }
  return dialogueFieldsSchema.parse(merged)
}

/** Converts a complete model snapshot into present, source-tagged Calendar fields. */
function snapshotDialogueFields(snapshot: CalendarDialogueSnapshot): CalendarDialogueFields {
  const fields: Record<string, unknown> = {}
  for (const [name, observation] of Object.entries(snapshot)) {
    if (observation.source === "missing") continue
    if (observation.value === undefined)
      throw new ToolHandlerError("Calendar dialogue snapshot omitted a known value", "invalid-state")
    fields[name] = { value: observation.value, source: observation.source }
  }
  return dialogueFieldsSchema.parse(fields)
}

/** Converts source-tagged model extraction into a policy-approved proposal, or a focused clarification. */
function normalizeSubmittedProposal(
  submitted: SubmittedOneOffProposal,
  editBaseline?: CalendarEditBaseline | null,
): { proposal: OneOffProposal } | { clarification: string } {
  // The model may normalize an explicit phrase such as “next Friday” to ISO,
  // but it may never choose a calendar date the user did not supply.
  if (!editBaseline && submitted.localDate?.source !== "explicit") {
    return { clarification: "What date should I schedule this for?" }
  }
  // A missing time is allowed: deterministic scheduling can choose a slot.
  // A supplied time, however, must come from the user's words.
  if (!editBaseline && submitted.startTime && submitted.startTime.source !== "explicit")
    return { clarification: "What time would you like?" }
  // These fields are copied into the Calendar event, so never accept model-invented content.
  if (submitted.description && submitted.description.source !== "explicit")
    return { clarification: "Please provide the description you want included." }
  if (submitted.location && submitted.location.source !== "explicit")
    return { clarification: "Please provide the location you want included." }
  if (submitted.reminderMinutes && submitted.reminderMinutes.source !== "explicit")
    return { clarification: "What reminder would you like?" }
  const localDate =
    submitted.localDate?.source === "explicit" ? submitted.localDate.value : editBaseline?.proposal.localDate
  if (!localDate) return { clarification: "What date should I schedule this for?" }
  const startTime =
    submitted.startTime?.source === "explicit" ? submitted.startTime.value : editBaseline?.scheduled.localStartTime
  return {
    proposal: {
      title: submitted.title.value,
      localDate,
      startTime,
      durationMinutes: submitted.durationMinutes.value,
      dateIsExplicit: true,
      timeIsExplicit: Boolean(startTime),
      classification: submitted.classification.value,
      description: submitted.description?.value,
      location: submitted.location?.value,
      reminderMinutes: submitted.reminderMinutes?.value,
      needsClarification: false,
    },
  }
}

/** Converts the recurring handoff's explicit presence states into the domain proposal. */
function normalizeSubmittedRecurringProposal(
  submitted: SubmittedRecurringProposal,
  editBaseline?: CalendarRecurringEditBaseline | null,
): RecurringProposal {
  const baseline = editBaseline?.proposal
  const recurrence =
    submitted.recurrence.cadence === "weekly"
      ? {
          cadence: "weekly" as const,
          weekdays:
            submitted.recurrence.weekdays.mode === "named"
              ? {
                  mode: "named" as const,
                  values: submitted.recurrence.weekdays.values,
                }
              : { mode: "first_date_weekday" as const },
        }
      : { cadence: submitted.recurrence.cadence }
  return {
    title: submitted.title.value || baseline?.title || "",
    firstDate: submitted.firstDate.value || baseline?.firstDate || "",
    startTime:
      submitted.startTime.state === "provided"
        ? submitted.startTime.value
        : editBaseline?.occurrences[0]?.localStartTime,
    timeIsExplicit: submitted.startTime.state === "provided" ? true : (editBaseline?.proposal.timeIsExplicit ?? false),
    durationMinutes: submitted.durationMinutes.value,
    classification: submitted.classification.value,
    recurrence,
    end:
      submitted.end.mode === "until"
        ? { mode: "until", inclusiveDate: submitted.end.inclusiveDate }
        : submitted.end.mode === "count"
          ? { mode: "count", occurrences: submitted.end.occurrences }
          : { mode: "default_horizon" },
    description: submitted.description.state === "provided" ? submitted.description.value : undefined,
    location: submitted.location.state === "provided" ? submitted.location.value : undefined,
    reminderMinutes: submitted.reminderMinutes.state === "provided" ? submitted.reminderMinutes.value : undefined,
  }
}

/** Uses the planner's bounded tool session to return either a proposal or one focused clarification question. */
export async function planOneOff(
  env: Env,
  requestText: string,
  editBaseline?: CalendarAnyEditBaseline | null,
  dialogueState: CalendarDialogueState = { fields: {} },
): Promise<CalendarPlanningAttempt> {
  const timeZone = env.TIMEZONE || CALENDAR_TIMEZONE_DEFAULT
  let decision: CalendarPlanningDecision | null = null
  function recordDecision(next: CalendarPlanningDecision): void {
    if (decision) throw new Error("Calendar planner attempted multiple decision actions")
    decision = next
  }
  const registry: ToolRegistry = {
    [CALENDAR_TOOL.SUBMIT_ONE_OFF_PROPOSAL]: {
      name: CALENDAR_TOOL.SUBMIT_ONE_OFF_PROPOSAL,
      description:
        'Submit the single structured one-off proposal. This does not create a Calendar event. Every supplied proposal field MUST be an object, never a bare value: { value: <field value>, source: "explicit" | "inferred" }. For example, use title: { value: "Call Jamie", source: "explicit" }, localDate: { value: "2026-08-03", source: "explicit" }, and startTime: { value: "15:00", source: "explicit" }.',
      input: proposalSchema,
      output: proposalOutputSchema,
      privacy: "private",
      handler: async (submitted) => {
        const dialogueFields = mergeDialogueFields(dialogueState.fields, submitted)
        const normalized = normalizeSubmittedProposal(
          proposalSchema.parse(dialogueFields),
          editBaseline?.kind === "one-off" ? editBaseline : null,
        )
        recordDecision(
          "proposal" in normalized
            ? { kind: "proposal", proposal: normalized.proposal, dialogueFields }
            : { kind: "clarification", message: normalized.clarification, dialogueFields },
        )
        return { accepted: true }
      },
    },
    [CALENDAR_TOOL.SUBMIT_RECURRING_PROPOSAL]: {
      name: CALENDAR_TOOL.SUBMIT_RECURRING_PROPOSAL,
      description:
        "Submit one complete supported recurring proposal. This does not access or write Calendar. Every key is structurally required. firstDate and recurrence must be explicit. Use policy_default for an unstated start time; use omitted states for unstated event text and reminder override.",
      input: recurringProposalSchema,
      output: proposalOutputSchema,
      privacy: "private",
      handler: async (submitted) => {
        const parsed = recurringProposalSchema.parse(submitted)
        dialogueState.recurringFields = parsed
        recordDecision({
          kind: "proposal",
          proposal: normalizeSubmittedRecurringProposal(
            parsed,
            editBaseline?.kind === "recurring" ? editBaseline : null,
          ),
          dialogueFields: dialogueState.fields,
        })
        return { accepted: true }
      },
    },
    [CALENDAR_TOOL.REQUEST_CLARIFICATION]: {
      name: CALENDAR_TOOL.REQUEST_CLARIFICATION,
      description:
        "Ask one concise question for the specific missing or ambiguous scheduling detail. The fields object must preserve every calendar field learned so far, including fields extracted from the latest user reply, together with each field's explicit or inferred source.",
      input: clarificationInputSchema,
      output: clarificationOutputSchema,
      privacy: "private",
      handler: async ({ message, missingField, fields, recurringFields }) => {
        const dialogueFields = mergeDialogueFields(dialogueState.fields, snapshotDialogueFields(fields))
        if (recurringFields)
          dialogueState.recurringFields = {
            ...dialogueState.recurringFields,
            ...recurringFields,
          }
        if (missingField === "startTime" && dialogueFields.localDate?.source !== "explicit")
          throw new ToolHandlerError(
            "A time clarification must preserve the explicit date it refers to",
            "invalid-state",
          )
        recordDecision({
          kind: "clarification",
          message,
          dialogueFields,
        })
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
  const decisionTools = [
    CALENDAR_TOOL.SUBMIT_ONE_OFF_PROPOSAL,
    CALENDAR_TOOL.SUBMIT_RECURRING_PROPOSAL,
    CALENDAR_TOOL.REQUEST_CLARIFICATION,
  ]
  const result = await runTools(
    provider,
    registry,
    {
      allowedTools: decisionTools,
      handoffTools: decisionTools,
      requireHandoff: true,
      maxToolCallsPerTurn: 1,
      // DeepSeek V4 defaults to thinking mode. Calendar uses a bounded non-thinking native-tool session instead.
      reasoning: "disabled",
      // A Calendar turn must produce a decision; prose is not an action.
      toolChoice: "required",
    },
    [
      { role: "system", text: plannerPrompt() },
      { role: "user", text: plannerUserMessage(requestText, Date.now(), timeZone, dialogueState) },
    ],
  )
  return {
    decision: result.completed ? decision : null,
    failureReason: result.failureReason,
    providerTurns: result.providerTurns,
    toolCallCount: result.toolCallCount,
    toolRunCompleted: result.completed,
    toolNames: result.toolNames,
    toolExecutions: result.toolExecutions,
  }
}

/** Returns whether a proposed edit retains the exact persisted start instant. */
function retainsScheduledStart(scheduled: ScheduledOneOff, baseline: CalendarEditBaseline): boolean {
  return scheduled.start === baseline.scheduled.start
}

/** Checks only the extra tail added by a duration extension, excluding the existing managed interval. */
function conflictsWithExtension(busy: BusyInterval[], current: ScheduledOneOff, proposed: ScheduledOneOff): boolean {
  const currentEnd = Date.parse(current.end)
  const proposedEnd = Date.parse(proposed.end)
  if (!Number.isFinite(currentEnd) || !Number.isFinite(proposedEnd) || proposedEnd <= currentEnd) return false
  return busy.some((interval) => {
    const busyStart = Date.parse(interval.start)
    const busyEnd = Date.parse(interval.end)
    return Number.isFinite(busyStart) && Number.isFinite(busyEnd) && busyStart < proposedEnd && busyEnd > currentEnd
  })
}

/** Narrows a successfully validated planner handoff to the recurring domain. */
function isRecurringProposal(proposal: CalendarProposal): proposal is RecurringProposal {
  return "firstDate" in proposal
}

/** Selects a compatible one-off baseline when the current proposal is one-off. */
function asOneOffEditBaseline(baseline: CalendarAnyEditBaseline | null): CalendarEditBaseline | null {
  return baseline?.kind === "one-off" ? baseline : null
}

/** Removes only the persisted Kipp series intervals from privacy-safe FreeBusy during whole-series Edit. */
function withoutRecurringBaseline(
  busy: BusyInterval[],
  baseline: CalendarRecurringEditBaseline | null,
): BusyInterval[] {
  if (!baseline) return busy
  const owned = new Set(
    baseline.occurrences.map((occurrence) => {
      const adjustment = baseline.adjustments.find((item) => item.localDate === occurrence.localDate)
      const scheduled = adjustment?.scheduled ?? occurrence
      return `${Date.parse(scheduled.start)}:${Date.parse(scheduled.end)}`
    }),
  )
  return busy.filter((interval) => !owned.has(`${Date.parse(interval.start)}:${Date.parse(interval.end)}`))
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
    let editBaseline: CalendarAnyEditBaseline | null = null
    const dialogueState: CalendarDialogueState = { fields: {} }
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
          const attempt = await planOneOff(this.env, requestText, editBaseline, dialogueState)
          const metrics = {
            providerTurns: attempt.providerTurns,
            toolCallCount: attempt.toolCallCount,
            toolRunCompleted: attempt.toolRunCompleted,
            toolNames: attempt.toolNames,
            toolExecutions: attempt.toolExecutions,
          }
          if (!attempt.decision)
            return {
              proposal: null,
              failureCategory:
                attempt.failureReason === "missing-required-handoff" ? "missing-required-handoff" : "no-decision",
              ...metrics,
            }
          return attempt.decision.kind === "proposal"
            ? {
                proposal: attempt.decision.proposal,
                dialogueFields: attempt.decision.dialogueFields,
                ...metrics,
              }
            : {
                proposal: null,
                clarification: attempt.decision.message,
                dialogueFields: attempt.decision.dialogueFields,
                ...metrics,
              }
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
                  ...(toolExecution.status === undefined ? {} : { httpStatus: toolExecution.status }),
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
      if (planning.dialogueFields) dialogueState.fields = planning.dialogueFields
      if (planning.clarification) {
        dialogueState.pendingQuestion = planning.clarification
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
            : planning.failureCategory === "no-decision" || planning.failureCategory === "missing-required-handoff"
              ? CALENDAR_PLANNER_NO_DECISION
              : CALENDAR_PLANNER_UNAVAILABLE,
        )
        return
      }
      const proposal = planning.proposal
      dialogueState.pendingQuestion = undefined
      logRuntime(this.env, {
        workflow: event.instanceId,
        event: "calendar-transition",
        outcome: "succeeded",
        details: { from: "planning", to: "availability" },
      })
      const timeZone = this.env.TIMEZONE || CALENDAR_TIMEZONE_DEFAULT
      if (isRecurringProposal(proposal)) {
        const expanded = expandRecurrence(proposal)
        if ("clarification" in expanded) {
          const reply = await this.promptForReply(
            step,
            event,
            ++interactionVersion,
            `calendar-recurrence-policy-${interactionTurn}`,
            expanded.clarification,
            INTERACTION_KIND.CALENDAR_CLARIFICATION,
          )
          if (!reply) return
          requestText = appendClarificationReply(requestText, expanded.clarification, reply)
          continue
        }
        const firstBounds = calendarDayBounds(expanded.dates[0], timeZone)
        const lastBounds = calendarDayBounds(expanded.dates.at(-1) as string, timeZone)
        if (!firstBounds || !lastBounds) {
          const message = "Please tell me a valid first date."
          const reply = await this.promptForReply(
            step,
            event,
            ++interactionVersion,
            `calendar-recurrence-date-${interactionTurn}`,
            message,
            INTERACTION_KIND.CALENDAR_CLARIFICATION,
          )
          if (!reply) return
          requestText = appendClarificationReply(requestText, message, reply)
          continue
        }
        try {
          const calendar = createGoogleCalendarClient(this.env)
          const readBusy = async (suffix: string): Promise<BusyInterval[]> =>
            withoutRecurringBaseline(
              await step.do(`calendar-recurrence-availability-${interactionTurn}-${suffix}`, () =>
                calendar.getBusyIntervals(firstBounds.timeMin, lastBounds.timeMax),
              ),
              editBaseline?.kind === "recurring" ? editBaseline : null,
            )
          let busy = await readBusy("initial")
          let availability = evaluateRecurrenceAvailability(proposal, busy, timeZone)
          if (availability.kind === "clarification") {
            const reply = await this.promptForReply(
              step,
              event,
              ++interactionVersion,
              `calendar-recurrence-clarification-${interactionTurn}`,
              availability.message,
              INTERACTION_KIND.CALENDAR_CLARIFICATION,
            )
            if (!reply) return
            requestText = appendClarificationReply(requestText, availability.message, reply)
            continue
          }
          if (availability.kind === "conflict") {
            const reply = await this.promptForReply(
              step,
              event,
              ++interactionVersion,
              `calendar-recurrence-replacement-${interactionTurn}`,
              "I couldn't find one safe time for the complete series. Reply with another series time.",
              INTERACTION_KIND.CALENDAR_RECURRENCE_NEW_TIME,
            )
            if (!reply) return
            requestText = `${requestText}\n\nReplacement time for the entire series: ${reply}`
            continue
          }
          if (availability.kind === "common-alternative") {
            const response = await this.promptForActions(
              step,
              event,
              ++interactionVersion,
              `calendar-recurrence-common-time-${interactionTurn}`,
              `At least half of the occurrences conflict. ${availability.localStartTime} is available for the complete series.`,
              [
                [`Use ${availability.localStartTime}`, INTERACTION_KIND.CALENDAR_CONFLICT_ALTERNATIVE],
                ["Try another series time", INTERACTION_KIND.CALENDAR_RECURRENCE_NEW_TIME],
                ["Cancel", INTERACTION_KIND.CALENDAR_CONFLICT_CANCEL],
              ],
            )
            if (
              response.type === "timeout" ||
              (response.type === "action" && response.kind === INTERACTION_KIND.CALENDAR_CONFLICT_CANCEL)
            )
              return
            if (response.type !== "action" || response.kind !== INTERACTION_KIND.CALENDAR_CONFLICT_ALTERNATIVE) {
              const reply =
                response.type === "reply"
                  ? response.text
                  : await this.promptForReply(
                      step,
                      event,
                      ++interactionVersion,
                      `calendar-recurrence-new-time-${interactionTurn}`,
                      "Reply with another time for the complete series.",
                      INTERACTION_KIND.CALENDAR_RECURRENCE_NEW_TIME,
                    )
              if (!reply) return
              requestText = `${requestText}\n\nReplacement time for the entire series: ${reply}`
              continue
            }
            const alternativeProposal: RecurringProposal = {
              ...proposal,
              startTime: availability.localStartTime,
              timeIsExplicit: true,
            }
            busy = await readBusy("revalidate-common")
            const revalidated = evaluateRecurrenceAvailability(alternativeProposal, busy, timeZone)
            if (revalidated.kind !== "available") {
              requestText = `${requestText}\n\nThe offered series time became unavailable; choose another time.`
              continue
            }
            availability = revalidated
          } else if (availability.kind === "adjustments") {
            const preview = availability.adjustments
              .map((adjustment) => `${adjustment.localDate} → ${adjustment.scheduled.localStartTime}`)
              .join(", ")
            const response = await this.promptForActions(
              step,
              event,
              ++interactionVersion,
              `calendar-recurrence-adjustments-${interactionTurn}`,
              `Some dates need a different time: ${preview}.`,
              [
                ["Create with adjustments", INTERACTION_KIND.CALENDAR_RECURRENCE_ADJUSTMENTS],
                ["Try another series time", INTERACTION_KIND.CALENDAR_RECURRENCE_NEW_TIME],
                ["Cancel", INTERACTION_KIND.CALENDAR_CONFLICT_CANCEL],
              ],
            )
            if (
              response.type === "timeout" ||
              (response.type === "action" && response.kind === INTERACTION_KIND.CALENDAR_CONFLICT_CANCEL)
            )
              return
            if (response.type !== "action" || response.kind !== INTERACTION_KIND.CALENDAR_RECURRENCE_ADJUSTMENTS) {
              const reply =
                response.type === "reply"
                  ? response.text
                  : await this.promptForReply(
                      step,
                      event,
                      ++interactionVersion,
                      `calendar-recurrence-adjustment-new-time-${interactionTurn}`,
                      "Reply with another time for the complete series.",
                      INTERACTION_KIND.CALENDAR_RECURRENCE_NEW_TIME,
                    )
              if (!reply) return
              requestText = `${requestText}\n\nReplacement time for the entire series: ${reply}`
              continue
            }
            busy = await readBusy("revalidate-adjustments")
            const revalidated = evaluateRecurrenceAvailability(proposal, busy, timeZone)
            if (
              revalidated.kind !== "adjustments" ||
              JSON.stringify(revalidated.adjustments) !== JSON.stringify(availability.adjustments)
            ) {
              requestText = `${requestText}\n\nCalendar availability changed; please choose another series time.`
              continue
            }
            availability = revalidated
          }
          const finalAvailability = availability
          if (finalAvailability.kind !== "available" && finalAvailability.kind !== "adjustments")
            throw new Error("Unexpected recurring availability outcome")
          const correction = await this.writeRecurringAndConfirm(
            step,
            event,
            proposal,
            finalAvailability,
            editing,
            ++interactionVersion,
          )
          if (!correction) return
          editBaseline = {
            kind: "recurring",
            proposal,
            occurrences: finalAvailability.occurrences,
            adjustments: finalAvailability.kind === "adjustments" ? finalAvailability.adjustments : [],
            rrule: finalAvailability.rrule,
            humanCadence: finalAvailability.humanCadence,
            reminderMinutes: finalAvailability.reminderMinutes,
          }
          requestText = appendEditCorrection(event.payload.requestText, editBaseline, correction)
          editing = true
          continue
        } catch (error) {
          if (error instanceof GoogleCalendarError && error.kind === "authorization" && !retryUsed) {
            const retry = await this.promptForActions(
              step,
              event,
              ++interactionVersion,
              `calendar-recurrence-reconnect-${interactionTurn}`,
              `${calendarUnavailableMessage(this.env)}\n\nReconnect, then tap Retry within 15 minutes.`,
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
          logRuntime(this.env, {
            workflow: event.instanceId,
            event: "calendar-workflow-failure",
            outcome: "failed",
            failureCategory: "calendar-recurrence-operation-failed",
            details: { stage: "recurrence-availability-or-write" },
          })
          await this.notify(step, event.payload.chatId, CALENDAR_FAILURE)
          return
        }
      }
      const oneOffEditBaseline = asOneOffEditBaseline(editBaseline)
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
        const provisional: ReturnType<typeof scheduleOneOff> | null = oneOffEditBaseline
          ? scheduleOneOff(proposal, [], timeZone)
          : null
        let busy: BusyInterval[] = []
        let scheduled: ReturnType<typeof scheduleOneOff>
        if (
          provisional &&
          "start" in provisional &&
          oneOffEditBaseline &&
          retainsScheduledStart(provisional, oneOffEditBaseline)
        ) {
          if (Date.parse(provisional.end) <= Date.parse(oneOffEditBaseline.scheduled.end)) scheduled = provisional
          else {
            busy = await step.do(`calendar-availability-${interactionTurn}`, () =>
              calendar.getBusyIntervals(bounds.timeMin, bounds.timeMax),
            )
            scheduled = conflictsWithExtension(busy, oneOffEditBaseline.scheduled, provisional)
              ? { conflict: true }
              : provisional
          }
        } else {
          busy = await step.do(`calendar-availability-${interactionTurn}`, () =>
            calendar.getBusyIntervals(bounds.timeMin, bounds.timeMax),
          )
          scheduled = scheduleOneOff(proposal, busy, timeZone)
        }
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
          dialogueState.pendingConflict = {
            localDate: proposal.localDate,
            requestedStartTime: proposal.startTime,
            offeredStartTime: alternative?.localStartTime,
          }
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
            dialogueState.pendingConflict = undefined
            const correction = await this.writeAndConfirm(
              step,
              event,
              proposal,
              alternative,
              editing,
              ++interactionVersion,
            )
            if (!correction) return
            editBaseline = { kind: "one-off", proposal, scheduled: alternative }
            requestText = appendEditCorrection(event.payload.requestText, editBaseline, correction)
            editing = true
            continue
          }
          const replacement =
            response.type === "reply"
              ? appendConflictReply(requestText, this.conflictMessage(alternative?.localStartTime), response.text)
              : await this.promptForReply(
                  step,
                  event,
                  ++interactionVersion,
                  `calendar-replacement-time-${interactionTurn}`,
                  "Reply with a replacement time for this calendar block.",
                  INTERACTION_KIND.CALENDAR_CONFLICT_REPLACE,
                )
          if (!replacement) return
          requestText = response.type === "reply" ? replacement : `${requestText}\n\nReplacement time: ${replacement}`
          continue
        }
        dialogueState.pendingConflict = undefined
        const correction = await this.writeAndConfirm(step, event, proposal, scheduled, editing, ++interactionVersion)
        if (!correction) return
        editBaseline = { kind: "one-off", proposal, scheduled }
        requestText = appendEditCorrection(event.payload.requestText, editBaseline, correction)
        editing = true
      } catch (error) {
        if (error instanceof GoogleCalendarError && error.kind === "authorization" && !retryUsed) {
          const retry = await this.promptForActions(
            step,
            event,
            ++interactionVersion,
            `calendar-reconnect-${interactionTurn}`,
            `${calendarUnavailableMessage(this.env)}\n\nReconnect, then tap Retry within 15 minutes.`,
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
        logRuntime(this.env, {
          workflow: event.instanceId,
          event: "calendar-workflow-failure",
          outcome: "failed",
          failureCategory: "calendar-operation-failed",
          details: { stage: "availability-or-write" },
        })
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

  private async writeRecurringAndConfirm(
    step: WorkflowStep,
    event: WorkflowEvent<CalendarWorkflowParams>,
    proposal: RecurringProposal,
    availability: Extract<RecurrenceAvailability, { kind: "available" | "adjustments" }>,
    editing: boolean,
    version: number,
  ): Promise<string | null> {
    const timeZone = this.env.TIMEZONE || CALENDAR_TIMEZONE_DEFAULT
    await step.do(`calendar-series-${editing ? "update" : "create"}-${version}`, async () => {
      const calendar = createGoogleCalendarClient(this.env)
      const identity = await managedEventIdentity(event.payload.chatId, event.payload.telegramMessageId)
      const parent = managedRecurringEvent(
        identity,
        proposal,
        availability.occurrences[0],
        availability.rrule,
        availability.reminderMinutes,
        timeZone,
      )
      const adjustments = availability.kind === "adjustments" ? availability.adjustments : []
      const exceptions: ManagedCalendarException[] = adjustments.map((adjustment) => {
        const original = availability.occurrences.find((occurrence) => occurrence.localDate === adjustment.localDate)
        if (!original) throw new Error("Recurring adjustment omitted its parent occurrence")
        return {
          originalStart: original.start,
          start: adjustment.scheduled.start,
          end: adjustment.scheduled.end,
        }
      })
      let parentCreated = false
      try {
        if (editing) await calendar.updateManagedEvent(parent)
        else {
          await calendar.createManagedEvent(parent)
          parentCreated = true
        }
        await calendar.reconcileManagedSeries(parent, exceptions)
      } catch (error) {
        if (parentCreated) {
          try {
            await calendar.deleteManagedEvent(parent.id)
          } catch {
            logRuntime(this.env, {
              workflow: event.instanceId,
              event: "calendar-series-compensation",
              outcome: "failed",
              failureCategory: "calendar-series-cleanup-failed",
            })
          }
        }
        throw error
      }
    })
    const adjustments = availability.kind === "adjustments" ? availability.adjustments.length : 0
    logRuntime(this.env, {
      workflow: event.instanceId,
      event: "calendar-write",
      outcome: "succeeded",
      details: {
        operation: editing ? "update-series" : "create-series",
        occurrences: String(availability.occurrences.length),
        adjustments: String(adjustments),
      },
    })
    const first = availability.occurrences[0]
    const edit = await this.promptForActions(
      step,
      event,
      version,
      `calendar-series-confirmation-${version}`,
      `Added: ${proposal.title.trim()} from ${proposal.firstDate} at ${first.localStartTime} for ${proposal.durationMinutes} min, ${availability.humanCadence}, ${availability.occurrences.length} occurrences. Reminder: ${availability.reminderMinutes} min.${adjustments ? ` Adjusted dates: ${adjustments}.` : ""}`,
      [["Edit entire series", INTERACTION_KIND.CALENDAR_EDIT]],
    )
    if (edit.type !== "action" || edit.kind !== INTERACTION_KIND.CALENDAR_EDIT) return null
    return this.promptForReply(
      step,
      event,
      version + 1,
      `calendar-series-edit-feedback-${version}`,
      "Reply with the correction for the entire recurring series.",
      INTERACTION_KIND.CALENDAR_EDIT_FEEDBACK,
    )
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
      this.conflictMessage(alternative),
      actions,
    )
  }

  private conflictMessage(alternative?: string): string {
    return alternative ? `That time is not free. ${alternative} is available instead.` : CALENDAR_CONFLICT
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
    let stage: "notify" | "register" | "wait" = "notify"
    const prepared = actions.map(([label, kind]) => ({
      label,
      kind,
      interactionId: crypto.randomUUID(),
      callbackToken: keyboard ? crypto.randomUUID() : undefined,
    }))
    try {
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
      stage = "register"
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
      stage = "wait"
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
    } catch {
      logRuntime(this.env, {
        workflow: event.instanceId,
        event: "calendar-interaction",
        outcome: "failed",
        failureCategory: "interaction-operation-failed",
        details: { stage, version },
      })
      throw new Error("Calendar interaction operation failed")
    }
  }
}
