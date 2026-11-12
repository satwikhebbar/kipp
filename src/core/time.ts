import { DateTime, IANAZone } from "luxon"

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/
const IANA_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_+./-]*$/
const ISO_DATE_LENGTH = 10
const LOCAL_TIME_LENGTH = 5

export type LocalDateTimeResolution =
  | { kind: "unique"; epochMs: number }
  | { kind: "ambiguous"; earlier: number; later: number }
  | { kind: "nonexistent" }
  | { kind: "invalid"; field: "date" | "time" | "timeZone" }

/** Accepts UTC and IANA zone identifiers, without Luxon's fixed-offset or host-zone aliases. */
export function isValidTimeZone(timeZone: string): boolean {
  return timeZone === "UTC" || (IANA_IDENTIFIER_PATTERN.test(timeZone) && IANAZone.isValidZone(timeZone))
}

/** Validates a real ISO civil date without accepting normalized or expanded date forms. */
export function isValidLocalDate(localDate: string): boolean {
  if (localDate.length !== ISO_DATE_LENGTH || !DATE_PATTERN.test(localDate)) return false
  const date = DateTime.fromISO(localDate, { zone: "UTC" })
  return date.isValid && date.toISODate() === localDate
}

/** Resolves a wall time strictly: gaps never shift and overlaps never silently choose an offset. */
export function resolveLocalDateTime(localDate: string, time: string, timeZone: string): LocalDateTimeResolution {
  if (!isValidTimeZone(timeZone)) return { kind: "invalid", field: "timeZone" }
  if (!isValidLocalDate(localDate)) return { kind: "invalid", field: "date" }
  if (time.length !== LOCAL_TIME_LENGTH || !TIME_PATTERN.test(time)) return { kind: "invalid", field: "time" }
  const [year, month, day] = localDate.split("-").map(Number)
  const [hour, minute] = time.split(":").map(Number)
  const date = DateTime.fromObject({ year, month, day, hour, minute }, { zone: timeZone })
  if (!date.isValid) return { kind: "invalid", field: "date" }
  if (date.toISODate() !== localDate || date.toFormat("HH:mm") !== time) return { kind: "nonexistent" }
  const candidates = [...new Set(date.getPossibleOffsets().map((candidate) => candidate.toMillis()))].sort(
    (left, right) => left - right,
  )
  if (candidates.length > 1)
    return { kind: "ambiguous", earlier: candidates[0], later: candidates[candidates.length - 1] }
  return { kind: "unique", epochMs: candidates[0] }
}

/** Formats a valid instant in a supported zone, rejecting invalid input instead of using the host zone. */
function instantAt(timestamp: number, timeZone: string): DateTime<true> {
  if (!Number.isFinite(timestamp) || !isValidTimeZone(timeZone)) throw new RangeError("Invalid instant or time zone")
  const date = DateTime.fromMillis(timestamp, { zone: timeZone })
  if (!date.isValid) throw new RangeError("Invalid instant")
  return date
}

/** Returns an instant's YYYY-MM-DD date in the supplied zone. */
export function localDateAt(timestamp: number, timeZone: string): string {
  return instantAt(timestamp, timeZone).toISODate()
}

/** Returns an instant's HH:mm wall time in the supplied zone. */
export function localTimeAt(timestamp: number, timeZone: string): string {
  return instantAt(timestamp, timeZone).toFormat("HH:mm")
}

/** Adds civil calendar days independently of zone offsets and elapsed-day lengths. */
export function addCivilDays(localDate: string, days: number): string | null {
  if (!isValidLocalDate(localDate) || !Number.isInteger(days)) return null
  const date = DateTime.fromISO(localDate, { zone: "UTC" }).plus({ days })
  const result = date.toISODate()
  return result && isValidLocalDate(result) ? result : null
}

/** Returns actual exclusive bounds of a civil day, including midnight gaps and skipped following dates. */
export function localDayBounds(localDate: string, timeZone: string): { timeMin: string; timeMax: string } | null {
  if (!isValidLocalDate(localDate) || !isValidTimeZone(timeZone)) return null
  const start = DateTime.fromISO(localDate, { zone: timeZone }).startOf("day")
  if (!start.isValid || start.toISODate() !== localDate) return null
  const end = start.plus({ days: 1 }).startOf("day")
  if (!end.isValid) return null
  // A repeated midnight also needs its earliest offset; Luxon's default can depend on today's offset.
  const startMs = Math.min(...start.getPossibleOffsets().map((candidate) => candidate.toMillis()))
  const endMs = Math.min(...end.getPossibleOffsets().map((candidate) => candidate.toMillis()))
  if (endMs <= startMs) return null
  return { timeMin: new Date(startMs).toISOString(), timeMax: new Date(endMs).toISOString() }
}
