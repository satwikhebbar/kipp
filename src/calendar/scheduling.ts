import {
  isValidLocalDate,
  isValidTimeZone,
  localDateAt,
  localDayBounds,
  localTimeAt,
  resolveLocalDateTime,
} from "../core/time"
import type { BusyInterval, ManagedCalendarEvent } from "../integrations/google-calendar"
import { type CalendarValidationIssue, legacyCalendarIssueMessage, localDateTimeIssue } from "./validation"

export const CALENDAR_TIMEZONE_DEFAULT = "Asia/Kolkata"
export const CALENDAR_SLOT_MINUTES = 15
export const CALENDAR_SEARCH_START_MINUTES = 510 // ponytail: 8:30 AM
export const CALENDAR_SEARCH_END_MINUTES = 1_350 // ponytail: 10:30 PM
export const CALENDAR_PREFERRED_START_MINUTES = 1_140 // ponytail: 7:00 PM
export const CALENDAR_PREFERRED_END_MINUTES = 1_290 // ponytail: 9:30 PM
export const CALENDAR_MIN_LEAD_TIME_MS = 1_800_000 // ponytail: 30 minutes
export const CALENDAR_INFERRED_BUFFER_MINUTES = 15
export const CALENDAR_ORDINARY_REMINDER_MINUTES = 10
export const CALENDAR_IMPORTANT_REMINDER_MINUTES = 60
export const CALENDAR_MAX_INFERRED_DURATION_MINUTES = 30
export const CALENDAR_MAX_DURATION_MINUTES = 240

export type CalendarReminderClass = "ordinary" | "important"

export interface OneOffProposal {
  title: string
  localDate?: string
  startTime?: string
  durationMinutes: number
  dateIsExplicit: boolean
  timeIsExplicit: boolean
  classification: "ordinary" | "family-social" | "school-pickup" | "appointment" | "maintenance" | "physical"
  description?: string
  location?: string
  reminderMinutes?: number
  needsClarification: boolean
}

