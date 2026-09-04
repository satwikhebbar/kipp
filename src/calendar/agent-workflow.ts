import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers"
import { runCalendarAgentSession } from "../agent/calendar-session"
import { createInteractionRouter, type InteractionRegistration } from "../core/interaction-router-client"
import { type Env, INTERACTION_KIND, type WorkflowInteractionKind } from "../core/types"
import {
  type ConflictEventSnapshot,
  createGoogleCalendarClient,
  GoogleCalendarError,
  type ManagedCalendarException,
} from "../integrations/google-calendar"
import { createTelegramClient } from "../integrations/telegram"
import { createToolProvider, type ToolConversationMessage } from "../providers"
import { logRuntime } from "../runtime/logging"
import type { CalendarEvaluationContext } from "./evaluation"
import { evaluateCalendarCandidate } from "./evaluation"
import {
  type CalendarPlan,
  type CalendarPlanLedger,
  consumeCalendarOption,
  consumeCalendarPlan,
  createCalendarPlanLedger,
  inspectCalendarOption,
  inspectCalendarPlan,
} from "./plan"
import { managedRecurringEvent } from "./recurrence"
import {
  CALENDAR_TIMEZONE_DEFAULT,
  calendarDayBounds,
  localDateAt,
  localTimeAt,
  managedEvent,
  managedEventIdentity,
  type OneOffProposal,
  reminderMinutes,
  type ScheduledOneOff,
  suggestOneOffAlternative,
  zonedDateTimeToMillis,
} from "./scheduling"
import type { CalendarWorkflowParams } from "./workflow"

const CALENDAR_INTERACTION_TTL_MINUTES = 15
const MILLISECONDS_PER_MINUTE = 60_000
const CALENDAR_INTERACTION_TTL_MS = CALENDAR_INTERACTION_TTL_MINUTES * MILLISECONDS_PER_MINUTE
const MAX_CALENDAR_INTERACTION_TURNS = 8
const MAX_MULTI_ACTION_LABEL_CHARACTERS = 16
const CALENDAR_FAILURE = "I couldn't create that calendar block. Please try again shortly."
const CALENDAR_AGENT_UNAVAILABLE = "I couldn't reach the calendar agent. Please try again shortly."
const CALENDAR_AGENT_NO_DECISION = "The calendar agent didn't return a scheduling decision. Please retry your request."
const CALENDAR_CANCELLED = "Cancelled. No calendar event was created."
const CALENDAR_DISCLOSURE_LABEL = "Why this busy?"

type CalendarActionResponse =
  | { type: "timeout" }
  | { type: "action"; kind: WorkflowInteractionKind; actionIndex: number }
  | { type: "reply"; text: string }

type CalendarInteractionStage = "notify" | "register" | "wait"

class CalendarInteractionOperationError extends Error {
  constructor(readonly stage: CalendarInteractionStage) {
    super("Calendar interaction operation failed")
    this.name = "CalendarInteractionOperationError"
  }
}

interface PreparedCalendarOption {
  optionId: string
  label: string
  kind: WorkflowInteractionKind
  plan: CalendarPlan
}

type ConflictDisclosureResult =
  | { status: "ended"; version: number }
  | { status: "availability-changed"; version: number }
  | { status: "replacement"; version: number }
  | { status: "reply"; version: number; text: string }

type ConflictMoveOutcome =
  | { kind: "created"; createdEventId: string }
  | { kind: "undone"; message: string }
  | { kind: "availability-changed" }
  | { kind: "failed"; message: string }

