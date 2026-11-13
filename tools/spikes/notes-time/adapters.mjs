import { DateTime } from "luxon"
import { Temporal } from "@js-temporal/polyfill"

const minute = 60_000
const day = 86_400_000

/** Parses strict minute-resolution civil fields, rejecting normalized dates. */
function fields(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw Error("invalid")
  const [year, month, dateDay] = date.split("-").map(Number)
  const [hour, minute] = time.split(":").map(Number)
  const ms = Date.parse(`${date}T${time}:00Z`)
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 16) !== `${date}T${time}`) throw Error("invalid")
  return { year, month, day: dateDay, hour, minute }
}

/** Produces one normalized result shape for the three candidate implementations. */
function result(candidates) {
  const instants = [...new Set(candidates)].sort((a, b) => a - b).map(ms => new Date(ms).toISOString())
  return { kind: instants.length === 0 ? "nonexistent" : instants.length > 1 ? "ambiguous" : "unique", instants }
}

/** Catches invalid calendar dates and unsupported zones independently of gap results. */
function safe(fn) {
  try { return fn() } catch { return { kind: "invalid", instants: [] } }
}

/** Formats all needed parts with one formatter, shared within an Intl lookup. */
function formatter(zone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
}

/** Renders Intl fields as a UTC-shaped civil value for offset and round-trip checks. */
function civil(format, ms) {
  const p = Object.fromEntries(format.formatToParts(ms).filter(x => x.type !== "literal").map(x => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`
}

export const intl = {
  /** Samples nearby offsets, then admits only exact round trips; sampling is not a TZ transition proof. */
  resolve(date, time, zone) {
    return safe(() => {
      fields(date, time)
      const nominal = Date.parse(`${date}T${time}:00Z`)
      const format = formatter(zone)
      const offsets = new Set()
      for (let hours = -48; hours <= 48; hours += 6) {
        const instant = nominal + hours * 60 * minute
        offsets.add(Date.parse(civil(format, instant)) - instant)
      }
      return result([...offsets].map(offset => nominal - offset).filter(ms => civil(format, ms) === `${date}T${time}:00Z`))
    })
  },
  /** Adds civil days without adding elapsed 24-hour blocks to a zoned instant. */
  add(date, days) {
    fields(date, "00:00")
    const d = new Date(`${date}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + days)
    return d.toISOString().slice(0, 10)
  },
  /** Finds the first existing minute on each boundary date, including midnight gaps. */
  bounds(date, zone) {
    const first = localDate => {
      for (let i = 0; i < 1440; i++) {
        const time = `${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`
        const r = this.resolve(localDate, time, zone)
        if (r.kind === "invalid") throw Error("invalid")
        if (r.instants.length) return r.instants[0]
      }
      throw Error("skipped day")
    }
    return [first(date), first(this.add(date, 1))]
  },
}

export const luxon = {
  /** Luxon normalizes gaps, so compare requested fields before enumerating overlap offsets. */
  resolve(date, time, zone) {
    return safe(() => {
      const f = fields(date, time)
      const dt = DateTime.fromObject(f, { zone })
      if (!dt.isValid) throw Error("invalid")
      if (dt.toFormat("yyyy-MM-dd'T'HH:mm") !== `${date}T${time}`) return result([])
      return result(dt.getPossibleOffsets().map(x => x.toMillis()))
    })
  },
  /** Uses calendar-day arithmetic rather than elapsed-hour arithmetic. */
  add(date, days) {
    fields(date, "00:00")
    return DateTime.fromISO(date, { zone: "UTC" }).plus({ days }).toISODate()
  },
  /** startOf handles a missing midnight; reject a completely skipped requested day. */
  bounds(date, zone) {
    fields(date, "00:00")
    const dt = DateTime.fromISO(date, { zone }).startOf("day")
    if (!dt.isValid || dt.toISODate() !== date) throw Error("invalid or skipped day")
    return [dt.toUTC().toISO(), dt.plus({ days: 1 }).startOf("day").toUTC().toISO()]
  },
}

export const temporal = {
  /** Compares both disambiguations; neither round-tripping identifies a gap. */
  resolve(date, time, zone) {
    return safe(() => {
      const f = fields(date, time)
      const plain = Temporal.PlainDateTime.from(f, { overflow: "reject" })
      const candidates = ["earlier", "later"].map(disambiguation => plain.toZonedDateTime(zone, { disambiguation }))
      return result(candidates.filter(x => x.toPlainDateTime().equals(plain)).map(x => x.epochMilliseconds))
    })
  },
  /** Uses a zone-independent PlainDate for relative-date and recurrence arithmetic. */
  add(date, days) {
    fields(date, "00:00")
    return Temporal.PlainDate.from(date, { overflow: "reject" }).add({ days }).toString()
  },
  /** toZonedDateTime without a wall time finds the actual start of the civil day. */
  bounds(date, zone) {
    fields(date, "00:00")
    const plain = Temporal.PlainDate.from(date, { overflow: "reject" })
    const start = plain.toZonedDateTime(zone)
    if (!start.toPlainDate().equals(plain)) throw Error("skipped day")
    return [start.toInstant().toString(), plain.add({ days: 1 }).toZonedDateTime(zone).toInstant().toString()]
  },
}
