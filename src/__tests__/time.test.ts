import { describe, expect, it } from "vitest"
import { addCivilDays, localDateAt, localDayBounds, localTimeAt, resolveLocalDateTime } from "../core/time"

describe("strict shared local time", () => {
  it("preserves normal Kolkata instants and local display", () => {
    const epochMs = Date.parse("2026-07-28T13:30:00.000Z")
    expect(resolveLocalDateTime("2026-07-28", "19:00", "Asia/Kolkata")).toEqual({ kind: "unique", epochMs })
    expect(localDateAt(epochMs, "Asia/Kolkata")).toBe("2026-07-28")
    expect(localTimeAt(epochMs, "Asia/Kolkata")).toBe("19:00")
  })

  it.each([
    ["2026-02-30", "12:00", "UTC", "date"],
    ["2026-01-01", "24:00", "UTC", "time"],
    ["2026-01-01", "12:00", "Not/AZone", "timeZone"],
    ["2026-01-01", "12:00", "UTC+05:30", "timeZone"],
    ["2026-01-01", "12:00", "+05:30", "timeZone"],
    ["2026-01-01", "12:00\n", "UTC", "time"],
    ["2026-01-01", "12:00", "local", "timeZone"],
  ])("rejects invalid fields without normalization or exceptions: %s %s %s", (date, time, zone, field) => {
    expect(resolveLocalDateTime(date, time, zone)).toEqual({ kind: "invalid", field })
  })

  it.each([
    ["2026-03-08", "02:30", "America/New_York"],
    ["2026-10-04", "02:15", "Australia/Lord_Howe"],
    ["2011-12-30", "12:00", "Pacific/Apia"],
  ])("rejects nonexistent wall times: %s %s %s", (date, time, zone) => {
    expect(resolveLocalDateTime(date, time, zone)).toEqual({ kind: "nonexistent" })
  })

  it.each([
    ["2026-11-01", "01:30", "America/New_York", "2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"],
    ["2026-04-05", "01:45", "Australia/Lord_Howe", "2026-04-04T14:45:00.000Z", "2026-04-04T15:15:00.000Z"],
  ])("returns both overlap instants: %s %s %s", (date, time, zone, earlier, later) => {
    expect(resolveLocalDateTime(date, time, zone)).toEqual({
      kind: "ambiguous",
      earlier: Date.parse(earlier),
      later: Date.parse(later),
    })
  })

  it.each([
    ["2026-03-08", "America/New_York", "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"],
    ["2026-11-01", "America/New_York", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"],
    ["2026-11-01", "America/Havana", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"],
    ["2018-11-04", "America/Sao_Paulo", "2018-11-04T03:00:00.000Z", "2018-11-05T02:00:00.000Z"],
    ["2011-12-29", "Pacific/Apia", "2011-12-29T10:00:00.000Z", "2011-12-30T10:00:00.000Z"],
    ["2026-07-28", "Asia/Kolkata", "2026-07-27T18:30:00.000Z", "2026-07-28T18:30:00.000Z"],
  ])("uses actual day boundaries: %s %s", (date, zone, timeMin, timeMax) => {
    expect(localDayBounds(date, zone)).toEqual({ timeMin, timeMax })
  })

  it("rejects wholly skipped dates and invalid day bounds", () => {
    expect(localDayBounds("2011-12-30", "Pacific/Apia")).toBeNull()
    expect(localDayBounds("2026-02-30", "UTC")).toBeNull()
    expect(localDayBounds("2026-01-01", "Not/AZone")).toBeNull()
  })

  it.each([
    ["2026-03-07", 1, "2026-03-08"],
    ["2026-12-31", 1, "2027-01-01"],
    ["2024-02-28", 1, "2024-02-29"],
    ["2026-01-01", -1, "2025-12-31"],
  ])("adds calendar days without elapsed-hour assumptions: %s", (date, days, expected) => {
    expect(addCivilDays(date, days)).toBe(expected)
  })

  it("rejects malformed civil arithmetic and invalid formatting inputs", () => {
    expect(addCivilDays("2026-02-30", 1)).toBeNull()
    expect(addCivilDays("2026-01-01", 0.5)).toBeNull()
    expect(() => localDateAt(Number.NaN, "UTC")).toThrow(RangeError)
    expect(() => localTimeAt(0, "Not/AZone")).toThrow(RangeError)
  })
})
