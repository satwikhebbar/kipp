import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers"
import { runCalendarAgentSession } from "./agent/calendar-session"
import type { CalendarEvaluationContext } from "./calendar-evaluation"
import { evaluateCalendarCandidate } from "./calendar-evaluation"
import {
  type CalendarPlan,
  type CalendarPlanLedger,
  consumeCalendarOption,
  consumeCalendarPlan,
  createCalendarPlanLedger,
  inspectCalendarOption,
  inspectCalendarPlan,
} from "./calendar-plan"
import { managedRecurringEvent } from "./calendar-recurrence"
import { CALENDAR_TIMEZONE_DEFAULT, managedEvent, managedEventIdentity } from "./calendar-scheduling"
import type { CalendarWorkflowParams } from "./calendar-workflow"
import {
  createGoogleCalendarClient,
  GoogleCalendarError,
  type ManagedCalendarException,
} from "./integrations/google-calendar"
import { createTelegramClient } from "./integrations/telegram"
import { createInteractionRouter, type InteractionRegistration } from "./interaction-router-client"
import { createToolProvider, type ToolConversationMessage } from "./providers"
import { logRuntime } from "./runtime/logging"
import { type Env, INTERACTION_KIND, type WorkflowInteractionKind } from "./types"

const CALENDAR_INTERACTION_TTL_MINUTES = 15
const MILLISECONDS_PER_MINUTE = 60_000
const CALENDAR_INTERACTION_TTL_MS = CALENDAR_INTERACTION_TTL_MINUTES * MILLISECONDS_PER_MINUTE
const MAX_CALENDAR_INTERACTION_TURNS = 8
const CALENDAR_FAILURE = "I couldn't create that calendar block. Please try again shortly."
const CALENDAR_AGENT_UNAVAILABLE = "I couldn't reach the calendar agent. Please try again shortly."
const CALENDAR_AGENT_NO_DECISION = "The calendar agent didn't return a scheduling decision. Please retry your request."

type CalendarActionResponse =
  | { type: "timeout" }
  | { type: "action"; kind: WorkflowInteractionKind; actionIndex: number }
  | { type: "reply"; text: string }

interface PreparedCalendarOption {
  optionId: string
  label: string
  kind: WorkflowInteractionKind
  plan: CalendarPlan
}

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

      if (sessionStep.session.calendarFailureKind)
        throw new GoogleCalendarError("Calendar agent read failed", sessionStep.session.calendarFailureKind)
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
            ["Cancel", INTERACTION_KIND.CALENDAR_CONFLICT_CANCEL],
          ],
        )
        if (response.type === "timeout") return
        if (response.type === "reply") {
          messages.push({ role: "user", text: response.text })
          continue
        }
        if (response.kind === INTERACTION_KIND.CALENDAR_CONFLICT_CANCEL) return
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
        if (!(await revalidateExactPlan(calendar, consumed.plan, baseline, timeZone, expiresAt))) {
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
      if (!(await revalidateExactPlan(calendar, authorized.plan, baseline, timeZone, expiresAt))) {
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
        const retry = await promptForActions(
          env,
          step,
          event,
          ++interactionVersion,
          `calendar-agent-reconnect-${turn}`,
          `${calendarUnavailableMessage(env)}\n\nReconnect, then tap Retry within 15 minutes.`,
          [
            ["Retry", INTERACTION_KIND.CALENDAR_RETRY],
            ["Cancel", INTERACTION_KIND.CALENDAR_CANCEL],
          ],
        )
        if (retry.type === "action" && retry.kind === INTERACTION_KIND.CALENDAR_RETRY) {
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
      })
      await notify(env, step, event.payload.chatId, CALENDAR_FAILURE)
      return
    }
  }

  await notify(env, step, event.payload.chatId, "I still need clearer scheduling details. Please start a new request.")
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
  } catch {
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
      label: plan.kind === "recurring" && plan.adjustments.length ? "Create with adjustments" : `Use ${localStartTime}`,
      kind:
        plan.kind === "recurring" && plan.adjustments.length
          ? INTERACTION_KIND.CALENDAR_RECURRENCE_ADJUSTMENTS
          : INTERACTION_KIND.CALENDAR_CONFLICT_ALTERNATIVE,
    })
  }
  return options
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
function calendarSetupUrl(env: Env): string {
  const origin = env.GOOGLE_CALENDAR_REDIRECT_ORIGIN?.replace(/\/+$/, "")
  return origin ? `${origin}/setup/google-calendar` : "/setup/google-calendar"
}

/** Renders the fixed operational message used when Calendar authorization is missing. */
function calendarUnavailableMessage(env: Env): string {
  return `Google Calendar is not connected. Open ${calendarSetupUrl(env)} to connect it, then try again.`
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
  let stage: "notify" | "register" | "wait" = "notify"
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
    throw new Error("Calendar interaction operation failed")
  }
}
