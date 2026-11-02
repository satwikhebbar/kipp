import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers"
import { runCalendarAgentSession } from "../agent/calendar-session"
import { type ActionPromptOutcome, promptForActions } from "../core/action-prompt"
import { createInteractionRouter } from "../core/interaction-router-client"
import { type Env, INTERACTION_KIND, type WorkflowInteractionKind } from "../core/types"
import { isWorkflowInterruption } from "../core/workflow-events"
import {
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
  type CalendarPlanAuthorization,
  type CalendarPlanLedger,
  consumeCalendarOption,
  consumeCalendarPlan,
  createCalendarPlanLedger,
  inspectCalendarOption,
  inspectCalendarPlan,
} from "./plan"
import { managedRecurringEvent } from "./recurrence"
import { CALENDAR_TIMEZONE_DEFAULT, managedEvent, managedEventIdentity } from "./scheduling"
import type { CalendarWorkflowParams } from "./workflow"

const CALENDAR_INTERACTION_TTL_MINUTES = 15
const MILLISECONDS_PER_MINUTE = 60_000
const CALENDAR_INTERACTION_TTL_MS = CALENDAR_INTERACTION_TTL_MINUTES * MILLISECONDS_PER_MINUTE
const MAX_CALENDAR_INTERACTION_TURNS = 8
const CALENDAR_FAILURE = "I couldn't create that calendar block. Please try again shortly."
const CALENDAR_UPDATE_FAILURE = "I couldn't complete that calendar update. Please check the event before trying again."
const CALENDAR_AGENT_UNAVAILABLE = "I couldn't reach the calendar agent. Please try again shortly."
const CALENDAR_AGENT_NO_DECISION = "The calendar agent didn't return a scheduling decision. Please retry your request."
const CALENDAR_CANCELLED = "Cancelled. No calendar event was created."

type CalendarActionResponse = ActionPromptOutcome