/** Runs the production bounded Calendar agent and keeps all mutation authority in the workflow. */
export async function runAgentCenteredCalendarWorkflow(
  env: Env,
  event: WorkflowEvent<CalendarWorkflowParams>,
  step: WorkflowStep,
): Promise<void> {
  logRuntime(env, { workflow: event.instanceId, event: "calendar-workflow-run", outcome: "started" })
  const timeZone = env.TIMEZONE || CALENDAR_TIMEZONE_DEFAULT
  const expiresAt = (await step.do(
    "calendar-agent-expiry",
    async () => Date.now() + CALENDAR_INTERACTION_TTL_MS,
  )) as number
  let messages: ToolConversationMessage[] = [
    {
      role: "user",
      text: `Current instant: ${new Date().toISOString()}\nCalendar time zone: ${timeZone}\nUser request: ${event.payload.requestText}`,
    },
  ]
  let ledger = createCalendarPlanLedger()
  let agentVersion = 0
  let interactionVersion = 0
  let retryUsed = false
  let editing = false
  let baseline: CalendarPlan | null = null

  for (let turn = 0; turn < MAX_CALENDAR_INTERACTION_TURNS; turn++) {
    const currentAgentVersion = ++agentVersion
    const calendar = createGoogleCalendarClient(env)
    try {
      const sessionStep = (await step.do(`calendar-agent-session-${turn}`, (async () => {
        const sessionLedger = structuredClone(ledger)
        const provider = createToolProvider(
          env.LLM_API_KEY,
          env.LLM_PROVIDER,
          env.LLM_MODEL,
          Number(env.LLM_MAX_RETRIES || "3"),
        )
        const evaluation: CalendarEvaluationContext = {
          getBusyIntervals: async (timeMin, timeMax) =>
            withoutCreatedBaseline(await calendar.getBusyIntervals(timeMin, timeMax), baseline),
          ledger: sessionLedger,
          version: currentAgentVersion,
          expiresAt,
          timeZone,
        }
        const session = await runCalendarAgentSession(provider, messages, { calendar, evaluation })
        return { session, ledger: sessionLedger }
      }) as never)) as unknown as {
        session: Awaited<ReturnType<typeof runCalendarAgentSession>>
        ledger: CalendarPlanLedger
      }
      ledger = sessionStep.ledger
      messages = sessionStep.session.messages
      logAgentSession(env, event.instanceId, sessionStep.session)

      if (sessionStep.session.calendarFailureKind === "authorization" && !retryUsed) {
        const retry = await promptForAuthorizationRecovery(env, step, event, ++interactionVersion, turn)
        if (retry) {
          retryUsed = true
          messages.push({
            role: "system",
            text: "Calendar authorization was restored. Re-evaluate the request before requesting a write.",
          })
          continue
        }
        return
      }
      if (sessionStep.session.calendarFailureKind)
        throw new GoogleCalendarError(
          "Calendar agent read failed",
          sessionStep.session.calendarFailureKind,
          sessionStep.session.calendarFailureStatus,
          undefined,
          sessionStep.session.calendarFailureRetryCount,
        )
      if (!sessionStep.session.completed || !sessionStep.session.terminal) {
        await notify(
          env,
          step,
          event.payload.chatId,
          sessionStep.session.failureReason === "missing-required-handoff"
            ? CALENDAR_AGENT_NO_DECISION
            : CALENDAR_AGENT_UNAVAILABLE,
        )
        return
      }

      const terminal = sessionStep.session.terminal
      if (terminal.kind === "needs_user_input") {
        if (terminal.interaction.kind === "reply") {
          const reply = await promptForReply(
            env,
            step,
            event,
            ++interactionVersion,
            `calendar-agent-reply-${turn}`,
            terminal.message,
            INTERACTION_KIND.CALENDAR_CLARIFICATION,
          )
          if (!reply) return
          messages.push({ role: "user", text: reply })
          continue
        }

        const options = authorizedOptions(ledger, terminal.interaction.optionIds, currentAgentVersion)
        if (!options) {
          logRuntime(env, {
            workflow: event.instanceId,
            event: "calendar-plan-authorization",
            outcome: "failed",
            failureCategory: "invalid-calendar-options",
          })
          await notify(env, step, event.payload.chatId, CALENDAR_AGENT_NO_DECISION)
          return
        }
        const replacementKind = options.some((option) => option.plan.kind === "recurring")
          ? INTERACTION_KIND.CALENDAR_RECURRENCE_NEW_TIME
          : INTERACTION_KIND.CALENDAR_CONFLICT_REPLACE
        const requestedTimeConflict = terminal.reasonCodes.includes("requested_time_conflicts")
        const response = await promptForActions(
          env,
          step,
          event,
          ++interactionVersion,
          `calendar-agent-options-${turn}`,
          terminal.message,
          [
            ...options.map((option) => [option.label, option.kind] as [string, WorkflowInteractionKind]),
            ["Try another time", replacementKind],
            ...(requestedTimeConflict
              ? ([[CALENDAR_DISCLOSURE_LABEL, INTERACTION_KIND.CALENDAR_CONFLICT_DISCLOSE]] as Array<
                  [string, WorkflowInteractionKind]
                >)
              : []),
            ["Cancel", INTERACTION_KIND.CALENDAR_CONFLICT_CANCEL],
          ],
        )
        if (response.type === "timeout") return
        if (response.type === "reply") {
          messages.push({ role: "user", text: response.text })
          continue
        }
        if (response.kind === INTERACTION_KIND.CALENDAR_CONFLICT_CANCEL) {
          await notify(env, step, event.payload.chatId, CALENDAR_CANCELLED)
          return
        }
        if (response.kind === INTERACTION_KIND.CALENDAR_CONFLICT_DISCLOSE) {
          const disclosure = await handleConflictDisclosure(
            env,
            step,
            event,
            interactionVersion,
            turn,
            timeZone,
            options[0]?.plan as CalendarPlan,
            replacementKind,
            expiresAt,
          )
          interactionVersion = disclosure.version
          if (disclosure.status === "ended") return
          if (disclosure.status === "availability-changed") {
            messages.push(availabilityChangedMessage())
            continue
          }
          if (disclosure.status === "reply") {
            messages.push({ role: "user", text: disclosure.text })
            continue
          }
          const replacement = await promptForReply(
            env,
            step,
            event,
            ++interactionVersion,
            `calendar-agent-replacement-${turn}`,
            "Reply with another time for this calendar request.",
            replacementKind,
          )
          if (!replacement) return
          messages.push({ role: "user", text: replacement })
          continue
        }
        const selected = options[response.actionIndex]
        if (!selected) {
          const replacement = await promptForReply(
            env,
            step,
            event,
            ++interactionVersion,
            `calendar-agent-replacement-${turn}`,
            "Reply with another time for this calendar request.",
            replacementKind,
          )
          if (!replacement) return
          messages.push({ role: "user", text: replacement })
          continue
        }
        const consumed = consumeCalendarOption(ledger, selected.optionId, currentAgentVersion)
        if (!consumed.ok) {
          await notify(env, step, event.payload.chatId, CALENDAR_AGENT_NO_DECISION)
          return
        }
        if (
          !(await revalidateExactPlanInStep(
            env,
            step,
            `calendar-agent-revalidate-${turn}`,
            consumed.plan,
            baseline,
            timeZone,
            expiresAt,
          ))
        ) {
          messages.push(availabilityChangedMessage())
          continue
        }
        const correction = await writePlanAndConfirm(
          env,
          step,
          event,
          consumed.plan,
          editing,
          ++interactionVersion,
          turn,
        )
        if (!correction) return
        interactionVersion++
        baseline = consumed.plan
        editing = true
        messages.push(editBaselineMessage(consumed.plan), { role: "user", text: correction })
        continue
      }

      const authorized = inspectCalendarPlan(ledger, terminal.planId, currentAgentVersion)
      if (!authorized.ok) {
        await notify(env, step, event.payload.chatId, CALENDAR_AGENT_NO_DECISION)
        return
      }
      if (
        !(await revalidateExactPlanInStep(
          env,
          step,
          `calendar-agent-revalidate-${turn}`,
          authorized.plan,
          baseline,
          timeZone,
          expiresAt,
        ))
      ) {
        messages.push(availabilityChangedMessage())
        continue
      }
      const consumed = consumeCalendarPlan(ledger, terminal.planId, currentAgentVersion)
      if (!consumed.ok) {
        await notify(env, step, event.payload.chatId, CALENDAR_AGENT_NO_DECISION)
        return
      }
      const correction = await writePlanAndConfirm(env, step, event, consumed.plan, editing, ++interactionVersion, turn)
      if (!correction) return
      interactionVersion++
      baseline = consumed.plan
      editing = true
      messages.push(editBaselineMessage(consumed.plan), { role: "user", text: correction })
    } catch (error) {
      if (error instanceof GoogleCalendarError && error.kind === "authorization" && !retryUsed) {
        if (await promptForAuthorizationRecovery(env, step, event, ++interactionVersion, turn)) {
          retryUsed = true
          messages.push({
            role: "system",
            text: "Calendar authorization was restored. Re-evaluate the request before requesting a write.",
          })
          continue
        }
        return
      }
      logRuntime(env, {
        workflow: event.instanceId,
        event: "calendar-workflow-failure",
        outcome: "failed",
        failureCategory: error instanceof GoogleCalendarError ? `calendar-${error.kind}` : "calendar-agent-operation",
        ...(error instanceof GoogleCalendarError
          ? { details: { httpStatus: error.status ?? -1, retryCount: error.retryCount } }
          : {}),
      })
      await notify(env, step, event.payload.chatId, CALENDAR_FAILURE)
      return
    }
  }

  await notify(env, step, event.payload.chatId, "I still need clearer scheduling details. Please start a new request.")
}

