import type { BusyInterval, ManagedCalendarEvent } from "./integrations/google-calendar"

export const CALENDAR_TIMEZONE_DEFAULT = "Asia/Kolkata"
export const CALENDAR_SLOT_MINUTES = 15
export const CALENDAR_SEARCH_START_MINUTES = 8 * 60 + 30
export const CALENDAR_SEARCH_END_MINUTES = 22 * 60 + 30
export const CALENDAR_PREFERRED_START_MINUTES = 19 * 60
export const CALENDAR_PREFERRED_END_MINUTES = 21 * 60 + 30
export const CALENDAR_MIN_LEAD_TIME_MS = 30 * 60 * 1000
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
const MAX_EVENT_TITLE_LENGTH = 120
const TIME_ZONE_RESOLUTION_ATTEMPTS = 2
const START_OF_DAY = "00:00"
const END_OF_DAY = "23:59"

/** Returns the minutes after midnight for a valid 24-hour time, or null when invalid. */
function localMinutes(time: string): number | null {
  const matched = TIME_PATTERN.exec(time)
  if (!matched) return null
  return Number(matched[1]) * 60 + Number(time.slice(3))
}

/** Formats an instant in the supplied IANA time zone as named calendar parts. */
function dateTimeParts(timestamp: number, timeZone: string): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(timestamp))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  )
}

/** Returns an instant's YYYY-MM-DD calendar date in the supplied IANA time zone. */
function localDateAt(timestamp: number, timeZone: string): string {
  const parts = dateTimeParts(timestamp, timeZone)
  return `${parts.year}-${parts.month}-${parts.day}`
}

/** Returns an instant's HH:mm wall-clock time in the supplied IANA time zone. */
function localTimeAt(timestamp: number, timeZone: string): string {
  const parts = dateTimeParts(timestamp, timeZone)
  return `${parts.hour}:${parts.minute}`
}

/** Converts a local wall-clock date/time in an IANA time zone to epoch milliseconds, or null when invalid. */
export function zonedDateTimeToMillis(localDate: string, time: string, timeZone: string): number | null {
  if (!DATE_PATTERN.test(localDate) || !TIME_PATTERN.test(time)) return null
  const provisional = Date.parse(`${localDate}T${time}:00Z`)
  if (!Number.isFinite(provisional)) return null
  let candidate = provisional
  for (let attempt = 0; attempt < TIME_ZONE_RESOLUTION_ATTEMPTS; attempt++) {
    const parts = dateTimeParts(candidate, timeZone)
    const asUtc = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`)
    candidate = provisional - (asUtc - candidate)
  }
  return localDateAt(candidate, timeZone) === localDate && localTimeAt(candidate, timeZone) === time ? candidate : null
}

/** Returns whether a candidate interval overlaps a busy interval, including the requested buffer. */
function isBusy(start: number, end: number, intervals: BusyInterval[], bufferMinutes: number): boolean {
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
function candidateMinutes(preferredStart: number | null): number[] {
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
  const start = zonedDateTimeToMillis(localDate, START_OF_DAY, timeZone)
  const end = zonedDateTimeToMillis(localDate, END_OF_DAY, timeZone)
  if (start === null || end === null) return null
  return { timeMin: new Date(start).toISOString(), timeMax: new Date(end + 60_000).toISOString() }
}

/** Returns an explicit reminder override or the policy default for the proposal's classification. */
export function reminderMinutes(proposal: OneOffProposal): number {
  if (proposal.reminderMinutes !== undefined) return proposal.reminderMinutes
  return proposal.classification === "ordinary"
    ? CALENDAR_ORDINARY_REMINDER_MINUTES
    : CALENDAR_IMPORTANT_REMINDER_MINUTES
}

/** Validates a proposal against non-negotiable calendar safety policy; null means valid. */
export function validateProposal(proposal: OneOffProposal): string | null {
  if (proposal.needsClarification || !proposal.localDate || !DATE_PATTERN.test(proposal.localDate))
    return "Please tell me the date."
  if (!proposal.title.trim() || proposal.title.length > MAX_EVENT_TITLE_LENGTH)
    return "I need a short title for this calendar block."
  if (
    !Number.isInteger(proposal.durationMinutes) ||
    proposal.durationMinutes < CALENDAR_SLOT_MINUTES ||
    proposal.durationMinutes > CALENDAR_MAX_DURATION_MINUTES
  )
    return "Please give me a duration between 15 minutes and 4 hours."
  if (proposal.durationMinutes % CALENDAR_SLOT_MINUTES !== 0) return "Please use a duration in 15-minute increments."
  if (proposal.timeIsExplicit && (!proposal.startTime || localMinutes(proposal.startTime) === null))
    return "Please tell me the time."
  if (!proposal.timeIsExplicit && proposal.durationMinutes > CALENDAR_MAX_INFERRED_DURATION_MINUTES)
    return "Please tell me what time works for this longer block."
  if (!proposal.timeIsExplicit && proposal.classification === "family-social")
    return "Please tell me what time works for this family or social plan."
  return null
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
    bits += 8
    while (bits >= 5) {
      encoded += BASE32HEX_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits) encoded += BASE32HEX_ALPHABET[(value << (5 - bits)) & 31]
  return { id: `${EVENT_ID_PREFIX}${encoded.slice(0, 40)}`, requestId: `kipp-v1-${encoded.slice(0, 32)}` }
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
