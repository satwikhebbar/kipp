import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import { z } from "zod"
import {
  CALENDAR_TIMEZONE_DEFAULT,
  calendarDayBounds,
  managedEvent,
  managedEventIdentity,
  type OneOffProposal,
  scheduleOneOff,
} from "./calendar-scheduling"
import { createGoogleCalendarClient, GoogleCalendarError } from "./integrations/google-calendar"
import { createTelegramClient } from "./integrations/telegram"
import { createToolProvider } from "./providers"
import { logRuntime } from "./runtime/logging"
import { runTools } from "./runtime/tool-runner"
import type { ToolRegistry } from "./runtime/tools"
import type { Env } from "./types"

export interface CalendarWorkflowParams {
  chatId: string
  requestText: string
  telegramMessageId: number
}

interface CalendarPlanningResult {
  proposal: OneOffProposal | null
  clarification?: string
  failureCategory?: "no-submitted-proposal" | "provider-or-tool-failure"
}

type CalendarPlanningDecision =
  | { kind: "proposal"; proposal: OneOffProposal }
  | { kind: "clarification"; message: string }

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
const CALENDAR_CONFLICT = "That time is not free. Please send another time that works."
const CALENDAR_FAILURE = "I couldn't create that calendar block. Please try again shortly."

const proposalSchema = z.object({
  title: z.string(),
  localDate: z.string().optional(),
  startTime: z.string().optional(),
  durationMinutes: z.number().int(),
  dateIsExplicit: z.boolean(),
  timeIsExplicit: z.boolean(),
  classification: z.enum(["ordinary", "family-social", "school-pickup", "appointment", "maintenance", "physical"]),
  description: z.string().optional(),
  location: z.string().optional(),
  reminderMinutes: z.number().int().optional(),
  needsClarification: z.boolean(),
})

const availabilityInputSchema = z.object({ localDate: z.string(), durationMinutes: z.number().int().min(15).max(240) })
const availabilityOutputSchema = z.object({ slots: z.array(z.string()) })
const proposalOutputSchema = z.object({ accepted: z.literal(true) })
const clarificationInputSchema = z.object({ message: z.string().trim().min(1).max(240) })
const clarificationOutputSchema = z.object({ accepted: z.literal(true) })

function plannerPrompt(requestText: string, now: number, timeZone: string): string {
  const todayParts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(now))
    .filter((part) => part.type !== "literal")
  const localToday = Object.fromEntries(todayParts.map((part) => [part.type, part.value]))
  return `You are Kipp's personal calendar planner. Interpret the user request, but do not invent facts. Today is ${localToday.year}-${localToday.month}-${localToday.day} in ${timeZone}.\n\nUse exactly one terminal action: submit_one_off_proposal when you have enough information, or request_clarification when you do not. Use get_available_slots only when you need to choose a time. A proposal must have a YYYY-MM-DD date and HH:mm time when time is explicit, and needsClarification must be false. A clarification must ask for the one specific missing or ambiguous detail; never use a generic request for more detail. Generic defaults: personal calls 30 minutes, professional calls 15 minutes. Family/social without a usable time requires clarification. Do not include attendees, video links, private Calendar details, or any unsupported recurrence.\n\nUser request: ${requestText}`
}

function dateTimeForTool(localDate: string, timeZone: string): { timeMin: string; timeMax: string } | null {
  return calendarDayBounds(localDate, timeZone)
}

/** Uses the planner's bounded tool session to return either a proposal or one focused clarification question. */
async function planOneOff(env: Env, requestText: string): Promise<CalendarPlanningDecision | null> {
  const timeZone = env.TIMEZONE || CALENDAR_TIMEZONE_DEFAULT
  const calendar = createGoogleCalendarClient(env)
  let decision: CalendarPlanningDecision | null = null
  function recordDecision(next: CalendarPlanningDecision): void {
    if (decision) throw new Error("Calendar planner attempted multiple terminal actions")
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
      description: "Submit the single structured one-off proposal. This does not create a Calendar event.",
      input: proposalSchema,
      output: proposalOutputSchema,
      privacy: "private",
      handler: async (proposal) => {
        recordDecision({ kind: "proposal", proposal })
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
  const result = await runTools(provider, registry, Object.values(CALENDAR_TOOL), [
    { role: "system", text: plannerPrompt(requestText, Date.now(), timeZone) },
  ])
  return result.completed ? decision : null
}

/**
 * The Calendar workflow is deliberately separate from LinkedIn. Its planning
 * and deterministic write stages are added incrementally in this milestone.
 */
export class CalendarWorkflow extends WorkflowEntrypoint<Env, CalendarWorkflowParams> {
  override async run(event: WorkflowEvent<CalendarWorkflowParams>, step: WorkflowStep): Promise<void> {
    logRuntime(this.env, { workflow: event.instanceId, event: "calendar-workflow-run", outcome: "started" })
    const planning = await step.do("calendar-plan", async (): Promise<CalendarPlanningResult> => {
      try {
        const decision = await planOneOff(this.env, event.payload.requestText)
        if (!decision) return { proposal: null, failureCategory: "no-submitted-proposal" }
        return decision.kind === "proposal"
          ? { proposal: decision.proposal }
          : { proposal: null, clarification: decision.message }
      } catch {
        return { proposal: null, failureCategory: "provider-or-tool-failure" }
      }
    })
    if (planning.failureCategory)
      logRuntime(this.env, {
        workflow: event.instanceId,
        event: "calendar-planning",
        outcome: "failed",
        failureCategory: planning.failureCategory,
      })
    const outcome = await step.do("calendar-schedule", async () => {
      if (planning.clarification) return { message: planning.clarification }
      if (!planning.proposal)
        return {
          message:
            planning.failureCategory === "provider-or-tool-failure"
              ? CALENDAR_PLANNER_UNAVAILABLE
              : CALENDAR_UNDERSTANDING_FALLBACK,
        }
      const plan = planning.proposal
      const timeZone = this.env.TIMEZONE || CALENDAR_TIMEZONE_DEFAULT
      const bounds = plan.localDate ? calendarDayBounds(plan.localDate, timeZone) : null
      if (!bounds) return { message: "Please tell me the date for this calendar block." }
      try {
        const calendar = createGoogleCalendarClient(this.env)
        const busy = await calendar.getBusyIntervals(bounds.timeMin, bounds.timeMax)
        const scheduled = scheduleOneOff(plan, busy, timeZone)
        if ("clarification" in scheduled) return { message: scheduled.clarification }
        if ("conflict" in scheduled) return { message: CALENDAR_CONFLICT }
        const identity = await managedEventIdentity(event.payload.chatId, event.payload.telegramMessageId)
        await calendar.createManagedEvent(managedEvent(identity, plan, scheduled, timeZone))
        return { message: `Added: ${plan.title.trim()} on ${plan.localDate} at ${scheduled.localStartTime}.` }
      } catch (error) {
        if (error instanceof GoogleCalendarError && error.kind === "authorization")
          return { message: CALENDAR_UNAVAILABLE }
        return { message: CALENDAR_FAILURE }
      }
    })
    await step.do("calendar-notify", async () => {
      const tg = createTelegramClient(this.env.TELEGRAM_BOT_TOKEN)
      await tg.sendMessage(event.payload.chatId, outcome.message)
    })
    logRuntime(this.env, { workflow: event.instanceId, event: "calendar-workflow-run", outcome: "succeeded" })
  }
}