/** Prompts once for Calendar reconnection without treating expected authorization state as a workflow exception. */
async function promptForAuthorizationRecovery(
  env: Env,
  step: WorkflowStep,
  event: WorkflowEvent<CalendarWorkflowParams>,
  version: number,
  turn: number,
): Promise<boolean> {
  const retry = await promptForActions(
    env,
    step,
    event,
    version,
    `calendar-agent-reconnect-${turn}`,
    `${calendarUnavailableMessage(env, event.payload.setupOrigin)}\n\nReconnect, then tap Retry within 15 minutes.`,
    [
      ["Retry", INTERACTION_KIND.CALENDAR_RETRY],
      ["Cancel", INTERACTION_KIND.CALENDAR_CANCEL],
    ],
  )
  const accepted = retry.type === "action" && retry.kind === INTERACTION_KIND.CALENDAR_RETRY
  const cancelled = retry.type === "action" && retry.kind === INTERACTION_KIND.CALENDAR_CANCEL
  if (cancelled) await notify(env, step, event.payload.chatId, CALENDAR_CANCELLED)
  logRuntime(env, {
    workflow: event.instanceId,
    event: "calendar-authorization-retry",
    outcome: accepted ? "succeeded" : "ignored",
    details: { version, turn, cancelled },
  })
  return accepted
}

/** Runs the post-decision Calendar read durably so a stalled provider call cannot hang the workflow runner. */
async function revalidateExactPlanInStep(
  env: Env,
  step: WorkflowStep,
  name: string,
  expected: CalendarPlan,
  baseline: CalendarPlan | null,
  timeZone: string,
  expiresAt: number,
): Promise<boolean> {
  return (await step.do(name, () =>
    revalidateExactPlan(createGoogleCalendarClient(env), expected, baseline, timeZone, expiresAt),
  )) as boolean
}

/** Re-runs deterministic evaluation and accepts only the exact previously authorized plan. */
async function revalidateExactPlan(
  calendar: ReturnType<typeof createGoogleCalendarClient>,
  expected: CalendarPlan,
  baseline: CalendarPlan | null,
  timeZone: string,
  expiresAt: number,
): Promise<boolean> {
  const ledger = createCalendarPlanLedger()
  const evaluation = await evaluateCalendarCandidate(
    expected.kind === "one_off"
      ? { kind: "one_off", proposal: expected.proposal }
      : { kind: "recurring", proposal: expected.proposal },
    {
      getBusyIntervals: async (timeMin, timeMax) =>
        withoutCreatedBaseline(await calendar.getBusyIntervals(timeMin, timeMax), baseline),
      ledger,
      version: 1,
      expiresAt,
      timeZone,
    },
  )
  const candidates: CalendarPlan[] = []
  if (evaluation.kind === "ready") {
    const authorized = inspectCalendarPlan(ledger, evaluation.planId, 1)
    if (authorized.ok) candidates.push(authorized.plan)
  } else if (evaluation.kind === "choice_required") {
    for (const option of evaluation.options) {
      const authorized = inspectCalendarOption(ledger, option.optionId, 1)
      if (authorized.ok) candidates.push(authorized.plan)
    }
  }
  return candidates.some((candidate) => sameCalendarPlan(candidate, expected))
}

