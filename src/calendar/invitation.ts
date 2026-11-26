import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers"
import { type ConversationTurnCoordinator, createConversationTurn } from "../core/conversation-turn"
import { type Env, INTERACTION_KIND, type WorkflowInteractionKind } from "../core/types"
import { isWorkflowInterruption } from "../core/workflow-events"
import {
  type CalendarAttendee,
  createGoogleCalendarClient,
  GoogleCalendarError,
  MeetingGuestIsOrganizerError,
  type SavedMeeting,
} from "../integrations/google-calendar"
import { CALENDAR_CANCELLED, calendarPromptForActions, calendarSetupUrl, notify, promptForReply } from "./interactions"
import type { CalendarPlan } from "./plan"
import { localDateAt, localTimeAt, managedEvent, managedEventIdentity } from "./scheduling"
import { isCalendarAttendeeEmail } from "./validation"
import type { CalendarWorkflowParams } from "./workflow"

const MAX_CONTACT_CHOICES = 5
const MAX_CONTACT_LABEL_NAME_LENGTH = 120

export type MeetingConfirmation =
  | { kind: "verified"; attendees: CalendarAttendee[]; saved: SavedMeeting }
  | { kind: "unverified" }

type MeetingApproval =
  | { kind: "ended"; version: number }
  | { kind: "changed"; version: number; reply: string; attendees: CalendarAttendee[]; changeGuest?: true }
  | { kind: "approved"; version: number; attendees: CalendarAttendee[]; etag?: string }

/** Renders the exact invite destination, safely folding contact name whitespace. */
export function attendeeLabel(attendee: CalendarAttendee): string {
  return attendee.name
    ? `${attendee.name.replace(/\s+/g, " ").trim().slice(0, MAX_CONTACT_LABEL_NAME_LENGTH)} <${attendee.email}>`
    : attendee.email
}

