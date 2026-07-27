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

const CALENDAR_TOOL = {
  GET_AVAILABLE_SLOTS: "get_available_slots",
  SUBMIT_ONE_OFF_PROPOSAL: "submit_one_off_proposal",
} as const
const CALENDAR_UNAVAILABLE =
  "Google Calendar is not connected. Open /setup/google-calendar to connect it, then try again."
const CALENDAR_CLARIFICATION = "I need a little more detail to schedule that safely."
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

const MIN_DURATION_MINUTES = 15
const MAX_AVAILABILITY_DURATION_MINUTES = 240
const availabilityInputSchema = z.object({
  localDate: z.string(),
  durationMinutes: z.number().int().min(MIN_DURATION_MINUTES).max(MAX_AVAILABILITY_DURATION_MINUTES),
})
const availabilityOutputSchema = z.object({ slots: z.array(z.string()) })
const proposalOutputSchema = z.object({ accepted: z.literal(true) })

function plannerPrompt(requestText: string, now: number, timeZone: string): string {
  const todayParts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(now))
    .filter((part) => part.type !== "literal")
  const localToday = Object.fromEntries(todayParts.map((part) => [part.type, part.value]))
  return `You are Kipp's personal calendar planner. Interpret the user request, but do not invent facts. Today is ${localToday.year}-${localToday.month}-${localToday.day} in ${timeZone}.\n\nUse submit_one_off_proposal exactly once. Use get_available_slots only when you need to choose a time. A proposal must have a YYYY-MM-DD date and HH:mm time when time is explicit. Mark needsClarification true if date, intent, or required timing is unclear. Generic defaults: personal calls 30 minutes, professional calls 15 minutes. Family/social without a usable time requires clarification. Do not include attendees, video links, private Calendar details, or any unsupported recurrence.\n\nUser request: ${requestText}`
}

function dateTimeForTool(localDate: string, timeZone: string): { timeMin: string; timeMax: string } | null {
  return calendarDayBounds(localDate, timeZone)
}

async function planOneOff(env: Env, requestText: string): Promise<OneOffProposal | null> {
  const timeZone = env.TIMEZONE || CALENDAR_TIMEZONE_DEFAULT
  const calendar = createGoogleCalendarClient(env)
  let submitted: OneOffProposal | null = null
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
        submitted = proposal
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
  return result.completed ? submitted : null
}

/**
 * The Calendar workflow is deliberately separate from LinkedIn. Its planning
 * and deterministic write stages are added incrementally in this milestone.
 */
export class CalendarWorkflow extends WorkflowEntrypoint<Env, CalendarWorkflowParams> {
  override async run(event: WorkflowEvent<CalendarWorkflowParams>, step: WorkflowStep): Promise<void> {
    logRuntime(this.env, { workflow: event.instanceId, event: "calendar-workflow-run", outcome: "started" })
    const plan = await step.do("calendar-plan", async () => {
      try {
        return await planOneOff(this.env, event.payload.requestText)
      } catch {
        return null
      }
    })
    const outcome = await step.do("calendar-schedule", async () => {
      if (!plan) return { message: CALENDAR_CLARIFICATION }
      const timeZone = this.env.TIMEZONE || CALENDAR_TIMEZONE_DEFAULT
      const bounds = plan.localDate ? calendarDayBounds(plan.localDate, timeZone) : null
      if (!bounds) return { message: CALENDAR_CLARIFICATION }
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