/** Removes only the exact event or series intervals created by this workflow during immediate Edit. */
function withoutCreatedBaseline(
  busy: Array<{ start: string; end: string }>,
  baseline: CalendarPlan | null,
): Array<{ start: string; end: string }> {
  if (!baseline) return busy
  const owned = new Set<string>()
  if (baseline.kind === "one_off")
    owned.add(`${Date.parse(baseline.scheduled.start)}:${Date.parse(baseline.scheduled.end)}`)
  else {
    for (const occurrence of baseline.occurrences) {
      const adjustment = baseline.adjustments.find((item) => item.localDate === occurrence.localDate)
      const scheduled = adjustment?.scheduled ?? occurrence
      owned.add(`${Date.parse(scheduled.start)}:${Date.parse(scheduled.end)}`)
    }
  }
  return busy.filter((interval) => !owned.has(`${Date.parse(interval.start)}:${Date.parse(interval.end)}`))
}

/** Writes one exact authorized plan, then performs confirmation-only recovery without repeating the mutation. */
async function writePlanAndConfirm(
  env: Env,
  step: WorkflowStep,
  event: WorkflowEvent<CalendarWorkflowParams>,
  plan: CalendarPlan,
  editing: boolean,
  version: number,
  turn: number,
): Promise<string | null> {
  const timeZone = env.TIMEZONE || CALENDAR_TIMEZONE_DEFAULT
  await step.do(`calendar-agent-${editing ? "update" : "create"}-${turn}`, async () => {
    const calendar = createGoogleCalendarClient(env)
    const identity = await managedEventIdentity(event.payload.chatId, event.payload.telegramMessageId)
    if (plan.kind === "one_off") {
      const eventBody = managedEvent(identity, plan.proposal, plan.scheduled, timeZone)
      if (editing) await calendar.updateManagedEvent(eventBody)
      else await calendar.createManagedEvent(eventBody)
      return
    }
    const parent = managedRecurringEvent(
      identity,
      plan.proposal,
      plan.occurrences[0] as (typeof plan.occurrences)[number],
      plan.rrule,
      plan.reminderMinutes,
      timeZone,
    )
    const exceptions: ManagedCalendarException[] = plan.adjustments.map((adjustment) => {
      const original = plan.occurrences.find((occurrence) => occurrence.localDate === adjustment.localDate)
      if (!original) throw new Error("Recurring adjustment omitted its parent occurrence")
      return { originalStart: original.start, start: adjustment.scheduled.start, end: adjustment.scheduled.end }
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
          logRuntime(env, {
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
  logRuntime(env, {
    workflow: event.instanceId,
    event: "calendar-write",
    outcome: "succeeded",
    details: { operation: editing ? "update" : "create", kind: plan.kind },
  })

  const message = confirmationMessage(plan, editing)
  const label = plan.kind === "recurring" ? "Edit entire series" : "Edit"
  let edit: CalendarActionResponse
  try {
    edit = await promptForActions(env, step, event, version, `calendar-agent-confirmation-${turn}`, message, [
      [label, INTERACTION_KIND.CALENDAR_EDIT],
    ])
  } catch (error) {
    if (!(error instanceof CalendarInteractionOperationError) || error.stage !== "notify") return null
    logRuntime(env, {
      workflow: event.instanceId,
      event: "calendar-confirmation",
      outcome: "failed",
      failureCategory: "confirmation-recovery-started",
    })
    try {
      edit = await promptForActions(
        env,
        step,
        event,
        version,
        `calendar-agent-confirmation-recovery-${turn}`,
        message,
        [[label, INTERACTION_KIND.CALENDAR_EDIT]],
      )
    } catch {
      logRuntime(env, {
        workflow: event.instanceId,
        event: "calendar-confirmation",
        outcome: "failed",
        failureCategory: "confirmation-delivery-failed",
      })
      return null
    }
  }
  if (edit.type !== "action" || edit.kind !== INTERACTION_KIND.CALENDAR_EDIT) return null
  try {
    return await promptForReply(
      env,
      step,
      event,
      version + 1,
      `calendar-agent-edit-${turn}`,
      plan.kind === "recurring"
        ? "Reply with the correction for the entire recurring series."
        : "Reply with the correction for this calendar block.",
      INTERACTION_KIND.CALENDAR_EDIT_FEEDBACK,
    )
  } catch {
    return null
  }
}

/** Resolves the exact workflow-owned plans behind an agent-returned option set. */
function authorizedOptions(
  ledger: CalendarPlanLedger,
  ids: string[],
  version: number,
): PreparedCalendarOption[] | null {
  const options: PreparedCalendarOption[] = []
  for (const optionId of ids) {
    const authorization = inspectCalendarOption(ledger, optionId, version)
    if (!authorization.ok) return null
    const plan = authorization.plan
    const localStartTime = plan.kind === "one_off" ? plan.scheduled.localStartTime : plan.occurrences[0]?.localStartTime
    options.push({
      optionId,
      plan,
      label: plan.kind === "recurring" && plan.adjustments.length ? "Use adjustments" : `Use ${localStartTime}`,
      kind:
        plan.kind === "recurring" && plan.adjustments.length
          ? INTERACTION_KIND.CALENDAR_RECURRENCE_ADJUSTMENTS
          : INTERACTION_KIND.CALENDAR_CONFLICT_ALTERNATIVE,
    })
  }
  return options
}

/** Returns the owner-requested disclosure interval(s), or empty when they cannot be derived. */
function requestedDisclosureIntervals(
  plan: CalendarPlan,
  timeZone: string,
): Array<{ start: number; end: number; timeMin: string; timeMax: string }> {
  if (plan.kind === "one_off") {
    if (!plan.proposal.startTime || !plan.proposal.localDate) return []
    const start = zonedDateTimeToMillis(plan.proposal.localDate, plan.proposal.startTime, timeZone)
    if (start === null) return []
    const bounds = calendarDayBounds(plan.proposal.localDate, timeZone)
    if (!bounds) return []
    return [
      {
        start,
        end: start + plan.proposal.durationMinutes * MILLISECONDS_PER_MINUTE,
        timeMin: bounds.timeMin,
        timeMax: bounds.timeMax,
      },
    ]
  }
  const conflicts = plan.requestedConflicts.length ? plan.requestedConflicts : plan.occurrences
  const intervals: Array<{ start: number; end: number; timeMin: string; timeMax: string }> = []
  for (const occurrence of conflicts) {
    const start = Date.parse(occurrence.start)
    const end = Date.parse(occurrence.end)
    const bounds = calendarDayBounds(occurrence.localDate, timeZone)
    if (!Number.isFinite(start) || !Number.isFinite(end) || !bounds) continue
    intervals.push({ start, end, timeMin: bounds.timeMin, timeMax: bounds.timeMax })
  }
  return intervals
}

/** Renders the owner-visible disclosure body listing every overlapping event as plain text. */
function disclosureMessage(snapshots: ConflictEventSnapshot[], timeZone: string, showDates: boolean): string {
  const lines = snapshots.map((snapshot) => {
    const range = snapshot.allDay
      ? "all day"
      : `${localTimeAt(Date.parse(snapshot.start), timeZone)}–${localTimeAt(Date.parse(snapshot.end), timeZone)}`
    const when = showDates ? `${localDateAt(Date.parse(snapshot.start), timeZone)} ${range}` : range
    return `• ${snapshot.title} (${when})`
  })
  return `Your requested time is occupied by:\n${lines.join("\n")}\n\nChoose an event to reschedule, try another time, or cancel.`
}

/** Returns a time-derived reschedule label, disambiguated only when movable events share a start time. */
function rescheduleLabel(startTime: string, duplicateIndex: number): string {
  if (duplicateIndex === 0) return `Reschedule ${startTime}`.slice(0, MAX_MULTI_ACTION_LABEL_CHARACTERS)
  return `Resch. ${startTime} (${duplicateIndex + 1})`.slice(0, MAX_MULTI_ACTION_LABEL_CHARACTERS)
}

/** Runs the deterministic owner-visible disclosure, reschedule, move, and undo sub-flow. */
async function handleConflictDisclosure(
  env: Env,
  step: WorkflowStep,
  event: WorkflowEvent<CalendarWorkflowParams>,
  version: number,
  turn: number,
  timeZone: string,
  plan: CalendarPlan,
  replacementKind: WorkflowInteractionKind,
  expiresAt: number,
): Promise<ConflictDisclosureResult> {
  const intervals = requestedDisclosureIntervals(plan, timeZone)
  if (!intervals.length) return { status: "ended", version }
  let v = version
  const calendar = createGoogleCalendarClient(env)
  const snapshots = (await step.do(`calendar-conflict-disclose-${turn}`, async () => {
    const seen = new Map<string, ConflictEventSnapshot>()
    for (const interval of intervals) {
      const found = (await calendar.findConflictingEvents(
        interval.timeMin,
        interval.timeMax,
        new Date(interval.start).toISOString(),
        new Date(interval.end).toISOString(),
        timeZone,
      )) as ConflictEventSnapshot[]
      for (const snapshot of found) if (!seen.has(snapshot.id)) seen.set(snapshot.id, snapshot)
    }
    return [...seen.values()]
  })) as ConflictEventSnapshot[]
  if (!snapshots.length) return { status: "availability-changed", version: v }
  const requested = intervals[0] as { start: number; end: number; timeMin: string; timeMax: string }
  const bounds = { timeMin: requested.timeMin, timeMax: requested.timeMax }

  // Recurring requests are disclosed but never rescheduled: moving a single event
  // cannot free the whole series, so the disclosure is informational only.
  const movable = plan.kind === "one_off" ? snapshots.filter((snapshot) => snapshot.movable) : []
  const seenStarts = new Map<string, number>()
  const actions: Array<[string, WorkflowInteractionKind]> = movable.map((snapshot) => {
    const startTime = localTimeAt(Date.parse(snapshot.start), timeZone)
    const duplicateIndex = seenStarts.get(snapshot.start) ?? 0
    seenStarts.set(snapshot.start, duplicateIndex + 1)
    return [rescheduleLabel(startTime, duplicateIndex), INTERACTION_KIND.CALENDAR_CONFLICT_RESCHEDULE]
  })
  actions.push(["Try another time", replacementKind], ["Cancel", INTERACTION_KIND.CALENDAR_CONFLICT_CANCEL])

  const disclosure = await promptForActions(
    env,
    step,
    event,
    ++v,
    `calendar-conflict-disclosure-${turn}`,
    disclosureMessage(snapshots, timeZone, intervals.length > 1),
    actions,
  )
  if (disclosure.type === "timeout") return { status: "ended", version: v }
  if (disclosure.type === "reply") return { status: "reply", version: v, text: disclosure.text }
  if (disclosure.kind === INTERACTION_KIND.CALENDAR_CONFLICT_CANCEL) {
    await notify(env, step, event.payload.chatId, CALENDAR_CANCELLED)
    return { status: "ended", version: v }
  }
  if (disclosure.kind === replacementKind) return { status: "replacement", version: v }
  if (disclosure.kind !== INTERACTION_KIND.CALENDAR_CONFLICT_RESCHEDULE) return { status: "ended", version: v }
  if (plan.kind !== "one_off") return { status: "ended", version: v }
  const snapshot = movable[disclosure.actionIndex]
  if (!snapshot) return { status: "availability-changed", version: v }

  const movedProposal: OneOffProposal = {
    title: snapshot.title,
    localDate: localDateAt(Date.parse(snapshot.start), timeZone),
    startTime: localTimeAt(Date.parse(snapshot.start), timeZone),
    durationMinutes: Math.round((Date.parse(snapshot.end) - Date.parse(snapshot.start)) / MILLISECONDS_PER_MINUTE),
    dateIsExplicit: true,
    timeIsExplicit: true,
    classification: "ordinary",
    needsClarification: false,
  }
  const target = (await step.do(`calendar-conflict-propose-${turn}`, async () => {
    const client = createGoogleCalendarClient(env)
    const busy = await client.getBusyIntervals(bounds.timeMin, bounds.timeMax)
    return suggestOneOffAlternative(movedProposal, busy, timeZone)
  })) as ScheduledOneOff | null
  if (!target) {
    await notify(
      env,
      step,
      event.payload.chatId,
      `I couldn't find a free slot to move ${snapshot.title} to. Please try another time or check your Calendar.`,
    )
    return { status: "ended", version: v }
  }

  const proposeMessage = `Move ${snapshot.title} from ${localTimeAt(Date.parse(snapshot.start), timeZone)}–${localTimeAt(Date.parse(snapshot.end), timeZone)} to ${localTimeAt(Date.parse(target.start), timeZone)}–${localTimeAt(Date.parse(target.end), timeZone)}?`
  const confirmation = await promptForActions(
    env,
    step,
    event,
    ++v,
    `calendar-conflict-propose-${turn}`,
    proposeMessage,
    [
      ["Move it", INTERACTION_KIND.CALENDAR_CONFLICT_MOVE],
      ["Cancel", INTERACTION_KIND.CALENDAR_CONFLICT_CANCEL],
    ],
  )
  if (confirmation.type === "timeout") return { status: "ended", version: v }
  if (confirmation.type === "reply") return { status: "reply", version: v, text: confirmation.text }
  if (confirmation.kind === INTERACTION_KIND.CALENDAR_CONFLICT_CANCEL) {
    await notify(env, step, event.payload.chatId, CALENDAR_CANCELLED)
    return { status: "ended", version: v }
  }
  if (confirmation.kind !== INTERACTION_KIND.CALENDAR_CONFLICT_MOVE) return { status: "ended", version: v }

  const requestedScheduled: ScheduledOneOff = {
    start: new Date(requested.start).toISOString(),
    end: new Date(requested.end).toISOString(),
    reminderMinutes: reminderMinutes(plan.proposal),
    localStartTime: localTimeAt(requested.start, timeZone),
  }
  const requestedPlan: CalendarPlan = { kind: "one_off", proposal: plan.proposal, scheduled: requestedScheduled }
  const identity = await managedEventIdentity(event.payload.chatId, event.payload.telegramMessageId)
  const outcome = (await step.do(`calendar-conflict-move-${turn}`, async () => {
    const client = createGoogleCalendarClient(env)
    const move = await client.moveExistingEvent(snapshot.id, target.start, target.end)
    if (!move.ok) {
      if (move.reason === "authorization")
        throw new GoogleCalendarError("Calendar event could not be moved", "authorization")
      if (move.reason === "precondition-failed" || move.reason === "not-found")
        return { kind: "availability-changed" } as ConflictMoveOutcome
      return {
        kind: "failed",
        message: `I couldn't move ${snapshot.title}. Please try again shortly.`,
      } as ConflictMoveOutcome
    }
    const restore = async (): Promise<boolean> =>
      (await client.moveExistingEvent(snapshot.id, snapshot.start, snapshot.end)).ok
    if (!(await revalidateExactPlan(client, requestedPlan, null, timeZone, expiresAt))) {
      if (await restore())
        return {
          kind: "undone",
          message: `I couldn't create your block at the freed time, so I restored ${snapshot.title} to its original time.`,
        } as ConflictMoveOutcome
      return {
        kind: "failed",
        message: `I moved ${snapshot.title} to ${localTimeAt(Date.parse(target.start), timeZone)} but couldn't create your block or restore it. Please check your Calendar.`,
      } as ConflictMoveOutcome
    }
    try {
      await client.createManagedEvent(managedEvent(identity, plan.proposal, requestedScheduled, timeZone))
    } catch (error) {
      if (error instanceof GoogleCalendarError && error.kind === "authorization") throw error
      if (await restore())
        return {
          kind: "undone",
          message: `I couldn't create your block, so I restored ${snapshot.title} to its original time.`,
        } as ConflictMoveOutcome
      return {
        kind: "failed",
        message: `I moved ${snapshot.title} to ${localTimeAt(Date.parse(target.start), timeZone)} but couldn't create your block or restore it. Please check your Calendar.`,
      } as ConflictMoveOutcome
    }
    return { kind: "created", createdEventId: identity.id } as ConflictMoveOutcome
  })) as ConflictMoveOutcome

  if (outcome.kind === "availability-changed") return { status: "availability-changed", version: v }
  if (outcome.kind === "undone" || outcome.kind === "failed") {
    if (outcome.kind === "failed")
      logRuntime(env, {
        workflow: event.instanceId,
        event: "calendar-conflict-operation",
        outcome: "failed",
        failureCategory: "calendar-conflict-phase-failed",
      })
    await notify(env, step, event.payload.chatId, outcome.message)
    return { status: "ended", version: v }
  }

  const createdMessage = `${confirmationMessage(requestedPlan, false)}\nMoved ${snapshot.title} from ${localTimeAt(Date.parse(snapshot.start), timeZone)}–${localTimeAt(Date.parse(snapshot.end), timeZone)} to ${localTimeAt(Date.parse(target.start), timeZone)}–${localTimeAt(Date.parse(target.end), timeZone)} to make room.`
  const after = await promptForActions(
    env,
    step,
    event,
    ++v,
    `calendar-conflict-confirmation-${turn}`,
    createdMessage,
    [
      ["Undo", INTERACTION_KIND.CALENDAR_CONFLICT_UNDO],
      ["Continue", INTERACTION_KIND.CALENDAR_CONFLICT_CONTINUE],
    ],
  )
  if (after.type === "timeout") return { status: "ended", version: v }
  if (after.type === "reply") return { status: "reply", version: v, text: after.text }
  if (after.kind !== INTERACTION_KIND.CALENDAR_CONFLICT_UNDO) return { status: "ended", version: v }

  const undo = (await step.do(`calendar-conflict-undo-${turn}`, async () => {
    const client = createGoogleCalendarClient(env)
    const restore = await client.moveExistingEvent(snapshot.id, snapshot.start, snapshot.end)
    if (!restore.ok) {
      if (restore.reason === "authorization")
        throw new GoogleCalendarError("Calendar event could not be restored", "authorization")
      return {
        message: `I couldn't restore ${snapshot.title} because it changed externally. The new block stays. Please check your Calendar.`,
      }
    }
    try {
      await client.deleteManagedEvent(outcome.createdEventId)
    } catch (error) {
      if (error instanceof GoogleCalendarError && error.kind === "authorization") throw error
      return { message: `${snapshot.title} was restored, but your new block may remain. Please check your Calendar.` }
    }
    return { message: `Restored ${snapshot.title} to its original time and removed the created block.` }
  })) as { message: string }
  await notify(env, step, event.payload.chatId, undo.message)
  return { status: "ended", version: v }
}

/** Compares complete serializable plans so revalidation cannot substitute any field. */
function sameCalendarPlan(left: CalendarPlan, right: CalendarPlan): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Returns trusted context that forces a new evaluation after a TOCTOU mismatch. */
function availabilityChangedMessage(): ToolConversationMessage {
  return {
    role: "system",
    text: "Calendar availability changed after the prior handoff. Do not reuse its plan or option. Re-evaluate the request and explain the new typed outcome.",
  }
}

/** Projects the complete trusted created-event baseline into the immediate Edit session. */
function editBaselineMessage(plan: CalendarPlan): ToolConversationMessage {
  return {
    role: "system",
    text: `Trusted created-event baseline for immediate Edit. Preserve every field not changed by the user's correction: ${JSON.stringify(plan)}`,
  }
}

/** Renders the deterministic post-write confirmation template for an exact plan. */
function confirmationMessage(plan: CalendarPlan, editing: boolean): string {
  const verb = editing ? "Updated" : "Added"
  if (plan.kind === "one_off")
    return `${verb}: ${plan.proposal.title.trim()} on ${plan.proposal.localDate} at ${plan.scheduled.localStartTime} for ${plan.proposal.durationMinutes} min. Reminder: ${plan.scheduled.reminderMinutes} min.`
  const first = plan.occurrences[0]
  return `${verb}: ${plan.proposal.title.trim()} from ${plan.proposal.firstDate} at ${first?.localStartTime} for ${plan.proposal.durationMinutes} min, ${plan.humanCadence}, ${plan.occurrences.length} occurrences. Reminder: ${plan.reminderMinutes} min.${plan.adjustments.length ? ` Adjusted dates: ${plan.adjustments.length}.` : ""}`
}

/** Returns the configured browser URL for Google Calendar OAuth recovery. */
function calendarSetupUrl(env: Env, setupOrigin?: string): string {
  const origin = env.GOOGLE_CALENDAR_REDIRECT_ORIGIN?.trim() || setupOrigin?.trim()
  return origin ? `${origin.replace(/\/+$/, "")}/setup/google-calendar` : "/setup/google-calendar"
}

/** Renders the fixed operational message used when Calendar authorization is missing. */
function calendarUnavailableMessage(env: Env, setupOrigin?: string): string {
  return `Google Calendar is not connected. Open ${calendarSetupUrl(env, setupOrigin)} to connect it, then try again.`
}

/** Emits metadata-only session and tool lifecycle records without transcript contents. */
function logAgentSession(
  env: Env,
  workflow: string,
  session: Awaited<ReturnType<typeof runCalendarAgentSession>>,
): void {
  for (const execution of session.toolExecutions)
    logRuntime(env, {
      workflow,
      event: "calendar-agent-tool",
      tool: execution.tool,
      outcome: execution.outcome,
      failureCategory: execution.failureCategory,
      ...(execution.validationPaths?.length
        ? { details: { validationPaths: execution.validationPaths.join(",") } }
        : {}),
    })
  logRuntime(env, {
    workflow,
    event: "calendar-agent-session",
    outcome: session.completed ? "succeeded" : "failed",
    failureCategory: session.failureReason,
    metrics: {
      providerTurns: session.providerTurns,
      toolCallCount: session.toolCallCount,
      toolRunCompleted: session.completed,
    },
    ...(session.calendarFailureKind
      ? {
          details: {
            calendarReadFailureKind: session.calendarFailureKind,
            calendarReadFailureStage: session.calendarFailureStage ?? "calendar-read",
            calendarReadHttpStatus: session.calendarFailureStatus ?? -1,
            calendarReadRetryCount: session.calendarFailureRetryCount ?? 0,
            calendarReadProviderReason: session.calendarFailureProviderReason ?? "unavailable",
          },
        }
      : {}),
  })
}

/** Sends one deterministic workflow notification through a durable step. */
async function notify(env: Env, step: WorkflowStep, chatId: string, message: string): Promise<void> {
  await step.do(`calendar-agent-notify-${crypto.randomUUID()}`, () =>
    createTelegramClient(env.TELEGRAM_BOT_TOKEN).sendMessage(chatId, message),
  )
}

/** Sends a force-reply prompt and returns only a routed free-text response. */
async function promptForReply(
  env: Env,
  step: WorkflowStep,
  event: WorkflowEvent<CalendarWorkflowParams>,
  version: number,
  name: string,
  message: string,
  kind: WorkflowInteractionKind,
): Promise<string | null> {
  const response = await promptForActions(env, step, event, version, name, message, [["Reply", kind]], false)
  return response.type === "reply" ? response.text : null
}

/** Registers fixed actions, waits once, and distinguishes callbacks from free text. */
async function promptForActions(
  env: Env,
  step: WorkflowStep,
  event: WorkflowEvent<CalendarWorkflowParams>,
  version: number,
  name: string,
  message: string,
  actions: Array<[string, WorkflowInteractionKind]>,
  keyboard = true,
): Promise<CalendarActionResponse> {
  if (keyboard && actions.length > 1 && actions.some(([label]) => label.length > MAX_MULTI_ACTION_LABEL_CHARACTERS))
    throw new Error(`Calendar action labels must be at most ${MAX_MULTI_ACTION_LABEL_CHARACTERS} characters`)
  let stage: CalendarInteractionStage = "notify"
  const prepared = actions.map(([label, kind]) => ({
    label,
    kind,
    interactionId: crypto.randomUUID(),
    callbackToken: keyboard ? crypto.randomUUID() : undefined,
  }))
  try {
    const sent = await step.do(`${name}-notify`, () =>
      createTelegramClient(env.TELEGRAM_BOT_TOKEN).sendMessage(
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
      const router = createInteractionRouter(env.INTERACTION_ROUTER, event.payload.chatId)
      await Promise.all(
        prepared.map((action) =>
          router.register({
            interactionId: action.interactionId,
            version,
            workflowId: event.instanceId,
            kind: action.kind,
            callbackToken: action.callbackToken,
            botMessageId: sent.messageId,
            expiresAt: Date.now() + CALENDAR_INTERACTION_TTL_MS,
            interactionGroup: "calendar",
          } satisfies InteractionRegistration),
        ),
      )
    })
    stage = "wait"
    const reply = await step.waitForEvent<{ text?: string; interactionId?: string }>(`${name}-wait`, {
      type: "telegram-reply",
      timeout: "15 minutes" as never,
    })
    if (reply.type === "timeout") return { type: "timeout" }
    const text = reply.payload?.text
    if (!text) return { type: "timeout" }
    const matchedIndex = prepared.findIndex(
      (action) =>
        action.callbackToken &&
        (action.interactionId === reply.payload?.interactionId ||
          (text === `__${action.kind}__` &&
            prepared.filter((candidate) => candidate.kind === action.kind).length === 1)),
    )
    return matchedIndex >= 0
      ? { type: "action", kind: prepared[matchedIndex]?.kind as WorkflowInteractionKind, actionIndex: matchedIndex }
      : { type: "reply", text }
  } catch {
    logRuntime(env, {
      workflow: event.instanceId,
      event: "calendar-interaction",
      outcome: "failed",
      failureCategory: "interaction-operation-failed",
      details: { stage, version },
    })
    throw new CalendarInteractionOperationError(stage)
  }
}