/** Resolves a guest and obtains one owner approval for the final title, time and recipient. */
export async function approveMeeting(
  env: Env,
  step: WorkflowStep,
  event: WorkflowEvent<CalendarWorkflowParams>,
  plan: Extract<CalendarPlan, { kind: "one_off" }>,
  baseline: CalendarPlan | null,
  existingAttendees: CalendarAttendee[] | undefined,
  guestNames: string[],
  suppliedAddresses: string[],
  timeZone: string,
  version: number,
  turn: number,
  responseTurn: ConversationTurnCoordinator,
): Promise<MeetingApproval> {
  const chatId = event.payload.chatId
  let etag: string | undefined
  let attendee = existingAttendees?.[0]
  if (!existingAttendees && (guestNames.length > 1 || suppliedAddresses.length > 1)) {
    const reply = await promptForReply(
      env,
      step,
      event,
      ++version,
      `calendar-invite-one-guest-${turn}`,
      "This meeting can have one guest. Reply with the one email address to invite.",
      INTERACTION_KIND.CALENDAR_INVITE_EMAIL,
      responseTurn,
    )
    if (!reply || !isCalendarAttendeeEmail(reply.trim())) {
      if (reply)
        await notify(
          env,
          step,
          chatId,
          "Please start a new request with one guest email.",
          `invite-one-guest-invalid-${turn}`,
        )
      return { kind: "ended", version }
    }
    attendee = { email: reply.trim() }
    responseTurn = createConversationTurn()
  }
  if (!attendee && suppliedAddresses[0]) attendee = { email: suppliedAddresses[0], name: guestNames[0] }
  if (!attendee) {
    const name = guestNames[0]?.trim()
    let message = "Reply with the email address to invite."
    if (name) {
      const search = await step.do(`calendar-invite-contacts-${turn}`, () =>
        createGoogleCalendarClient(env).searchContacts(name),
      )
      if (search.kind === "found") {
        const matches = search.attendees.slice(0, MAX_CONTACT_CHOICES)
        if (matches.length === 1) attendee = matches[0]
        else if (matches.length > 1) {
          const response = await calendarPromptForActions(
            env,
            step,
            event,
            ++version,
            `calendar-invite-choose-contact-${turn}`,
            `Which address should I invite?\n${matches.map((match, index) => `${index + 1}. ${attendeeLabel(match)}`).join("\n")}`,
            [
              ...matches.map((_, index): [string, WorkflowInteractionKind] => [
                String(index + 1),
                INTERACTION_KIND.CALENDAR_INVITE_CONTACT,
              ]),
              ["Enter email", INTERACTION_KIND.CALENDAR_INVITE_EMAIL],
              ["Cancel", INTERACTION_KIND.CALENDAR_INVITE_CANCEL],
            ],
            true,
            responseTurn,
            "clarification",
            true,
          )
          if (response.type === "timeout") return { kind: "ended", version }
          responseTurn = createConversationTurn()
          if (response.type === "action" && response.kind === INTERACTION_KIND.CALENDAR_INVITE_CANCEL) {
            await notify(env, step, chatId, CALENDAR_CANCELLED, `invite-contact-cancel-${turn}`, responseTurn)
            return { kind: "ended", version }
          }
          if (response.type === "action" && response.kind === INTERACTION_KIND.CALENDAR_INVITE_CONTACT)
            attendee = matches[response.actionIndex]
          if (response.type === "reply" && isCalendarAttendeeEmail(response.text.trim()))
            attendee = { email: response.text.trim() }
        } else message = `I couldn't find an email in saved Google Contacts for ${name}. ${message}`
      } else if (search.kind === "needs_consent") {
        message = `${message} To enable contact lookup for a new request, open ${calendarSetupUrl(env, event.payload.setupOrigin)}.`
      } else message = `Google Contacts is unavailable right now. ${message}`
    }
    if (!attendee) {
      const reply = await promptForReply(
        env,
        step,
        event,
        ++version,
        `calendar-invite-email-${turn}`,
        message,
        INTERACTION_KIND.CALENDAR_INVITE_EMAIL,
        responseTurn,
      )
      if (!reply || !isCalendarAttendeeEmail(reply.trim())) {
        if (reply)
          await notify(
            env,
            step,
            chatId,
            "Please start a new request with one valid email address.",
            `invite-email-invalid-${turn}`,
          )
        return { kind: "ended", version }
      }
      attendee = { email: reply.trim() }
      responseTurn = createConversationTurn()
    }
  }
  const attendees = [attendee]
  if (baseline?.kind === "one_off" && existingAttendees) {
    etag = await step.do(`calendar-invite-edit-baseline-${turn}`, async () => {
      const identity = await managedEventIdentity(chatId, event.payload.telegramMessageId)
      const current = await createGoogleCalendarClient(env).readMeeting(
        managedEvent(identity, baseline.proposal, baseline.scheduled, timeZone),
        attendees,
      )
      return current.etag ?? ""
    })
    if (!etag) throw new GoogleCalendarError("Meeting edit requires a current event version", "permanent")
  }
  const start = Date.parse(plan.scheduled.start)
  const end = Date.parse(plan.scheduled.end)
  const startDate = localDateAt(start, timeZone)
  const endDate = localDateAt(end, timeZone)
  const response = await calendarPromptForActions(
    env,
    step,
    event,
    ++version,
    `calendar-invite-approve-${turn}`,
    `${existingAttendees ? "Update" : "Book"} ${plan.proposal.title.trim()}?\n${startDate} ${localTimeAt(start, timeZone)}–${endDate === startDate ? "" : `${endDate} `}${localTimeAt(end, timeZone)} (${timeZone})\nGuest: ${attendeeLabel(attendee)}\nGoogle Meet`,
    [
      [existingAttendees ? "Send update" : "Create & send invite", INTERACTION_KIND.CALENDAR_INVITE_CONFIRM],
      ["Change", INTERACTION_KIND.CALENDAR_INVITE_CHANGE],
      ["Cancel", INTERACTION_KIND.CALENDAR_INVITE_CANCEL],
    ],
    true,
    responseTurn,
    "clarification",
    true,
  )
  if (response.type === "action" && response.kind === INTERACTION_KIND.CALENDAR_INVITE_CANCEL) {
    await notify(
      env,
      step,
      chatId,
      existingAttendees ? "Cancelled. The invitation stayed as it was." : CALENDAR_CANCELLED,
      `invite-cancel-${turn}`,
    )
    return { kind: "ended", version }
  }
  if (response.type === "action" && response.kind === INTERACTION_KIND.CALENDAR_INVITE_CHANGE) {
    let changeGuest = false
    if (!existingAttendees) {
      const choice = await calendarPromptForActions(
        env,
        step,
        event,
        ++version,
        `calendar-invite-change-choice-${turn}`,
        "What would you like to change?",
        [
          ["Time or title", INTERACTION_KIND.CALENDAR_INVITE_CHANGE],
          ["Guest", INTERACTION_KIND.CALENDAR_INVITE_CHANGE_GUEST],
          ["Cancel", INTERACTION_KIND.CALENDAR_INVITE_CANCEL],
        ],
        true,
        createConversationTurn(),
        "clarification",
        true,
      )
      if (choice.type !== "action") return { kind: "ended", version }
      if (choice.kind === INTERACTION_KIND.CALENDAR_INVITE_CANCEL) {
        await notify(env, step, chatId, CALENDAR_CANCELLED, `invite-change-cancel-${turn}`)
        return { kind: "ended", version }
      }
      changeGuest = choice.kind === INTERACTION_KIND.CALENDAR_INVITE_CHANGE_GUEST
    }
    const reply = await promptForReply(
      env,
      step,
      event,
      ++version,
      `calendar-invite-change-${turn}`,
      changeGuest ? "Reply with the new guest’s name or email address." : "Reply with the title or time you want.",
      INTERACTION_KIND.CALENDAR_INVITE_EMAIL,
    )
    return reply
      ? { kind: "changed", version, reply, attendees, ...(changeGuest ? { changeGuest: true } : {}) }
      : { kind: "ended", version }
  }
  if (response.type !== "action" || response.kind !== INTERACTION_KIND.CALENDAR_INVITE_CONFIRM)
    return { kind: "ended", version }
  return { kind: "approved", version, attendees, etag }
}

