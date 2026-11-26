import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers"
import { runCalendarAgentSession } from "../agent/calendar-session"
import { presentConversationTurn } from "../core/conversation-presenter"
import { type ConversationTurnCoordinator, createConversationTurn } from "../core/conversation-turn"
import { createInteractionRouter } from "../core/interaction-router-client"
import { type Env, INTERACTION_KIND, type WorkflowInteractionKind } from "../core/types"
import { isWorkflowInterruption } from "../core/workflow-events"
import {
  type CalendarAttendee,
  type ConflictEventSnapshot,
  createGoogleCalendarClient,
  type ExistingEventUpdateResult,
  GoogleCalendarError,
  type ManagedCalendarException,
} from "../integrations/google-calendar"
import { createTelegramClient } from "../integrations/telegram"
import { createToolProvider, type ToolConversationMessage } from "../providers"
import { resolveOpenRouterModel } from "../providers/routing"
import { logRuntime } from "../runtime/logging"
import type { CalendarEvaluationContext } from "./evaluation"
import { evaluateCalendarCandidate } from "./evaluation"
import {
  CALENDAR_CANCELLED,
  CALENDAR_INTERACTION_TTL_MS,
  calendarPromptForActions,
  calendarSetupUrl,
  notify,
  promptForReply,
} from "./interactions"
import { approveMeeting, attendeeLabel, type MeetingConfirmation, writeMeeting } from "./invitation"
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
import { isCalendarAttendeeEmail } from "./validation"
import type { CalendarWorkflowParams } from "./workflow"

const MILLISECONDS_PER_MINUTE = 60_000
const MAX_CALENDAR_INTERACTION_TURNS = 8
const CALENDAR_FAILURE = "I couldn't create that calendar block. Please try again shortly."
const CALENDAR_UPDATE_FAILURE = "I couldn't complete that calendar update. Please check the event before trying again."
const CALENDAR_AGENT_UNAVAILABLE = "I couldn't reach the calendar agent. Please try again shortly."
const CALENDAR_AGENT_NO_DECISION = "The calendar agent didn't return a scheduling decision. Please retry your request."
const CALENDAR_DISCLOSURE_LABEL = "Why this busy?"
/** Bounds serial conflict reads for a long recurring series. */
const MAX_DISCLOSURE_INTERVALS = 7
/** Bounds the disclosure body below Telegram's 4096-character limit. */
const MAX_DISCLOSURE_EVENTS = 10
const MAX_MULTI_ACTION_LABEL_CHARACTERS = 16
const EXPLICIT_INVITATION =
  /^(?:please\s+)?(?:(?:book|schedule|create|set up)\s+(?:an?\s+)?)?(?:invite\s|send an? invit(?:e|ation) to\b|(?:virtual (?:meeting|call|1:1|with)|google meet|video (?:call|meeting)|online (?:call|meeting|1:1))\b|(?:meeting|call|appointment|1:1)\s+with\s+\[email supplied\])/i
const EMAIL_IN_MESSAGE = /[^\s@<>,;:"()]+@[^\s@<>,;:"()]+/g
const RECIPIENT_EMAIL_CONTEXT =
  /(?:\b(?:meeting|call|appointment|1:1|google meet|virtual)\s+with|\binvite|\binvitation to|\bguest\s*:)\s*<?$/i
const TITLE_CONTEXT = /\b(?:title(?:d)?|named|called)\s*(?:[:=]|\s)/i
const EXPLICIT_GUEST_CHANGE =
  /\b(?:(?:change|switch|replace|add|remove|swap|update)\s+(?:(?:the|a|an|my)\s+)?(?:guests?|attendees?|recipients?)\b|(?:invite|add|remove)\s+[^.!?]+?\s+instead\b|(?:invite|send (?:the )?invite to)\s+[^.!?@]+@)/i
const TITLE_EMAIL_MARKER = /\[calendar email \d+\]/g

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
  | { status: "reply"; version: number; text: string; created?: CalendarPlan }