/** Calendar-scoped adapter over the shared action prompt that keeps caller ergonomics stable. */
function calendarPromptForActions(
  env: Env,
  step: WorkflowStep,
  event: WorkflowEvent<CalendarWorkflowParams>,
  version: number,
  name: string,
  message: string,
  actions: Array<[string, WorkflowInteractionKind]>,
  keyboard = true,
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
    ttlMs: CALENDAR_INTERACTION_TTL_MS,
    interactionGroup: "calendar",
    logEventName: "calendar-interaction",
  })
}

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
  editContext?: CalendarEditContext,
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
      text: `Current instant: ${new Date(expiresAt - CALENDAR_INTERACTION_TTL_MS).toISOString()}\nCalendar time zone: ${timeZone}\nUser request: ${event.payload.requestText}`,
    },
  ]
  if (editContext)
    messages = [
      ...editContext.messages,
      editBaselineMessage(editContext.baseline),
      { role: "user", text: event.payload.requestText },
    ]
  let ledger = createCalendarPlanLedger()
  let agentVersion = 0
  let interactionVersion = 0
  let retryUsed = false
  const editing = Boolean(editContext)
  const baseline: CalendarPlan | null = editContext?.baseline ?? null
  // A successful write is terminal for scheduling. If a workflow replay or a
  // later Edit turn reaches the agent again and it fails, do not emit a
  // contradictory pre-write "no decision" message.
  let calendarWriteOccurred = Boolean(editContext)

  for (let turn = 0; turn < MAX_CALENDAR_INTERACTION_TURNS; turn++) {
    const currentAgentVersion = ++agentVersion
    const calendar = createGoogleCalendarClient(env)
    try {
      const turnExpiresAt = editing
        ? await step.do(`calendar-agent-edit-expiry-${turn}`, async () => Date.now() + CALENDAR_INTERACTION_TTL_MS)
        : expiresAt
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
          expiresAt: turnExpiresAt,
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
        if (calendarWriteOccurred) {
          await notify(env, step, event.payload.chatId, CALENDAR_UPDATE_FAILURE, `edit-session-${turn}`)
          return
        }
        await notify(
          env,
          step,
          event.payload.chatId,
          sessionStep.session.failureReason === "missing-required-handoff"
            ? CALENDAR_AGENT_NO_DECISION
            : CALENDAR_AGENT_UNAVAILABLE,
          `session-${turn}`,
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

        const optionIds = terminal.interaction.optionIds
        const options = await calendarDecision(step, `calendar-agent-options-authorize-${turn}`, () =>
          authorizedOptions(ledger, optionIds, currentAgentVersion),
        )
        if (!options) {
          if (calendarWriteOccurred) return
          logRuntime(env, {
            workflow: event.instanceId,
            event: "calendar-plan-authorization",
            outcome: "failed",
            failureCategory: "invalid-calendar-options",
          })
          await notify(env, step, event.payload.chatId, CALENDAR_AGENT_NO_DECISION, `options-authorize-${turn}`)
          return
        }
        const replacementKind = options.some((option) => option.plan.kind === "recurring")
          ? INTERACTION_KIND.CALENDAR_RECURRENCE_NEW_TIME
          : INTERACTION_KIND.CALENDAR_CONFLICT_REPLACE
        const response = await calendarPromptForActions(
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
        if (response.kind === INTERACTION_KIND.CALENDAR_CONFLICT_CANCEL) {
          await notify(env, step, event.payload.chatId, CALENDAR_CANCELLED, `options-cancel-${turn}`)
          return
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
        const decision = await consumeInStep(step, `calendar-agent-option-consume-${turn}`, ledger, (snapshot) =>
          consumeCalendarOption(snapshot, selected.optionId, currentAgentVersion),
        )
        ledger = decision.ledger
        const consumed = decision.authorization
        if (!consumed.ok) {
          if (calendarWriteOccurred) return
          await notify(env, step, event.payload.chatId, CALENDAR_AGENT_NO_DECISION, `option-consume-${turn}`)
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
            turnExpiresAt,
          ))
        ) {
          messages.push(availabilityChangedMessage())
          continue
        }
        await writePlan(env, step, event, consumed.plan, editing, turn)
        calendarWriteOccurred = true
        await confirmPlanForEditing(
          env,
          step,
          event,
          consumed.plan,
          editing,
          ++interactionVersion,
          turn,
          messages,
          editContext,
        )
        return
      }

      const authorized = await calendarDecision(step, `calendar-agent-plan-authorize-${turn}`, () =>
        inspectCalendarPlan(ledger, terminal.planId, currentAgentVersion),
      )
      if (!authorized.ok) {
        if (calendarWriteOccurred) return
        await notify(env, step, event.payload.chatId, CALENDAR_AGENT_NO_DECISION, `plan-authorize-${turn}`)
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
          turnExpiresAt,
        ))
      ) {
        messages.push(availabilityChangedMessage())
        continue
      }
      const decision = await consumeInStep(step, `calendar-agent-plan-consume-${turn}`, ledger, (snapshot) =>
        consumeCalendarPlan(snapshot, terminal.planId, currentAgentVersion),
      )
      ledger = decision.ledger
      const consumed = decision.authorization
      if (!consumed.ok) {
        if (calendarWriteOccurred) return
        await notify(env, step, event.payload.chatId, CALENDAR_AGENT_NO_DECISION, `plan-consume-${turn}`)
        return
      }
      await writePlan(env, step, event, consumed.plan, editing, turn)
      calendarWriteOccurred = true
      await confirmPlanForEditing(
        env,
        step,
        event,
        consumed.plan,
        editing,
        ++interactionVersion,
        turn,
        messages,
        editContext,
      )
      return
    } catch (error) {
      if (isWorkflowInterruption(error)) throw error
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
      await notify(
        env,
        step,
        event.payload.chatId,
        calendarWriteOccurred ? CALENDAR_UPDATE_FAILURE : CALENDAR_FAILURE,
        `failure-${turn}`,
      )
      return
    }
  }

  await notify(
    env,
    step,
    event.payload.chatId,
    "I still need clearer scheduling details. Please start a new request.",
    "turn-limit",
  )
}

