import { localDateAt, zonedDateTimeToMillis } from "../calendar/scheduling"

/** The pinned Mon 00:00 – Sat 23:59:59 school-week bounds in the profile timezone, as ISO-8601 UTC strings. */
export interface ResolvedPlanningWeek {
  weekStart: string
  weekEnd: string
}

const SCHOOL_DAY_END_SECONDS = 59 // plan §6: week_end = Saturday 23:59:59 local
const MILLISECONDS_PER_SECOND = 1_000
const SCHOOL_DAY_END_OFFSET_MS = SCHOOL_DAY_END_SECONDS * MILLISECONDS_PER_SECOND
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const DAYS_PER_WEEK = 7
const DAYS_BETWEEN_MONDAY_AND_SUNDAY = 6
const DAYS_FROM_MONDAY_TO_SATURDAY = 5
/** The default rule switches to the next week from Thursday (weekday index 4) onward. */
const NEXT_WEEK_FROM_THURSDAY = 4

/** Adds whole days to a `YYYY-MM-DD` calendar date, returning a `YYYY-MM-DD` string. */
function addDays(localDate: string, days: number): string {
  const [year, month, day] = localDate.split("-").map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

/** Returns the weekday of a calendar date: 0 = Sunday ... 6 = Saturday. */
function weekdayOf(localDate: string): number {
  return new Date(`${localDate}T00:00:00Z`).getUTCDay()
}

/** Returns the Monday of the calendar week containing the supplied date. */
function mondayOfWeek(localDate: string): string {
  return addDays(localDate, -((weekdayOf(localDate) + DAYS_BETWEEN_MONDAY_AND_SUNDAY) % DAYS_PER_WEEK))
}

/** Applies the default rule: Mon–Wed invoke the current week; Thu–Sun invoke the next week (Sunday's school week ended Saturday). */
function defaultMonday(invokedDate: string): string {
  const weekday = weekdayOf(invokedDate)
  const nextWeek = weekday === 0 || weekday >= NEXT_WEEK_FROM_THURSDAY
  return nextWeek ? addDays(mondayOfWeek(invokedDate), DAYS_PER_WEEK) : mondayOfWeek(invokedDate)
}

/**
 * Resolves the target school week for a `/mealplan` invocation. The week is
 * pinned to Monday 00:00 – Saturday 23:59:59 in the profile timezone. The
 * default rule is Mon–Wed → current week, Thu–Sun → next week; "this week",
 * "next week", and a `YYYY-MM-DD` date override it. A resolved week whose
 * `week_end` already passed (a stale date override) falls back to the default
 * rule — a plan is never created for a week that has ended. Pure and
 * deterministic: `invokedAtMs` is captured by the webhook and never replaced
 * with `Date.now()` inside the workflow (replay-safe).
 */
export function resolvePlanningWeek(invokedAtMs: number, timezone: string, requestText?: string): ResolvedPlanningWeek {
  const invokedDate = localDateAt(invokedAtMs, timezone)
  const normalized = (requestText ?? "").trim().toLowerCase()
  const overrideDate = DATE_PATTERN.test(normalized) ? normalized : null

  let monday: string
  if (overrideDate) monday = mondayOfWeek(overrideDate)
  else if (normalized === "this week") monday = mondayOfWeek(invokedDate)
  else if (normalized === "next week") monday = addDays(mondayOfWeek(invokedDate), DAYS_PER_WEEK)
  else monday = defaultMonday(invokedDate)

  const weekEndMs = weekEndMillis(monday, timezone)
  if (weekEndMs < invokedAtMs) {
    // Clamp: the resolved week already ended; fall back to the default rule.
    monday = defaultMonday(invokedDate)
  }
  const resolvedStart = zonedDateTimeToMillis(monday, "00:00", timezone)
  if (resolvedStart === null) throw new Error(`cannot resolve week start for ${monday}`)
  const resolvedEnd = weekEndMillis(monday, timezone)
  return { weekStart: new Date(resolvedStart).toISOString(), weekEnd: new Date(resolvedEnd).toISOString() }
}

/** Returns the epoch millisecond instant of the Saturday 23:59:59 end of the week starting on `monday`. */
function weekEndMillis(monday: string, timezone: string): number {
  const saturday = addDays(monday, DAYS_FROM_MONDAY_TO_SATURDAY)
  const end = zonedDateTimeToMillis(saturday, "23:59", timezone)
  if (end === null) throw new Error(`cannot resolve week end for ${saturday}`)
  return end + SCHOOL_DAY_END_OFFSET_MS
}
