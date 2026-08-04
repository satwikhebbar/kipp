import { type Options, RRule, type Weekday } from "rrule"
import type { BusyInterval, ManagedCalendarEvent } from "../integrations/google-calendar"
import {
  CALENDAR_IMPORTANT_REMINDER_MINUTES,
  CALENDAR_INFERRED_BUFFER_MINUTES,
  CALENDAR_MAX_DURATION_MINUTES,
  CALENDAR_MAX_INFERRED_DURATION_MINUTES,
  CALENDAR_MIN_LEAD_TIME_MS,
  CALENDAR_ORDINARY_REMINDER_MINUTES,
  CALENDAR_SEARCH_END_MINUTES,
  CALENDAR_SLOT_MINUTES,
  type CalendarReminderClass,
  candidateMinutes,
  isBusy,
  localDateAt,
  localMinutes,
  zonedDateTimeToMillis,
} from "./scheduling"
import { type CalendarValidationIssue, legacyCalendarIssueMessage } from "./validation"

export const RECURRENCE_MAX_MONTHS = 6
const MILLIS_PER_MINUTE = 60_000
const MAX_EVENT_TITLE_LENGTH = 120
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MONTHS_PER_YEAR = 12
const CLAMP_DAY_THRESHOLD = 29
const MILLIS_PER_DAY = 86_400_000
const COUNT_GENERATION_MARGIN = 2
const PER_DATE_CONFLICT_RATIO = 0.5
const DAYS_PER_WEEK = 7

export type RecurrenceCadence = "daily" | "weekly" | "biweekly" | "monthly" | "bimonthly"
export type RecurrenceWeekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU"

export type MonthlyRecurrenceAnchor =
  | { mode: "day_of_month" }
  | { mode: "ordinal_weekday"; weekday: RecurrenceWeekday }
  | { mode: "last_weekday"; weekday: RecurrenceWeekday }

export type RecurrenceRule =
  | { cadence: "daily" }
  | { cadence: "biweekly" }
  | {
      cadence: "weekly"
      weekdays: { mode: "named"; values: RecurrenceWeekday[] } | { mode: "first_date_weekday" }
    }
  | { cadence: "monthly" | "bimonthly"; anchor: MonthlyRecurrenceAnchor }

export type RecurrenceEnd =
  | { mode: "default_horizon" }
  | { mode: "until"; inclusiveDate: string }
  | { mode: "count"; occurrences: number }

export interface RecurringProposal {
  title: string
  firstDate: string
  dateIsExplicit: boolean
  startTime?: string
  timeIsExplicit: boolean
  durationMinutes: number
  classification: CalendarReminderClass | "family-social" | "school-pickup" | "appointment" | "maintenance" | "physical"
  recurrence: RecurrenceRule
  recurrenceIsExplicit: boolean
  end: RecurrenceEnd
  description?: string
  location?: string
  reminderMinutes?: number
}

export interface ExpandedRecurrence {
  dates: string[]
  rrule: string
  humanCadence: string
}

export interface RecurringOccurrence {
  localDate: string
  localStartTime: string
  start: string
  end: string
}

export interface RecurrenceAdjustment {
  localDate: string
  requestedStartTime: string
  scheduled: RecurringOccurrence
}

export type RecurrenceAvailability =
  | {
      kind: "available"
      occurrences: RecurringOccurrence[]
      rrule: string
      humanCadence: string
      reminderMinutes: number
    }
  | {
      kind: "adjustments"
      occurrences: RecurringOccurrence[]
      adjustments: RecurrenceAdjustment[]
      rrule: string
      humanCadence: string
      reminderMinutes: number
    }
  | {
      kind: "common-alternative"
      localStartTime: string
      occurrences: RecurringOccurrence[]
      rrule: string
      humanCadence: string
      reminderMinutes: number
    }
  | { kind: "conflict" }
  | { kind: "clarification"; message: string }

/** Creates a UTC-valued Date used only as a local civil-date container by rrule. */
function civilDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day))
}

/** Parses and validates one ISO civil date without applying a host timezone. */
function dateParts(value: string): { year: number; month: number; day: number } | null {
  if (!DATE_PATTERN.test(value)) return null
  const [year, month, day] = value.split("-").map(Number)
  const date = civilDate(year, month, day)
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
    ? { year, month, day }
    : null
}