type ConflictMoveOutcome =
  | { kind: "moved"; etag?: string }
  | { kind: "created"; createdEventId: string }
  | { kind: "availability-changed" }
  | { kind: "failed"; message: string }

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
  let meetingRequested = Boolean(editContext?.attendees)
  let guestNames: string[] = []
  let revisedGuestName: string | undefined
  let suppliedAddresses: string[] = []
  const meetingEditId = editContext?.attendees
    ? (await managedEventIdentity(event.payload.chatId, event.payload.telegramMessageId)).id
    : undefined
  let requestedGuestChange = Boolean(meetingEditId && EXPLICIT_GUEST_CHANGE.test(event.payload.requestText))
  const emailMarkers = new Map(editContext?.emailMarkers)
  const userText = (text: string, titleOrTimeOnly = false) => {
    if (
      !titleOrTimeOnly &&
      !editContext &&
      EXPLICIT_INVITATION.test(text.replace(EMAIL_IN_MESSAGE, "[email supplied]"))
    )
      meetingRequested = true
    const captureGuest = !titleOrTimeOnly && !editContext && revisedGuestName === undefined
    const addresses: string[] = []
    const redacted = text.replace(EMAIL_IN_MESSAGE, (match, offset: number) => {
      const address = match.replace(/[.!?]+$/, "")
      if (!isCalendarAttendeeEmail(address)) return "[email supplied]"
      const prefix = text.slice(0, offset)
      const bareGuest = meetingRequested && text.trim() === match
      if (captureGuest && (bareGuest || (RECIPIENT_EMAIL_CONTEXT.test(prefix) && !TITLE_CONTEXT.test(prefix)))) {
        addresses.push(address)
        return `[email supplied]${match.slice(address.length)}`
      }
      let marker = emailMarkers.get(address)
      if (!marker) {
        marker = `[calendar email ${emailMarkers.size + 1}]`
        emailMarkers.set(address, marker)
      }
      return marker + match.slice(address.length)
    })
    if (addresses.length) suppliedAddresses = [...new Set(addresses)]
    return redacted
  }
  const restoreTitle = (title: string) => {
    const addresses = new Map([...emailMarkers].map(([address, marker]) => [marker, address]))
    return title.replace(TITLE_EMAIL_MARKER, (marker) => addresses.get(marker) ?? marker)
  }
  const agentBaseline = (plan: CalendarPlan) =>
    editBaselineMessage(withPlanTitle(plan, userText(plan.proposal.title, true)))
  const initialText = userText(event.payload.requestText)
  let messages: ToolConversationMessage[] = [
    {
      role: "user",
      text: `Current instant: ${new Date(expiresAt - CALENDAR_INTERACTION_TTL_MS).toISOString()}\nCalendar time zone: ${timeZone}\nUser request: ${initialText}`,
    },
  ]
  if (editContext)
    messages = [...editContext.messages, agentBaseline(editContext.baseline), { role: "user", text: initialText }]
  let ledger = createCalendarPlanLedger()
  let agentVersion = 0
  let interactionVersion = 0
  let retryUsed = false
  let editing = Boolean(editContext)
  let baseline: CalendarPlan | null = editContext?.baseline ?? null
  // A successful write is terminal for scheduling. If a workflow replay or a
  // later Edit turn reaches the agent again and it fails, do not emit a
  // contradictory pre-write "no decision" message.
  let calendarWriteOccurred = Boolean(editContext)

  let responseTurn = createConversationTurn()
  scheduling: for (let turn = 0; turn < MAX_CALENDAR_INTERACTION_TURNS; turn++) {
    const currentAgentVersion = ++agentVersion
    const calendar = createGoogleCalendarClient(env)
    try {
      const turnExpiresAt = editing
        ? await step.do(`calendar-agent-edit-expiry-${turn}`, async () => Date.now() + CALENDAR_INTERACTION_TTL_MS)
        : turn === 0
          ? expiresAt
          : await step.do(`calendar-agent-turn-expiry-${turn}`, async () => Date.now() + CALENDAR_INTERACTION_TTL_MS)
      const sessionStep = (await step.do(`calendar-agent-session-${turn}`, (async () => {
        const sessionLedger = structuredClone(ledger)
        const provider = createToolProvider(
          env.OPENROUTER_API_KEY,
          "openrouter",
          resolveOpenRouterModel(env.LLM_PROVIDER, env.LLM_MODEL),
          Number(env.LLM_MAX_RETRIES || "3"),
        )
        const evaluation: CalendarEvaluationContext = {
          getBusyIntervals: async (timeMin, timeMax) =>
            busyForCalendarPlan(calendar, timeMin, timeMax, baseline, timeZone, meetingEditId),
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
      const meetingIntent = sessionStep.session.meeting
      if (meetingIntent) {
        meetingRequested = true
        if (meetingIntent.guestNames.length) guestNames = meetingIntent.guestNames
      }
      logAgentSession(env, event.instanceId, sessionStep.session)

      if (sessionStep.session.calendarFailureKind === "authorization" && !retryUsed) {
        const retry = await promptForAuthorizationRecovery(env, step, event, ++interactionVersion, turn, responseTurn)
        responseTurn = createConversationTurn()
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
          await notify(env, step, event.payload.chatId, CALENDAR_UPDATE_FAILURE, `edit-session-${turn}`, responseTurn)
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
          responseTurn,
        )
        return
      }

      const terminal = sessionStep.session.terminal
      let selectedPlan: CalendarPlan
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
            responseTurn,
          )
          if (!reply) return
          responseTurn = createConversationTurn()
          messages.push({ role: "user", text: userText(reply) })
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
          await notify(
            env,
            step,
            event.payload.chatId,
            CALENDAR_AGENT_NO_DECISION,
            `options-authorize-${turn}`,
            responseTurn,
          )
          return
        }
        const replacementKind = options.some((option) => option.plan.kind === "recurring")
          ? INTERACTION_KIND.CALENDAR_RECURRENCE_NEW_TIME
          : INTERACTION_KIND.CALENDAR_CONFLICT_REPLACE
        const requestedTimeConflict = terminal.reasonCodes.includes("requested_time_conflicts")
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
            ...(requestedTimeConflict && !editing && !meetingRequested
              ? ([[CALENDAR_DISCLOSURE_LABEL, INTERACTION_KIND.CALENDAR_CONFLICT_DISCLOSE]] as Array<
                  [string, WorkflowInteractionKind]
                >)
              : []),
            ["Cancel", INTERACTION_KIND.CALENDAR_CONFLICT_CANCEL],
          ],
          true,
          responseTurn,
        )
        responseTurn = createConversationTurn()
        if (response.type === "timeout") return
        if (response.type === "reply") {
          messages.push({ role: "user", text: userText(response.text) })
          continue
        }
        if (response.kind === INTERACTION_KIND.CALENDAR_CONFLICT_CANCEL) {
          await notify(env, step, event.payload.chatId, CALENDAR_CANCELLED, `options-cancel-${turn}`, responseTurn)
          return
        }
        if (response.kind === INTERACTION_KIND.CALENDAR_CONFLICT_DISCLOSE && !meetingRequested) {
          const disclosure = await handleConflictDisclosure(
            env,
            step,
            event,
            interactionVersion,
            turn,
            timeZone,
            withPlanTitle(options[0].plan, restoreTitle(options[0].plan.proposal.title)),
            replacementKind,
          )
          interactionVersion = disclosure.version
          if (disclosure.status === "ended") return
          if (disclosure.status === "availability-changed") {
            messages.push(availabilityChangedMessage())
            continue
          }
          if (disclosure.status === "reply") {
            // After the block was created, a reply is an edit of that exact
            // block, never a fresh create from a pre-write scheduling session.
            if (disclosure.created) {
              editing = true
              baseline = disclosure.created
              calendarWriteOccurred = true
              messages.push(agentBaseline(disclosure.created))
            }
            messages.push({ role: "user", text: userText(disclosure.text) })
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
          messages.push({ role: "user", text: userText(replacement) })
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
            responseTurn,
          )
          if (!replacement) return
          responseTurn = createConversationTurn()
          messages.push({ role: "user", text: userText(replacement) })
          continue
        }
        const decision = await consumeInStep(step, `calendar-agent-option-consume-${turn}`, ledger, (snapshot) =>
          consumeCalendarOption(snapshot, selected.optionId, currentAgentVersion),
        )
        ledger = decision.ledger
        const consumed = decision.authorization
        if (!consumed.ok) {
          if (calendarWriteOccurred) return
          await notify(
            env,
            step,
            event.payload.chatId,
            CALENDAR_AGENT_NO_DECISION,
            `option-consume-${turn}`,
            responseTurn,
          )
          return
        }
        if (
          !(await revalidateExactPlanInStep(
            env,
            step,
            `calendar-agent-revalidate-${turn}`,
            meetingRequested && consumed.plan.kind === "one_off" ? exactMeetingPlan(consumed.plan) : consumed.plan,
            baseline,
            timeZone,
            editing ? turnExpiresAt : undefined,
            meetingEditId,
          ))
        ) {
          messages.push(availabilityChangedMessage())
          continue
        }
        selectedPlan = consumed.plan
      } else {
        const authorized = await calendarDecision(step, `calendar-agent-plan-authorize-${turn}`, () =>
          inspectCalendarPlan(ledger, terminal.planId, currentAgentVersion),
        )
        if (!authorized.ok) {
          if (calendarWriteOccurred) return
          await notify(
            env,
            step,
            event.payload.chatId,
            CALENDAR_AGENT_NO_DECISION,
            `plan-authorize-${turn}`,
            responseTurn,
          )
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
            editing ? turnExpiresAt : undefined,
            meetingEditId,
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
          await notify(
            env,
            step,
            event.payload.chatId,
            CALENDAR_AGENT_NO_DECISION,
            `plan-consume-${turn}`,
            responseTurn,
          )
          return
        }
        selectedPlan = consumed.plan
      }

      let meeting: MeetingConfirmation | undefined
      if (meetingRequested) {
        if (selectedPlan.kind !== "one_off" || (editing && !editContext?.attendees)) {
          await notify(
            env,
            step,
            event.payload.chatId,
            "Invitations are available for new one-off meetings. Start a new /calendar request with one time and one guest.",
            `invite-unsupported-${turn}`,
            responseTurn,
          )
          return
        }
        if (requestedGuestChange) {
          await notify(
            env,
            step,
            event.payload.chatId,
            "This Edit action can change the title or time of the invitation.",
            `invite-edit-unsupported-${turn}`,
            responseTurn,
          )
          return
        }
        selectedPlan = exactMeetingPlan(selectedPlan)
        const displayPlan = withPlanTitle(selectedPlan, restoreTitle(selectedPlan.proposal.title))
        const requestApproval = () =>
          approveMeeting(
            env,
            step,
            event,
            displayPlan,
            baseline,
            editContext?.attendees,
            revisedGuestName === undefined ? guestNames : revisedGuestName ? [revisedGuestName] : [],
            suppliedAddresses,
            timeZone,
            interactionVersion,
            turn,
            responseTurn,
          )
        let result = await requestApproval()
        interactionVersion = result.version
        responseTurn = createConversationTurn()
        while (result.kind === "changed" && result.changeGuest) {
          const guest = result.reply.trim()
          suppliedAddresses = isCalendarAttendeeEmail(guest) ? [guest] : []
          revisedGuestName = suppliedAddresses.length ? "" : guest
          if (++turn >= MAX_CALENDAR_INTERACTION_TURNS) break scheduling
          if (
            !(await revalidateExactPlanInStep(
              env,
              step,
              `calendar-invite-guest-revalidate-${turn}`,
              selectedPlan,
              baseline,
              timeZone,
            ))
          ) {
            messages.push(agentBaseline(selectedPlan), availabilityChangedMessage())
            continue scheduling
          }
          result = await requestApproval()
          interactionVersion = result.version
          responseTurn = createConversationTurn()
        }
        if (result.kind === "ended") return
        if (result.kind === "changed") {
          if (!editing) {
            suppliedAddresses = result.attendees.map(({ email }) => email)
            revisedGuestName = result.attendees[0]?.name ?? ""
          }
          requestedGuestChange = Boolean(meetingEditId && EXPLICIT_GUEST_CHANGE.test(result.reply))
          messages.push(agentBaseline(selectedPlan), { role: "user", text: userText(result.reply, true) })
          continue
        }
        if (
          !(await revalidateExactPlanInStep(
            env,
            step,
            `calendar-invite-revalidate-${turn}`,
            selectedPlan,
            baseline,
            timeZone,
            undefined,
            meetingEditId,
          ))
        ) {
          if (!editing) {
            suppliedAddresses = result.attendees.map(({ email }) => email)
            revisedGuestName = result.attendees[0]?.name ?? ""
          }
          messages.push(availabilityChangedMessage())
          continue
        }
        if (baseline?.kind === "one_off" && result.etag) {
          // The Calendar PATCH edits only title and time. Preserve the rest of the saved baseline for later edits.
          const { title, localDate, startTime, durationMinutes, dateIsExplicit, timeIsExplicit } = selectedPlan.proposal
          selectedPlan = {
            ...selectedPlan,
            proposal: {
              ...baseline.proposal,
              title,
              localDate,
              startTime,
              durationMinutes,
              dateIsExplicit,
              timeIsExplicit,
            },
            scheduled: { ...selectedPlan.scheduled, reminderMinutes: baseline.scheduled.reminderMinutes },
          }
        }
        selectedPlan = withPlanTitle(selectedPlan, restoreTitle(selectedPlan.proposal.title))
        const savedMeeting = await writeMeeting(
          env,
          step,
          event,
          selectedPlan,
          result.attendees,
          result.etag,
          timeZone,
          turn,
        )
        if (!savedMeeting) {
          await notify(
            env,
            step,
            event.payload.chatId,
            "That email belongs to the organizer. Start a new /calendar request with a different guest.",
            `invite-organizer-guest-${turn}`,
            responseTurn,
          )
          return
        }
        meeting = savedMeeting
        logRuntime(env, {
          workflow: event.instanceId,
          event: "calendar-write",
          outcome: "succeeded",
          details: { operation: editing ? "update" : "create", kind: "meeting" },
        })
      } else {
        selectedPlan = withPlanTitle(selectedPlan, restoreTitle(selectedPlan.proposal.title))
        await writePlan(env, step, event, selectedPlan, editing, turn)
      }
      calendarWriteOccurred = true
      if (meeting?.kind === "unverified") {
        await notify(
          env,
          step,
          event.payload.chatId,
          "The invitation may have been saved, but I couldn't verify it. Check Google Calendar before trying again.",
          `invite-unverified-${turn}`,
          responseTurn,
        )
        return
      }
      await confirmPlanForEditing(
        env,
        step,
        event,
        selectedPlan,
        editing,
        ++interactionVersion,
        turn,
        messages,
        editContext,
        responseTurn,
        meeting,
        [...emailMarkers],
      )
      return
    } catch (error) {
      if (isWorkflowInterruption(error)) throw error
      if (responseTurn.responded) throw error
      if (error instanceof GoogleCalendarError && error.kind === "authorization" && !retryUsed) {
        if (await promptForAuthorizationRecovery(env, step, event, ++interactionVersion, turn, responseTurn)) {
          responseTurn = createConversationTurn()
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
        calendarWriteOccurred
          ? CALENDAR_UPDATE_FAILURE
          : meetingRequested
            ? "I couldn't confirm the invitation. Please check Google Calendar before trying again."
            : CALENDAR_FAILURE,
        `failure-${turn}`,
        responseTurn,
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
    responseTurn,
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
  responseTurn: ConversationTurnCoordinator,
  name = `calendar-agent-reconnect-${turn}`,
  cancelName = `reconnect-cancel-${turn}`,
  cancelNotice: string | null = CALENDAR_CANCELLED,
): Promise<boolean> {
  const retry = await calendarPromptForActions(
    env,
    step,
    event,
    version,
    name,
    `${calendarUnavailableMessage(env, event.payload.setupOrigin)}\n\nReconnect, then tap Retry within 15 minutes.`,
    [
      ["Retry", INTERACTION_KIND.CALENDAR_RETRY],
      ["Cancel", INTERACTION_KIND.CALENDAR_CANCEL],
    ],
    true,
    responseTurn,
    "connection",
  )
  const accepted = retry.type === "action" && retry.kind === INTERACTION_KIND.CALENDAR_RETRY
  const cancelled = retry.type === "action" && retry.kind === INTERACTION_KIND.CALENDAR_CANCEL
  if (cancelled && cancelNotice) await notify(env, step, event.payload.chatId, cancelNotice, cancelName)
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
  expiresAt?: number,
  meetingEditId?: string,
): Promise<boolean> {
  const result = await step.do(name, async () => {
    try {
      return await revalidateExactPlan(
        createGoogleCalendarClient(env),
        expected,
        baseline,
        timeZone,
        expiresAt ?? Date.now() + CALENDAR_INTERACTION_TTL_MS,
        meetingEditId,
      )
    } catch (error) {
      if (!(error instanceof GoogleCalendarError) || error.kind !== "authorization") throw error
      // Replay the original reconnect branch even after the credentials have been restored.
      return { status: error.status ?? null, retryCount: error.retryCount }
    }
  })
  if (typeof result !== "boolean")
    throw new GoogleCalendarError(
      "Calendar availability could not be read",
      "authorization",
      result.status ?? undefined,
      undefined,
      result.retryCount,
    )
  return result
}

/** Re-runs deterministic evaluation and accepts only the exact previously authorized plan. */
async function revalidateExactPlan(
  calendar: ReturnType<typeof createGoogleCalendarClient>,
  expected: CalendarPlan,
  baseline: CalendarPlan | null,
  timeZone: string,
  expiresAt: number,
  meetingEditId?: string,
): Promise<boolean> {
  const ledger = createCalendarPlanLedger()
  const evaluation = await evaluateCalendarCandidate(
    expected.kind === "one_off"
      ? { kind: "one_off", proposal: expected.proposal }
      : { kind: "recurring", proposal: expected.proposal },
    {
      getBusyIntervals: async (timeMin, timeMax) =>
        busyForCalendarPlan(calendar, timeMin, timeMax, baseline, timeZone, meetingEditId),
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

/** Meeting edits exclude the saved event by ID, so a separate event at the same time still blocks the slot. */
async function busyForCalendarPlan(
  calendar: ReturnType<typeof createGoogleCalendarClient>,
  timeMin: string,
  timeMax: string,
  baseline: CalendarPlan | null,
  timeZone: string,
  meetingEditId?: string,
) {
  if (!meetingEditId) return withoutCreatedBaseline(await calendar.getBusyIntervals(timeMin, timeMax), baseline)

  const { events, truncated } = await calendar.listEvents(timeMin, timeMax, { forAvailability: true })
  if (truncated) throw new GoogleCalendarError("Calendar availability could not be read", "permanent")
  return events.flatMap((event) => {
    if (event.reference === meetingEditId || event.transparency === "transparent" || event.declined) return []
    if (!event.allDay) return [{ start: event.start, end: event.end }]
    const start = calendarDayBounds(event.start, timeZone)?.timeMin
    const end = calendarDayBounds(event.end, timeZone)?.timeMin
    if (!start || !end) throw new GoogleCalendarError("Calendar availability could not be read", "permanent")
    return [{ start, end }]
  })
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
  attendees?: CalendarAttendee[]
  emailMarkers?: Array<[string, string]>
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
  responseTurn = createConversationTurn(),
  meeting?: Extract<MeetingConfirmation, { kind: "verified" }>,
  emailMarkers?: Array<[string, string]>,
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
      context: {
        baseline: plan,
        messages,
        original,
        resourceId,
        ...(meeting ? { attendees: meeting.attendees } : {}),
        ...(emailMarkers?.length ? { emailMarkers } : {}),
      } satisfies CalendarEditContext,
    }),
  )
  responseTurn.claim("confirmation")
  const send = async () => {
    const parts = await presentConversationTurn(
      {
        kind: "confirmation",
        message: meeting
          ? `${confirmationMessage(plan, editing)}\nGuest: ${attendeeLabel(meeting.attendees[0])}.\n${
              meeting.saved.meetUrl
                ? `Google Meet: ${meeting.saved.meetUrl}`
                : `Google Meet ${meeting.saved.conference === "failed" ? "could not be created" : "is not ready yet"}.`
            }${meeting.saved.calendarUrl ? `\nCalendar: ${meeting.saved.calendarUrl}` : ""}`
          : confirmationMessage(plan, editing),
        controls: {
          kind: "inline",
          rows: [
            [
              {
                intent: "edit",
                label: plan.kind === "recurring" ? "Edit entire series" : "Edit",
                callbackToken: prepared.callbackToken,
              },
            ],
          ],
        },
      },
      ({ text, options }) =>
        createTelegramClient(env.TELEGRAM_BOT_TOKEN).sendMessage(event.payload.chatId, text, options),
    )
    return parts[parts.length - 1]
  }
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
    const turn = createConversationTurn()
    turn.claim("clarification")
    const sent = await step.do("calendar-edit-prompt", async () => {
      const parts = await presentConversationTurn(
        {
          kind: "clarification",
          message:
            context.baseline.kind === "recurring"
              ? "Reply with the correction for the entire recurring series."
              : "Reply with the correction for this calendar block.",
          controls: { kind: "reply" },
        },
        ({ text, options }) =>
          createTelegramClient(env.TELEGRAM_BOT_TOKEN).sendMessage(event.payload.chatId, text, options),
      )
      const message = parts[parts.length - 1]
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
  const intervals: Array<{ start: number; end: number; timeMin: string; timeMax: string }> = []
  for (const occurrence of plan.requestedConflicts) {
    const start = Date.parse(occurrence.start)
    const end = Date.parse(occurrence.end)
    const bounds = calendarDayBounds(occurrence.localDate, timeZone)
    if (!Number.isFinite(start) || !Number.isFinite(end) || !bounds) continue
    intervals.push({ start, end, timeMin: bounds.timeMin, timeMax: bounds.timeMax })
  }
  return intervals.slice(0, MAX_DISCLOSURE_INTERVALS)
}

/** Renders the owner-visible disclosure body listing overlapping events as plain text, bounded for Telegram. */
function disclosureMessage(snapshots: ConflictEventSnapshot[], timeZone: string, showDates: boolean): string {
  const lines = snapshots.slice(0, MAX_DISCLOSURE_EVENTS).map((snapshot) => {
    const range = snapshot.allDay
      ? "all day"
      : `${localTimeAt(Date.parse(snapshot.start), timeZone)}–${localTimeAt(Date.parse(snapshot.end), timeZone)}`
    const date = snapshot.allDay ? snapshot.start : localDateAt(Date.parse(snapshot.start), timeZone)
    const when = showDates ? `${date} ${range}` : range
    return `• ${snapshot.title} (${when})`
  })
  const hidden = snapshots.length - lines.length
  const more = hidden > 0 ? `\n…and ${hidden} more event${hidden === 1 ? "" : "s"} overlap this time.` : ""
  return `Your requested time is occupied by:\n${lines.join("\n")}${more}\n\nChoose an event to reschedule, try another time, or cancel.`
}

/** Returns a time-derived reschedule label, disambiguated only when movable events share a start time. */
function rescheduleLabel(startTime: string, duplicateIndex: number): string {
  if (duplicateIndex === 0) return `Reschedule ${startTime}`.slice(0, MAX_MULTI_ACTION_LABEL_CHARACTERS)
  const suffix = ` (${duplicateIndex + 1})`
  return `Resch. ${startTime}`.slice(0, MAX_MULTI_ACTION_LABEL_CHARACTERS - suffix.length) + suffix
}

/** Prompts for Calendar reconnection after authorization expires during conflict recovery. */
function promptConflictReconnect(
  env: Env,
  step: WorkflowStep,
  event: WorkflowEvent<CalendarWorkflowParams>,
  version: number,
  turn: number,
  phase: string,
): Promise<boolean> {
  return promptForAuthorizationRecovery(
    env,
    step,
    event,
    version,
    turn,
    createConversationTurn(),
    `calendar-conflict-reconnect-${phase}-${turn}`,
    `calendar-conflict-reconnect-cancel-${phase}-${turn}`,
    null,
  )
}

/** Identifies provider authorization failures that a reconnect-and-retry can recover. */
function isAuthorizationFailure(error: unknown): boolean {
  return error instanceof GoogleCalendarError && error.kind === "authorization"
}

/** Restores a displaced conflict event, resuming once after an owner-driven reconnection. */
async function restoreConflictEvent(
  env: Env,
  step: WorkflowStep,
  event: WorkflowEvent<CalendarWorkflowParams>,
  version: number,
  turn: number,
  phase: string,
  snapshot: ConflictEventSnapshot,
  expectedEtag?: string,
): Promise<{ restored: boolean; version: number }> {
  let v = version
  let attempt = 0
  while (true) {
    const result = (await step.do(`calendar-conflict-restore-${turn}-${phase}-${attempt}`, async () => {
      const client = createGoogleCalendarClient(env)
      return expectedEtag === undefined
        ? client.moveExistingEvent(snapshot.id, snapshot.start, snapshot.end)
        : client.moveExistingEvent(snapshot.id, snapshot.start, snapshot.end, expectedEtag)
    })) as ExistingEventUpdateResult
    if (result.ok) return { restored: true, version: v }
    if (result.reason !== "authorization" || attempt > 0) return { restored: false, version: v }
    if (!(await promptConflictReconnect(env, step, event, ++v, turn, `${phase}-restore-${attempt}`)))
      return { restored: false, version: v }
    attempt++
  }
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
  const movable =
    plan.kind === "one_off" ? snapshots.slice(0, MAX_DISCLOSURE_EVENTS).filter((snapshot) => snapshot.movable) : []
  const seenStarts = new Map<string, number>()
  const actions: Array<[string, WorkflowInteractionKind]> = movable.map((snapshot) => {
    const startTime = localTimeAt(Date.parse(snapshot.start), timeZone)
    const duplicateIndex = seenStarts.get(snapshot.start) ?? 0
    seenStarts.set(snapshot.start, duplicateIndex + 1)
    return [rescheduleLabel(startTime, duplicateIndex), INTERACTION_KIND.CALENDAR_CONFLICT_RESCHEDULE]
  })
  actions.push(["Try another time", replacementKind], ["Cancel", INTERACTION_KIND.CALENDAR_CONFLICT_CANCEL])

  const disclosure = await calendarPromptForActions(
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
    await notify(env, step, event.payload.chatId, CALENDAR_CANCELLED, `calendar-conflict-disclose-cancel-${turn}`)
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
    // Reserve the requested block so the chosen target actually frees it.
    return suggestOneOffAlternative(
      movedProposal,
      [...busy, { start: new Date(requested.start).toISOString(), end: new Date(requested.end).toISOString() }],
      timeZone,
    )
  })) as ScheduledOneOff | null
  if (!target) {
    await notify(
      env,
      step,
      event.payload.chatId,
      `I couldn't find a free slot to move ${snapshot.title} to. Please try another time or check your Calendar.`,
      `calendar-conflict-no-slot-${turn}`,
    )
    return { status: "ended", version: v }
  }

  const proposeMessage = `Move ${snapshot.title} from ${localTimeAt(Date.parse(snapshot.start), timeZone)}–${localTimeAt(Date.parse(snapshot.end), timeZone)} to ${localTimeAt(Date.parse(target.start), timeZone)}–${localTimeAt(Date.parse(target.end), timeZone)}?`
  const confirmation = await calendarPromptForActions(
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
    await notify(env, step, event.payload.chatId, CALENDAR_CANCELLED, `calendar-conflict-propose-cancel-${turn}`)
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
  // The move, revalidation, and create are separate durable steps so a completed
  // step is checkpointed before the next can fail; the already-at-target read
  // makes a replayed move a no-op.
  const moved = (await step.do(`calendar-conflict-move-${turn}`, async () => {
    const client = createGoogleCalendarClient(env)
    // The owner waited on the confirmation; recheck the target before writing.
    const busy = await client.getBusyIntervals(bounds.timeMin, bounds.timeMax)
    const targetStart = Date.parse(target.start)
    const targetEnd = Date.parse(target.end)
    const snapshotStart = Date.parse(snapshot.start)
    const snapshotEnd = Date.parse(snapshot.end)
    const occupied = busy.some(({ start, end }) => {
      const startMs = Date.parse(start)
      const endMs = Date.parse(end)
      if (startMs === snapshotStart && endMs === snapshotEnd) return false
      return startMs < targetEnd && endMs > targetStart
    })
    if (occupied) return { kind: "availability-changed" } as ConflictMoveOutcome
    const move = await client.moveExistingEvent(snapshot.id, target.start, target.end, snapshot.etag)
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
    return { kind: "moved", etag: move.etag } as ConflictMoveOutcome
  })) as ConflictMoveOutcome

  if (moved.kind === "availability-changed") return { status: "availability-changed", version: v }
  if (moved.kind === "failed") {
    logRuntime(env, {
      workflow: event.instanceId,
      event: "calendar-conflict-operation",
      outcome: "failed",
      failureCategory: "calendar-conflict-phase-failed",
    })
    await notify(env, step, event.payload.chatId, moved.message, `calendar-conflict-move-failed-${turn}`)
    return { status: "ended", version: v }
  }
  if (moved.kind !== "moved") return { status: "ended", version: v }

  let stillValid = false
  let authorizationUnresolved = false
  let reconnectAttempt = 0
  while (true) {
    try {
      stillValid = (await step.do(`calendar-conflict-revalidate-${turn}-${reconnectAttempt}`, async () => {
        const client = createGoogleCalendarClient(env)
        return revalidateExactPlan(client, requestedPlan, null, timeZone, Date.now() + CALENDAR_INTERACTION_TTL_MS)
      })) as boolean
      break
    } catch (error) {
      if (isWorkflowInterruption(error)) throw error
      if (!isAuthorizationFailure(error)) {
        stillValid = false
        break
      }
      if (
        reconnectAttempt > 0 ||
        !(await promptConflictReconnect(env, step, event, ++v, turn, `revalidate-${reconnectAttempt}`))
      ) {
        stillValid = false
        authorizationUnresolved = true
        break
      }
      reconnectAttempt++
    }
  }
  if (!stillValid) {
    // A declined/expired reconnect must not attempt a Calendar write with
    // authorization still revoked, so only ordinary failures compensate.
    let restored = false
    let version = v
    if (!authorizationUnresolved) {
      const compensation = await restoreConflictEvent(env, step, event, v, turn, "revalidate", snapshot, moved.etag)
      restored = compensation.restored
      version = compensation.version
    }
    if (restored) {
      await notify(
        env,
        step,
        event.payload.chatId,
        `I couldn't create your block, so I restored ${snapshot.title} to its original time.`,
        `calendar-conflict-revalidate-restored-${turn}`,
      )
      return { status: "ended", version }
    }
    logRuntime(env, {
      workflow: event.instanceId,
      event: "calendar-conflict-operation",
      outcome: "failed",
      failureCategory: "calendar-conflict-revalidate-failed",
    })
    await notify(
      env,
      step,
      event.payload.chatId,
      `I moved ${snapshot.title} to ${localTimeAt(Date.parse(target.start), timeZone)} but couldn't create your block or restore it. Please check your Calendar.`,
      `calendar-conflict-revalidate-failed-${turn}`,
    )
    return { status: "ended", version }
  }

  let createFailure: unknown = null
  try {
    await step.do(`calendar-conflict-create-${turn}`, async () => {
      const client = createGoogleCalendarClient(env)
      await client.createManagedEvent(managedEvent(identity, plan.proposal, requestedScheduled, timeZone))
    })
  } catch (error) {
    if (isWorkflowInterruption(error)) throw error
    createFailure = error
  }
  if (createFailure) {
    // An ambiguous create may have applied upstream without a successful readback.
    // Remove the deterministic managed event before restoring the displaced event,
    // so compensation can never leave two events at the requested time.
    let removed = false
    let reconcileAttempt = 0
    while (true) {
      try {
        removed = (await step.do(`calendar-conflict-create-reconcile-${turn}-${reconcileAttempt}`, async () => {
          const client = createGoogleCalendarClient(env)
          await client.deleteManagedEvent(identity.id)
          return !(await client.findManagedEvent(identity.id, identity.requestId))
        })) as boolean
        break
      } catch (error) {
        if (isWorkflowInterruption(error)) throw error
        if (
          !isAuthorizationFailure(error) ||
          reconcileAttempt > 0 ||
          !(await promptConflictReconnect(env, step, event, ++v, turn, `reconcile-${reconcileAttempt}`))
        ) {
          removed = false
          break
        }
        reconcileAttempt++
      }
    }
    if (!removed) {
      logRuntime(env, {
        workflow: event.instanceId,
        event: "calendar-conflict-operation",
        outcome: "failed",
        failureCategory: "calendar-conflict-reconcile-failed",
      })
      await notify(
        env,
        step,
        event.payload.chatId,
        `I couldn't confirm whether your new block was created, so I left ${snapshot.title} at ${localTimeAt(Date.parse(target.start), timeZone)} to avoid two overlapping events. Please check your Calendar.`,
        `calendar-conflict-create-unresolved-${turn}`,
      )
      return { status: "ended", version: v }
    }
    const compensation = await restoreConflictEvent(env, step, event, v, turn, "create", snapshot, moved.etag)
    if (compensation.restored) {
      await notify(
        env,
        step,
        event.payload.chatId,
        `I couldn't create your block, so I restored ${snapshot.title} to its original time.`,
        `calendar-conflict-create-restored-${turn}`,
      )
      return { status: "ended", version: compensation.version }
    }
    logRuntime(env, {
      workflow: event.instanceId,
      event: "calendar-conflict-operation",
      outcome: "failed",
      failureCategory: "calendar-conflict-phase-failed",
    })
    await notify(
      env,
      step,
      event.payload.chatId,
      `I moved ${snapshot.title} to ${localTimeAt(Date.parse(target.start), timeZone)} but couldn't create your block or restore it. Please check your Calendar.`,
      `calendar-conflict-create-failed-${turn}`,
    )
    return { status: "ended", version: compensation.version }
  }
  const outcome = { kind: "created" as const, createdEventId: identity.id }

  const createdMessage = `${confirmationMessage(requestedPlan, false)}\nMoved ${snapshot.title} from ${localTimeAt(Date.parse(snapshot.start), timeZone)}–${localTimeAt(Date.parse(snapshot.end), timeZone)} to ${localTimeAt(Date.parse(target.start), timeZone)}–${localTimeAt(Date.parse(target.end), timeZone)} to make room.`
  const after = await calendarPromptForActions(
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
  if (after.type === "reply") return { status: "reply", version: v, text: after.text, created: requestedPlan }
  if (after.kind !== INTERACTION_KIND.CALENDAR_CONFLICT_UNDO) return { status: "ended", version: v }

  // Restoration and deletion are separate durable steps so a delete failure
  // after a completed restore resumes deletion instead of repeating recovery.
  let undoVersion = v
  let restoreAttempt = 0
  let restoreResult: ExistingEventUpdateResult
  while (true) {
    restoreResult = (await step.do(`calendar-conflict-undo-restore-${turn}-${restoreAttempt}`, async () => {
      const client = createGoogleCalendarClient(env)
      return moved.etag === undefined
        ? client.moveExistingEvent(snapshot.id, snapshot.start, snapshot.end)
        : client.moveExistingEvent(snapshot.id, snapshot.start, snapshot.end, moved.etag)
    })) as ExistingEventUpdateResult
    if (restoreResult.ok) break
    if (restoreResult.reason !== "authorization" || restoreAttempt > 0) break
    if (!(await promptConflictReconnect(env, step, event, ++undoVersion, turn, `undo-restore-${restoreAttempt}`))) break
    restoreAttempt++
  }
  if (!restoreResult.ok) {
    await notify(
      env,
      step,
      event.payload.chatId,
      restoreResult.reason === "authorization"
        ? `I couldn't restore ${snapshot.title} because Calendar needs reconnecting. The new block stays. Please try again.`
        : `I couldn't restore ${snapshot.title} because it changed externally. The new block stays. Please check your Calendar.`,
      `calendar-conflict-undo-result-${turn}`,
    )
    return { status: "ended", version: undoVersion }
  }
  let deleteAttempt = 0
  while (true) {
    try {
      await step.do(`calendar-conflict-undo-delete-${turn}-${deleteAttempt}`, async () => {
        const client = createGoogleCalendarClient(env)
        await client.deleteManagedEvent(outcome.createdEventId)
      })
      await notify(
        env,
        step,
        event.payload.chatId,
        `Restored ${snapshot.title} to its original time and removed the created block.`,
        `calendar-conflict-undo-result-${turn}`,
      )
      return { status: "ended", version: undoVersion }
    } catch (error) {
      if (isWorkflowInterruption(error)) throw error
      if (
        error instanceof GoogleCalendarError &&
        error.kind === "authorization" &&
        deleteAttempt === 0 &&
        (await promptConflictReconnect(env, step, event, ++undoVersion, turn, `undo-delete-${deleteAttempt}`))
      ) {
        deleteAttempt++
        continue
      }
      await notify(
        env,
        step,
        event.payload.chatId,
        `${snapshot.title} was restored, but your new block may remain. Please check your Calendar.`,
        `calendar-conflict-undo-result-${turn}`,
      )
      return { status: "ended", version: undoVersion }
    }
  }
}

/** Compares complete serializable plans so revalidation cannot substitute any field. */
function sameCalendarPlan(left: CalendarPlan, right: CalendarPlan): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** A picked alternative must stay anchored to its scheduled slot during invitation rechecks. */
function exactMeetingPlan(
  plan: Extract<CalendarPlan, { kind: "one_off" }>,
): Extract<CalendarPlan, { kind: "one_off" }> {
  return {
    ...plan,
    proposal: { ...plan.proposal, startTime: plan.scheduled.localStartTime, timeIsExplicit: true },
  }
}

/** Copies a plan with its display or model-facing title while preserving scheduling fields. */
function withPlanTitle<T extends CalendarPlan>(plan: T, title: string): T {
  return { ...plan, proposal: { ...plan.proposal, title } }
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

/** Renders the fixed operational message used when Calendar authorization is missing. */
function calendarUnavailableMessage(env: Env, setupOrigin?: string): string {
  return `Google Calendar is not connected. Open ${calendarSetupUrl(env, setupOrigin)} to authorize Calendar and Contacts.`
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
      ...(execution.validationPaths?.length || execution.rejectionCodes?.length
        ? {
            details: {
              ...(execution.validationPaths?.length ? { validationPaths: execution.validationPaths.join(",") } : {}),
              ...(execution.rejectionCodes?.length ? { rejectionCodes: execution.rejectionCodes.join(",") } : {}),
            },
          }
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