/** Persists a decision so replay never repeats a wall-clock authorization check. */
async function calendarDecision<T>(step: WorkflowStep, name: string, decide: () => T): Promise<T> {
  return (await step.do(name, (async () => decide()) as never)) as T
}

/** Returns consumed ledger state alongside the decision so both are restored on replay. */
async function consumeInStep(
  step: WorkflowStep,
  name: string,
  ledger: CalendarPlanLedger,
  consume: (snapshot: CalendarPlanLedger) => CalendarPlanAuthorization,
): Promise<{ ledger: CalendarPlanLedger; authorization: CalendarPlanAuthorization }> {
  return calendarDecision(step, name, () => {
    const snapshot = structuredClone(ledger)
    const authorization = consume(snapshot)
    return { ledger: snapshot, authorization }
  })
}

/** Prompts once for Calendar reconnection without treating expected authorization state as a workflow exception. */
async function promptForAuthorizationRecovery(
  env: Env,
  step: WorkflowStep,
  event: WorkflowEvent<CalendarWorkflowParams>,
  version: number,
  turn: number,
): Promise<boolean> {
  const retry = await calendarPromptForActions(
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
  if (cancelled) await notify(env, step, event.payload.chatId, CALENDAR_CANCELLED, `reconnect-cancel-${turn}`)
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

/** Writes one exact authorized plan through a durable mutation step. */
async function writePlan(
  env: Env,
  step: WorkflowStep,
  event: WorkflowEvent<CalendarWorkflowParams>,
  plan: CalendarPlan,
  editing: boolean,
  turn: number,
): Promise<void> {
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
}

export interface CalendarEditContext {
  baseline: CalendarPlan
  messages: ToolConversationMessage[]
  /** Original identity is retained so edits update the exact managed event. */
  original: Omit<CalendarWorkflowParams, "edit">
  resourceId: string
}

const CALENDAR_EDIT_EXPIRED =
  "This calendar edit window has ended or the event has changed. Please start a new /calendar request."

/** Completes a saved write with a persistent Edit action and no event wait. */
async function confirmPlanForEditing(
  env: Env,
  step: WorkflowStep,
  event: WorkflowEvent<CalendarWorkflowParams>,
  plan: CalendarPlan,
  editing: boolean,
  version: number,
  turn: number,
  messages: ToolConversationMessage[],
  previous?: CalendarEditContext,
): Promise<void> {
  const router = createInteractionRouter(env.INTERACTION_ROUTER, event.payload.chatId)
  const prepared = await step.do(`calendar-agent-edit-context-${turn}`, async () => ({
    sessionId: crypto.randomUUID(),
    callbackToken: crypto.randomUUID(),
    expiresAt: Date.now() + CALENDAR_INTERACTION_TTL_MS,
  }))
  const original = previous?.original ?? event.payload
  const resourceId = previous?.resourceId ?? `calendar:${event.instanceId}`
  await step.do(`calendar-agent-save-edit-context-${turn}`, () =>
    router.saveEditContext({
      sessionId: prepared.sessionId,
      resourceId,
      userId: env.TELEGRAM_ALLOWED_USER_ID,
      expiresAt: prepared.expiresAt,
      context: { baseline: plan, messages, original, resourceId } satisfies CalendarEditContext,
    }),
  )
  const send = () =>
    createTelegramClient(env.TELEGRAM_BOT_TOKEN).sendMessage(event.payload.chatId, confirmationMessage(plan, editing), {
      replyMarkup: {
        inline_keyboard: [
          [{ text: plan.kind === "recurring" ? "Edit entire series" : "Edit", callback_data: prepared.callbackToken }],
        ],
      },
    })
  let sent: { messageId: number }
  try {
    sent = await step.do(`calendar-agent-confirmation-${turn}-notify`, send)
  } catch (error) {
    if (isWorkflowInterruption(error)) throw error
    // A failed notification must never cause another calendar write.
    try {
      sent = await step.do(`calendar-agent-confirmation-recovery-${turn}-notify`, send)
    } catch (error) {
      if (isWorkflowInterruption(error)) throw error
      return
    }
  }
  await step.do(`calendar-agent-confirmation-${turn}-register`, () =>
    router.register({
      interactionId: prepared.sessionId,
      version,
      workflowId: event.instanceId,
      kind: INTERACTION_KIND.CALENDAR_EDIT,
      callbackToken: prepared.callbackToken,
      botMessageId: sent.messageId,
      expiresAt: prepared.expiresAt,
      edit: { sessionId: prepared.sessionId },
    }),
  )
}

/** Runs only in response to Edit or feedback, with persisted ownership and exact event identity. */
export async function runCalendarEditWorkflow(
  env: Env,
  event: WorkflowEvent<CalendarWorkflowParams>,
  step: WorkflowStep,
): Promise<void> {
  const edit = event.payload.edit
  if (!edit || edit.userId !== env.TELEGRAM_ALLOWED_USER_ID) return
  const router = createInteractionRouter(env.INTERACTION_ROUTER, event.payload.chatId)
  const loaded = await calendarDecision(step, "calendar-edit-load-context", () =>
    router.editContext<CalendarEditContext>(edit.sessionId, edit.userId),
  )
  const context = loaded.context
  if (!context || !loaded.resourceId) {
    await notify(env, step, event.payload.chatId, CALENDAR_EDIT_EXPIRED, "edit-expired")
    return
  }
  if (edit.openPrompt) {
    const sent = await step.do("calendar-edit-prompt", async () => {
      const message = await createTelegramClient(env.TELEGRAM_BOT_TOKEN).sendMessage(
        event.payload.chatId,
        context.baseline.kind === "recurring"
          ? "Reply with the correction for the entire recurring series."
          : "Reply with the correction for this calendar block.",
        { replyMarkup: { force_reply: true } },
      )
      return {
        messageId: message.messageId,
        interactionId: crypto.randomUUID(),
        expiresAt: Math.min(loaded.expiresAt ?? Date.now(), Date.now() + CALENDAR_INTERACTION_TTL_MS),
      }
    })
    await step.do("calendar-edit-register-reply", () =>
      router.register({
        interactionId: sent.interactionId,
        version: 1,
        workflowId: event.instanceId,
        kind: INTERACTION_KIND.CALENDAR_EDIT_FEEDBACK,
        botMessageId: sent.messageId,
        expiresAt: sent.expiresAt,
        edit: { sessionId: edit.sessionId },
      }),
    )
    return
  }
  if (!edit.text?.trim()) return
  const claimed = await step.do("calendar-edit-claim", () =>
    router.claimEdit(loaded.resourceId as string, event.instanceId, "calendar"),
  )
  if (!claimed.ok) {
    await notify(
      env,
      step,
      event.payload.chatId,
      "A calendar edit is already in progress. Please wait for its confirmation.",
      "edit-busy",
    )
    return
  }
  let interrupted = false
  try {
    // Recheck after acquiring the resource lock: another edit may have saved a newer baseline.
    const current = await calendarDecision(step, "calendar-edit-recheck-context", () =>
      router.editContext<CalendarEditContext>(edit.sessionId, edit.userId),
    )
    if (!current.context) {
      await notify(env, step, event.payload.chatId, CALENDAR_EDIT_EXPIRED, "edit-stale")
      return
    }
    await runAgentCenteredCalendarWorkflow(
      env,
      { ...event, payload: { ...context.original, requestText: edit.text } } as WorkflowEvent<CalendarWorkflowParams>,
      step,
      context,
    )
  } catch (error) {
    interrupted = isWorkflowInterruption(error)
    throw error
  } finally {
    if (!interrupted)
      await step.do("calendar-edit-release", () => router.releaseEdit(loaded.resourceId as string, event.instanceId))
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
async function notify(env: Env, step: WorkflowStep, chatId: string, message: string, name: string): Promise<void> {
  await step.do(`calendar-agent-notify-${name}`, () =>
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
  const response = await calendarPromptForActions(env, step, event, version, name, message, [["Reply", kind]], false)
  return response.type === "reply" ? response.text : null
}