/** Writes the approved meeting once, then reads its current conference status without repeating the write. */
export async function writeMeeting(
  env: Env,
  step: WorkflowStep,
  event: WorkflowEvent<CalendarWorkflowParams>,
  plan: Extract<CalendarPlan, { kind: "one_off" }>,
  attendees: CalendarAttendee[],
  etag: string | undefined,
  timeZone: string,
  turn: number,
): Promise<MeetingConfirmation | null> {
  const identity = await managedEventIdentity(event.payload.chatId, event.payload.telegramMessageId)
  const body = managedEvent(identity, plan.proposal, plan.scheduled, timeZone)
  const calendar = createGoogleCalendarClient(env)
  const written = await step.do(`calendar-invite-write-${turn}`, async () => {
    try {
      if (etag) await calendar.updateMeeting(body, attendees, etag)
      else await calendar.createMeeting(body, attendees)
    } catch (error) {
      if (error instanceof MeetingGuestIsOrganizerError) return false
      throw error
    }
    return true
  })
  if (written === false) return null
  const read = (attempt: number) =>
    step.do(`calendar-invite-conference-${turn}-${attempt}`, async (): Promise<SavedMeeting | null> => {
      try {
        return await calendar.readMeeting(body, attendees)
      } catch (error) {
        if (isWorkflowInterruption(error)) throw error
        return null
      }
    })
  const saved = await read(0)
  if (saved && saved.conference !== "pending") return { kind: "verified", attendees, saved }
  await step.sleep(`calendar-invite-conference-wait-${turn}`, "3 seconds")
  const refreshed = await read(1)
  if (!refreshed) return { kind: "unverified" }
  return { kind: "verified", attendees, saved: { ...saved, ...refreshed } }
}