export interface ScheduledOneOff {
  start: string
  end: string
  reminderMinutes: number
  localStartTime: string
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/
const MILLIS_PER_MINUTE = 60_000
const EVENT_ID_PREFIX = "kipp"
const BASE32HEX_ALPHABET = "0123456789abcdefghijklmnopqrstuv"
const BITS_PER_BYTE = 8
const BASE32_CHUNK_BITS = 5
const BASE32_CHUNK_MASK = 31
const EVENT_ID_ENCODED_SUFFIX_LENGTH = 40
const REQUEST_ID_ENCODED_SUFFIX_LENGTH = 32
const MAX_EVENT_TITLE_LENGTH = 120
const HHMM_COLON_OFFSET = 3

/** Returns the minutes after midnight for a valid 24-hour time, or null when invalid. */
export function localMinutes(time: string): number | null {
  const matched = TIME_PATTERN.exec(time)
  if (!matched) return null
  return Number(matched[1]) * 60 + Number(time.slice(HHMM_COLON_OFFSET))
}

export { localDateAt, localTimeAt } from "../core/time"

/** Compatibility adapter: only a unique valid local time can authorize scheduling. */
export function zonedDateTimeToMillis(localDate: string, time: string, timeZone: string): number | null {
  const result = resolveLocalDateTime(localDate, time, timeZone)
  return result.kind === "unique" ? result.epochMs : null
}

/** Returns whether a candidate interval overlaps a busy interval, including the requested buffer. */
export function isBusy(start: number, end: number, intervals: BusyInterval[], bufferMinutes: number): boolean {
  const buffer = bufferMinutes * MILLIS_PER_MINUTE
  return intervals.some((interval) => {
    const busyStart = Date.parse(interval.start)
    const busyEnd = Date.parse(interval.end)
    return (
      Number.isFinite(busyStart) && Number.isFinite(busyEnd) && start - buffer < busyEnd && end + buffer > busyStart
    )
  })
}

/** Returns permitted start minutes ordered by preferred window and then requested-time proximity. */
export function candidateMinutes(preferredStart: number | null): number[] {
  const all: number[] = []
  for (
    let minute = CALENDAR_SEARCH_START_MINUTES;
    minute < CALENDAR_SEARCH_END_MINUTES;
    minute += CALENDAR_SLOT_MINUTES
  )
    all.push(minute)
  return all.sort((left, right) => {
    const leftPreferred = left >= CALENDAR_PREFERRED_START_MINUTES && left < CALENDAR_PREFERRED_END_MINUTES
    const rightPreferred = right >= CALENDAR_PREFERRED_START_MINUTES && right < CALENDAR_PREFERRED_END_MINUTES
    if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1
    const anchor = preferredStart ?? CALENDAR_PREFERRED_START_MINUTES
    return Math.abs(left - anchor) - Math.abs(right - anchor)
  })
}

/** Returns ISO instants spanning one local calendar day, or null when the supplied date is invalid. */
export function calendarDayBounds(localDate: string, timeZone: string): { timeMin: string; timeMax: string } | null {
  return localDayBounds(localDate, timeZone)
}

/** Returns an explicit reminder override or the policy default for the proposal's classification. */
export function reminderMinutes(proposal: OneOffProposal): number {
  if (proposal.reminderMinutes !== undefined) return proposal.reminderMinutes
  return proposal.classification === "ordinary"
    ? CALENDAR_ORDINARY_REMINDER_MINUTES
    : CALENDAR_IMPORTANT_REMINDER_MINUTES
}

/** Returns every independently discoverable one-off policy violation as typed, value-free facts. */
export function validateProposalIssues(proposal: OneOffProposal): CalendarValidationIssue[] {
  const issues: CalendarValidationIssue[] = []
  if (proposal.needsClarification) issues.push({ code: "unsupported_configuration", field: "recurrence" })
  if (!proposal.localDate || !DATE_PATTERN.test(proposal.localDate))
    issues.push({ code: "missing_date", field: "localDate" })
  if (!proposal.title.trim() || proposal.title.length > MAX_EVENT_TITLE_LENGTH)
    issues.push({ code: "invalid_title", field: "title", params: { maxCharacters: MAX_EVENT_TITLE_LENGTH } })
  if (
    !Number.isInteger(proposal.durationMinutes) ||
    proposal.durationMinutes < CALENDAR_SLOT_MINUTES ||
    proposal.durationMinutes > CALENDAR_MAX_DURATION_MINUTES
  )
    issues.push({
      code: "invalid_duration_range",
      field: "durationMinutes",
      params: { minimum: CALENDAR_SLOT_MINUTES, maximum: CALENDAR_MAX_DURATION_MINUTES },
    })
  else if (proposal.durationMinutes % CALENDAR_SLOT_MINUTES !== 0)
    issues.push({
      code: "invalid_duration_increment",
      field: "durationMinutes",
      params: { increment: CALENDAR_SLOT_MINUTES },
    })
  if (proposal.timeIsExplicit && (!proposal.startTime || localMinutes(proposal.startTime) === null))
    issues.push({ code: "missing_or_invalid_time", field: "startTime" })
  if (!proposal.timeIsExplicit && proposal.durationMinutes > CALENDAR_MAX_INFERRED_DURATION_MINUTES)
    issues.push({
      code: "inferred_duration_requires_time",
      field: "startTime",
      params: { maximumInferredDuration: CALENDAR_MAX_INFERRED_DURATION_MINUTES },
    })
  if (!proposal.timeIsExplicit && proposal.classification === "family-social")
    issues.push({ code: "family_social_requires_time", field: "startTime" })
  return issues
}

/** Legacy first-issue adapter retained until Calendar dialogue is fully agent-rendered. */
export function validateProposal(proposal: OneOffProposal): string | null {
  const issue = validateProposalIssues(proposal)[0]
  return issue ? legacyCalendarIssueMessage(issue) : null
}

/** Validates zone, civil date and explicit wall time before availability reads or instant formatting. */
export function validateProposalTimeIssues(proposal: OneOffProposal, timeZone: string): CalendarValidationIssue[] {
  if (!isValidTimeZone(timeZone)) return [{ code: "invalid_time_zone", field: "timeZone" }]
  const localDate = proposal.localDate ?? ""
  if (!isValidLocalDate(localDate)) return [{ code: "invalid_local_date", field: "localDate" }]
  if (proposal.timeIsExplicit) {
    const issue = localDateTimeIssue(localDate, proposal.startTime ?? "", timeZone)
    return issue ? [issue] : []
  }
  if (!localDayBounds(localDate, timeZone))
    return [{ code: "nonexistent_local_time", field: "localDate", params: { localDate, timeZone } }]
  return []
}

/** Finds a safe deterministic interval or reports the required clarification or a conflict. */
export function scheduleOneOff(
  proposal: OneOffProposal,
  busy: BusyInterval[],
  timeZone: string,
  now = Date.now(),
): ScheduledOneOff | { clarification: string } | { conflict: true } {
  const validation = validateProposal(proposal)
  if (validation) return { clarification: validation }
  const timeIssue = validateProposalTimeIssues(proposal, timeZone)[0]
  if (timeIssue) return { clarification: legacyCalendarIssueMessage(timeIssue) }
  const localDate = proposal.localDate as string
  const explicitMinutes = proposal.startTime ? localMinutes(proposal.startTime) : null
  const durationMs = proposal.durationMinutes * MILLIS_PER_MINUTE
  const requestedStart =
    explicitMinutes === null ? null : zonedDateTimeToMillis(localDate, proposal.startTime as string, timeZone)
  if (proposal.timeIsExplicit && requestedStart === null) return { clarification: "Please tell me a valid local time." }
  const minStart = localDate === localDateAt(now, timeZone) ? now + CALENDAR_MIN_LEAD_TIME_MS : Number.NEGATIVE_INFINITY
  const makeScheduled = (start: number): ScheduledOneOff => ({
    start: new Date(start).toISOString(),
    end: new Date(start + durationMs).toISOString(),
    reminderMinutes: reminderMinutes(proposal),
    localStartTime: localTimeAt(start, timeZone),
  })
  if (proposal.timeIsExplicit) {
    const start = requestedStart as number
    if (start < minStart || isBusy(start, start + durationMs, busy, 0)) return { conflict: true }
    return makeScheduled(start)
  }
  for (const minute of candidateMinutes(explicitMinutes)) {
    const time = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`
    const start = zonedDateTimeToMillis(localDate, time, timeZone)
    if (start === null || start < minStart) continue
    if (minute + proposal.durationMinutes > CALENDAR_SEARCH_END_MINUTES) continue
    if (!isBusy(start, start + durationMs, busy, CALENDAR_INFERRED_BUFFER_MINUTES)) return makeScheduled(start)
  }
  return { conflict: true }
}

/** Finds the nearest safe same-day alternative for an explicit-time conflict without changing the event duration. */
export function suggestOneOffAlternative(
  proposal: OneOffProposal,
  busy: BusyInterval[],
  timeZone: string,
  now = Date.now(),
): ScheduledOneOff | null {
  if (!proposal.localDate || !proposal.startTime || !proposal.timeIsExplicit) return null
  if (validateProposalTimeIssues(proposal, timeZone).length) return null
  const requested = localMinutes(proposal.startTime)
  if (requested === null) return null
  const inferred = { ...proposal, timeIsExplicit: false }
  const durationMs = proposal.durationMinutes * MILLIS_PER_MINUTE
  const minStart =
    proposal.localDate === localDateAt(now, timeZone) ? now + CALENDAR_MIN_LEAD_TIME_MS : Number.NEGATIVE_INFINITY
  for (const minute of candidateMinutes(requested).sort(
    (left, right) => Math.abs(left - requested) - Math.abs(right - requested),
  )) {
    if (minute + proposal.durationMinutes > CALENDAR_SEARCH_END_MINUTES) continue
    const time = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`
    const start = zonedDateTimeToMillis(proposal.localDate, time, timeZone)
    if (start === null || start < minStart || isBusy(start, start + durationMs, busy, CALENDAR_INFERRED_BUFFER_MINUTES))
      continue
    return {
      start: new Date(start).toISOString(),
      end: new Date(start + durationMs).toISOString(),
      reminderMinutes: reminderMinutes(inferred),
      localStartTime: localTimeAt(start, timeZone),
    }
  }
  return null
}

/** Derives stable Google-safe event and opaque request IDs from a Telegram chat/message pair. */
export async function managedEventIdentity(
  chatId: string,
  messageId: number,
): Promise<{ id: string; requestId: string }> {
  const source = new TextEncoder().encode(`kipp-calendar-v1:${chatId}:${messageId}`)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", source))
  let encoded = ""
  let bits = 0
  let value = 0
  for (const byte of digest) {
    value = (value << 8) | byte
    bits += BITS_PER_BYTE
    while (bits >= BASE32_CHUNK_BITS) {
      encoded += BASE32HEX_ALPHABET[(value >>> (bits - BASE32_CHUNK_BITS)) & BASE32_CHUNK_MASK]
      bits -= BASE32_CHUNK_BITS
    }
  }
  if (bits) encoded += BASE32HEX_ALPHABET[(value << (BASE32_CHUNK_BITS - bits)) & BASE32_CHUNK_MASK]
  return {
    id: `${EVENT_ID_PREFIX}${encoded.slice(0, EVENT_ID_ENCODED_SUFFIX_LENGTH)}`,
    requestId: `kipp-v1-${encoded.slice(0, REQUEST_ID_ENCODED_SUFFIX_LENGTH)}`,
  }
}

/** Projects a validated proposal and interval into Kipp's private Google Calendar event payload. */
export function managedEvent(
  identity: { id: string; requestId: string },
  proposal: OneOffProposal,
  scheduled: ScheduledOneOff,
  timeZone: string,
): ManagedCalendarEvent {
  return {
    ...identity,
    summary: proposal.title.trim(),
    start: scheduled.start,
    end: scheduled.end,
    timeZone,
    ...(proposal.description?.trim() ? { description: proposal.description.trim() } : {}),
    ...(proposal.location?.trim() ? { location: proposal.location.trim() } : {}),
    reminderMinutes: scheduled.reminderMinutes,
  }
}