/** Formats an rrule civil-date container as YYYY-MM-DD. */
function formatCivil(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Returns the inclusive hard v1 recurrence boundary using civil calendar arithmetic. */
export function recurrenceHorizon(firstDate: string): string | null {
  const parts = dateParts(firstDate)
  if (!parts) return null
  const monthIndex = parts.month - 1 + RECURRENCE_MAX_MONTHS
  const targetYear = parts.year + Math.floor(monthIndex / MONTHS_PER_YEAR)
  const targetMonth = monthIndex % MONTHS_PER_YEAR
  const finalDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
  return formatCivil(new Date(Date.UTC(targetYear, targetMonth, Math.min(parts.day, finalDay))))
}

/** Returns the RFC weekday token for a validated civil date. */
function weekdayFor(firstDate: string): RecurrenceWeekday {
  const parts = dateParts(firstDate)
  if (!parts) throw new Error("Invalid recurrence first date")
  const weekday = civilDate(parts.year, parts.month, parts.day).getUTCDay()
  return (["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const)[weekday]
}

const RRULE_WEEKDAYS: Record<RecurrenceWeekday, Weekday> = {
  MO: RRule.MO,
  TU: RRule.TU,
  WE: RRule.WE,
  TH: RRule.TH,
  FR: RRule.FR,
  SA: RRule.SA,
  SU: RRule.SU,
}

/** Maps the approved recurrence domain to typed rrule options. */
function recurrenceOptions(proposal: RecurringProposal, count: number, start: Date): Partial<Options> {
  const recurrence = proposal.recurrence
  if (recurrence.cadence === "daily") return { freq: RRule.DAILY, dtstart: start, count }
  if (recurrence.cadence === "weekly") {
    const values = recurrence.weekdays.mode === "named" ? recurrence.weekdays.values : [weekdayFor(proposal.firstDate)]
    return { freq: RRule.WEEKLY, dtstart: start, byweekday: values.map((day) => RRULE_WEEKDAYS[day]), count }
  }
  if (recurrence.cadence === "biweekly") return { freq: RRule.WEEKLY, interval: 2, dtstart: start, count }
  const anchorDay = start.getUTCDate()
  const monthly: Partial<Options> = {
    freq: RRule.MONTHLY,
    interval: recurrence.cadence === "bimonthly" ? 2 : 1,
    dtstart: start,
    count,
  }
  if (recurrence.anchor.mode !== "day_of_month") {
    const position = recurrence.anchor.mode === "last_weekday" ? -1 : Math.ceil(anchorDay / DAYS_PER_WEEK)
    monthly.byweekday = RRULE_WEEKDAYS[recurrence.anchor.weekday].nth(position)
    return monthly
  }
  if (anchorDay >= CLAMP_DAY_THRESHOLD) {
    monthly.bymonthday = [anchorDay, -1]
    monthly.bysetpos = 1
  } else {
    monthly.bymonthday = anchorDay
  }
  return monthly
}

/** Returns a finite expansion count sufficient to cover the selected bounded end. */
function recurrenceCountLimit(proposal: RecurringProposal, hardEnd: string): number {
  if (proposal.end.mode === "count") return proposal.end.occurrences
  // More than the possible daily maximum is sufficient because the rule is
  // also truncated against the inclusive civil-date boundary below.
  const start = Date.parse(`${proposal.firstDate}T00:00:00Z`)
  const end = Date.parse(`${hardEnd}T00:00:00Z`)
  return Math.floor((end - start) / MILLIS_PER_DAY) + COUNT_GENERATION_MARGIN
}

type RecurrenceExpansionResult = ExpandedRecurrence | { issue: CalendarValidationIssue }

/** Expands an approved recurrence into bounded local civil dates and a Google RRULE. */
function expandRecurrenceResult(proposal: RecurringProposal): RecurrenceExpansionResult {
  const first = dateParts(proposal.firstDate)
  const horizon = recurrenceHorizon(proposal.firstDate)
  if (!first || !horizon) return { issue: { code: "invalid_first_date", field: "firstDate" } }
  let inclusiveEnd = horizon
  if (proposal.end.mode === "until") {
    if (!dateParts(proposal.end.inclusiveDate)) return { issue: { code: "invalid_end_date", field: "end" } }
    if (proposal.end.inclusiveDate < proposal.firstDate) return { issue: { code: "end_before_first", field: "end" } }
    if (proposal.end.inclusiveDate > horizon)
      return { issue: { code: "horizon_exceeded", field: "end", params: { maximumMonths: RECURRENCE_MAX_MONTHS } } }
    inclusiveEnd = proposal.end.inclusiveDate
  }
  if (proposal.end.mode === "count" && (!Number.isInteger(proposal.end.occurrences) || proposal.end.occurrences < 1))
    return { issue: { code: "invalid_occurrence_count", field: "end" } }
  if (proposal.recurrence.cadence === "weekly" && proposal.recurrence.weekdays.mode === "named") {
    const unique = [...new Set(proposal.recurrence.weekdays.values)]
    if (!unique.length) return { issue: { code: "missing_weekday", field: "recurrence.weekdays" } }
    if (!unique.includes(weekdayFor(proposal.firstDate)))
      return { issue: { code: "first_date_weekday_mismatch", field: "firstDate" } }
  }
  if (proposal.recurrence.cadence === "monthly" || proposal.recurrence.cadence === "bimonthly") {
    const anchor = proposal.recurrence.anchor
    if (anchor.mode !== "day_of_month" && anchor.weekday !== weekdayFor(proposal.firstDate))
      return { issue: { code: "first_date_weekday_mismatch", field: "firstDate" } }
    if (anchor.mode === "last_weekday") {
      const nextWeek = civilDate(first.year, first.month, first.day + DAYS_PER_WEEK)
      if (nextWeek.getUTCMonth() === first.month - 1)
        return { issue: { code: "first_date_weekday_mismatch", field: "firstDate" } }
    }
  }
  const start = civilDate(first.year, first.month, first.day)
  const countLimit = recurrenceCountLimit(proposal, horizon)
  const options = recurrenceOptions(proposal, countLimit, start)
  const generated = new RRule(options).all().map(formatCivil)
  const dates = proposal.end.mode === "count" ? generated : generated.filter((date) => date <= inclusiveEnd)
  if (proposal.end.mode === "count") {
    if (dates.length !== proposal.end.occurrences || dates.some((date) => date > horizon))
      return {
        issue: {
          code: "occurrence_count_exceeds_horizon",
          field: "end",
          params: { maximumMonths: RECURRENCE_MAX_MONTHS },
        },
      }
  }
  if (!dates.length || dates[0] !== proposal.firstDate)
    return { issue: { code: "first_date_weekday_mismatch", field: "firstDate" } }
  const rrule = new RRule(recurrenceOptions(proposal, dates.length, start))
    .toString()
    .replace(/^DTSTART:[^\n]+\nRRULE:/, "RRULE:")
  return { dates, rrule, humanCadence: humanCadence(proposal.recurrence, proposal.firstDate) }
}

/** Compatibility expansion contract retained while the workflow migrates to typed evaluation outcomes. */
export function expandRecurrence(proposal: RecurringProposal): ExpandedRecurrence | { clarification: string } {
  const result = expandRecurrenceResult(proposal)
  return "issue" in result ? { clarification: legacyCalendarIssueMessage(result.issue) } : result
}

/** Produces a compact user-facing cadence description without parsing RRULE text. */
function humanCadence(rule: RecurrenceRule, firstDate: string): string {
  if (rule.cadence === "daily") return "daily"
  if (rule.cadence === "biweekly") return "every two weeks"
  if (rule.cadence === "monthly" || rule.cadence === "bimonthly") {
    const prefix = rule.cadence === "monthly" ? "monthly" : "every two months"
    const parts = dateParts(firstDate)
    if (!parts || rule.anchor.mode === "day_of_month") return `${prefix} on day ${parts?.day ?? "?"}`
    const weekday = weekdayName(rule.anchor.weekday)
    if (rule.anchor.mode === "last_weekday") return `${prefix} on the last ${weekday}`
    return `${prefix} on the ${ordinalName(Math.ceil(parts.day / DAYS_PER_WEEK))} ${weekday}`
  }
  if (rule.cadence !== "weekly") throw new Error("Unsupported recurrence cadence")
  const weekdays = rule.weekdays.mode === "named" ? rule.weekdays.values.join(", ") : "the first occurrence's weekday"
  return `weekly on ${weekdays}`
}

/** Returns the user-facing weekday name for one RFC weekday token. */
function weekdayName(weekday: RecurrenceWeekday): string {
  return {
    MO: "Monday",
    TU: "Tuesday",
    WE: "Wednesday",
    TH: "Thursday",
    FR: "Friday",
    SA: "Saturday",
    SU: "Sunday",
  }[weekday]
}

/** Returns the user-facing ordinal name for a monthly weekday position. */
function ordinalName(position: number): string {
  return ["first", "second", "third", "fourth", "fifth"][position - 1] ?? `${position}th`
}

/** Returns every independently discoverable recurring-event policy violation as typed facts. */
export function validateRecurringProposalIssues(proposal: RecurringProposal): CalendarValidationIssue[] {
  const issues: CalendarValidationIssue[] = []
  if (!proposal.dateIsExplicit) issues.push({ code: "missing_date", field: "firstDate" })
  if (!proposal.recurrenceIsExplicit) issues.push({ code: "unsupported_recurrence", field: "recurrence" })
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
  if (proposal.dateIsExplicit && proposal.recurrenceIsExplicit) {
    const expanded = expandRecurrenceResult(proposal)
    if ("issue" in expanded) issues.push(expanded.issue)
  }
  return issues
}

/** Legacy first-issue adapter retained until Calendar dialogue is fully agent-rendered. */
export function validateRecurringProposal(proposal: RecurringProposal): string | null {
  const issue = validateRecurringProposalIssues(proposal)[0]
  return issue ? legacyCalendarIssueMessage(issue) : null
}

/** Converts one civil date and local time into a same-day zoned occurrence. */
function occurrenceAt(
  localDate: string,
  localStartTime: string,
  durationMinutes: number,
  timeZone: string,
): RecurringOccurrence | null {
  const start = zonedDateTimeToMillis(localDate, localStartTime, timeZone)
  if (start === null) return null
  const end = start + durationMinutes * MILLIS_PER_MINUTE
  if (localDateAt(end - 1, timeZone) !== localDate) return null
  return {
    localDate,
    localStartTime,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  }
}

/** Converts every expanded civil date at one common local clock time. */
function allAtTime(
  dates: string[],
  localStartTime: string,
  durationMinutes: number,
  timeZone: string,
): RecurringOccurrence[] | null {
  const occurrences = dates.map((date) => occurrenceAt(date, localStartTime, durationMinutes, timeZone))
  return occurrences.every(Boolean) ? (occurrences as RecurringOccurrence[]) : null
}

/** Applies lead-time, overlap, and buffer policy to one occurrence. */
function occurrenceConflicts(
  occurrence: RecurringOccurrence,
  busy: BusyInterval[],
  bufferMinutes: number,
  now: number,
  timeZone: string,
): boolean {
  const start = Date.parse(occurrence.start)
  const end = Date.parse(occurrence.end)
  const minStart =
    occurrence.localDate === localDateAt(now, timeZone) ? now + CALENDAR_MIN_LEAD_TIME_MS : Number.NEGATIVE_INFINITY
  return start < minStart || isBusy(start, end, busy, bufferMinutes)
}

/** Returns the explicit recurring reminder or its deterministic class default. */
function reminderMinutes(proposal: RecurringProposal): number {
  if (proposal.reminderMinutes !== undefined) return proposal.reminderMinutes
  return proposal.classification === "ordinary"
    ? CALENDAR_ORDINARY_REMINDER_MINUTES
    : CALENDAR_IMPORTANT_REMINDER_MINUTES
}

/** Evaluates every bounded occurrence and returns one deterministic conflict-policy outcome. */
export function evaluateRecurrenceAvailability(
  proposal: RecurringProposal,
  busy: BusyInterval[],
  timeZone: string,
  now = Date.now(),
): RecurrenceAvailability {
  const validation = validateRecurringProposal(proposal)
  if (validation) return { kind: "clarification", message: validation }
  const expanded = expandRecurrence(proposal)
  if ("clarification" in expanded) return { kind: "clarification", message: expanded.clarification }
  const preferred = proposal.startTime ? localMinutes(proposal.startTime) : null
  const timeCandidates = proposal.timeIsExplicit ? [preferred as number] : candidateMinutes(preferred)
  const timeAt = (minute: number) =>
    `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`
  if (!proposal.timeIsExplicit) {
    for (const minute of timeCandidates) {
      if (minute + proposal.durationMinutes > CALENDAR_SEARCH_END_MINUTES) continue
      const occurrences = allAtTime(expanded.dates, timeAt(minute), proposal.durationMinutes, timeZone)
      if (
        occurrences?.every(
          (occurrence) => !occurrenceConflicts(occurrence, busy, CALENDAR_INFERRED_BUFFER_MINUTES, now, timeZone),
        )
      )
        return {
          kind: "available",
          occurrences,
          rrule: expanded.rrule,
          humanCadence: expanded.humanCadence,
          reminderMinutes: reminderMinutes(proposal),
        }
    }
    return { kind: "conflict" }
  }
  const requested = allAtTime(expanded.dates, proposal.startTime as string, proposal.durationMinutes, timeZone)
  if (!requested) return { kind: "clarification", message: "Please choose a time that finishes on the same day." }
  const conflicts = requested.filter((occurrence) => occurrenceConflicts(occurrence, busy, 0, now, timeZone))
  const base = {
    rrule: expanded.rrule,
    humanCadence: expanded.humanCadence,
    reminderMinutes: reminderMinutes(proposal),
  }
  if (!conflicts.length) return { kind: "available", occurrences: requested, ...base }
  if (conflicts.length / requested.length < PER_DATE_CONFLICT_RATIO) {
    const adjustments: RecurrenceAdjustment[] = []
    for (const conflict of conflicts) {
      let replacement: RecurringOccurrence | null = null
      for (const minute of candidateMinutes(preferred).sort(
        (left, right) => Math.abs(left - (preferred as number)) - Math.abs(right - (preferred as number)),
      )) {
        if (minute + proposal.durationMinutes > CALENDAR_SEARCH_END_MINUTES) continue
        const candidate = occurrenceAt(conflict.localDate, timeAt(minute), proposal.durationMinutes, timeZone)
        if (candidate && !occurrenceConflicts(candidate, busy, CALENDAR_INFERRED_BUFFER_MINUTES, now, timeZone)) {
          replacement = candidate
          break
        }
      }
      if (!replacement) return commonAlternative(proposal, expanded, busy, timeZone, now, preferred)
      adjustments.push({
        localDate: conflict.localDate,
        requestedStartTime: proposal.startTime as string,
        scheduled: replacement,
      })
    }
    return { kind: "adjustments", occurrences: requested, adjustments, ...base }
  }
  return commonAlternative(proposal, expanded, busy, timeZone, now, preferred)
}

/** Finds the nearest one clock time that is safe for the complete series. */
function commonAlternative(
  proposal: RecurringProposal,
  expanded: ExpandedRecurrence,
  busy: BusyInterval[],
  timeZone: string,
  now: number,
  preferred: number | null,
): RecurrenceAvailability {
  for (const minute of candidateMinutes(preferred).sort(
    (left, right) => Math.abs(left - (preferred ?? left)) - Math.abs(right - (preferred ?? right)),
  )) {
    if (minute + proposal.durationMinutes > CALENDAR_SEARCH_END_MINUTES) continue
    const time = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`
    if (time === proposal.startTime) continue
    const occurrences = allAtTime(expanded.dates, time, proposal.durationMinutes, timeZone)
    if (
      occurrences?.every(
        (occurrence) => !occurrenceConflicts(occurrence, busy, CALENDAR_INFERRED_BUFFER_MINUTES, now, timeZone),
      )
    )
      return {
        kind: "common-alternative",
        localStartTime: time,
        occurrences,
        rrule: expanded.rrule,
        humanCadence: expanded.humanCadence,
        reminderMinutes: reminderMinutes(proposal),
      }
  }
  return { kind: "conflict" }
}

/** Projects an approved recurrence into one native parent event. */
export function managedRecurringEvent(
  identity: { id: string; requestId: string },
  proposal: RecurringProposal,
  occurrence: RecurringOccurrence,
  rrule: string,
  reminder: number,
  timeZone: string,
): ManagedCalendarEvent {
  return {
    ...identity,
    summary: proposal.title.trim(),
    start: occurrence.start,
    end: occurrence.end,
    timeZone,
    recurrence: [rrule],
    ...(proposal.description?.trim() ? { description: proposal.description.trim() } : {}),
    ...(proposal.location?.trim() ? { location: proposal.location.trim() } : {}),
    reminderMinutes: reminder,
  }
}
