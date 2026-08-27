import { describe, expect, it } from "vitest"
import { resolvePlanningWeek } from "../meal-planning/week"

const TZ = "Asia/Kolkata" // UTC+05:30
const CURRENT_WEEK_START = "2026-09-06T18:30:00.000Z" // Mon 2026-09-07 00:00 IST
const CURRENT_WEEK_END = "2026-09-12T18:29:59.000Z" // Sat 2026-09-12 23:59:59 IST
const NEXT_WEEK_START = "2026-09-13T18:30:00.000Z" // Mon 2026-09-14 00:00 IST
const NEXT_WEEK_END = "2026-09-19T18:29:59.000Z" // Sat 2026-09-19 23:59:59 IST

function at(iso: string): number {
  return Date.parse(iso)
}

describe("resolvePlanningWeek", () => {
  it("defaults Mon–Wed to the current week", () => {
    expect(resolvePlanningWeek(at("2026-09-07T03:30:00.000Z"), TZ)).toEqual({
      weekStart: CURRENT_WEEK_START,
      weekEnd: CURRENT_WEEK_END,
    })
    expect(resolvePlanningWeek(at("2026-09-09T03:30:00.000Z"), TZ)).toEqual({
      weekStart: CURRENT_WEEK_START,
      weekEnd: CURRENT_WEEK_END,
    })
  })

  it("defaults Thu–Sun to the next week, including Sunday", () => {
    expect(resolvePlanningWeek(at("2026-09-10T03:30:00.000Z"), TZ)).toEqual({
      weekStart: NEXT_WEEK_START,
      weekEnd: NEXT_WEEK_END,
    })
    expect(resolvePlanningWeek(at("2026-09-12T03:30:00.000Z"), TZ)).toEqual({
      weekStart: NEXT_WEEK_START,
      weekEnd: NEXT_WEEK_END,
    })
    expect(resolvePlanningWeek(at("2026-09-13T04:30:00.000Z"), TZ)).toEqual({
      weekStart: NEXT_WEEK_START,
      weekEnd: NEXT_WEEK_END,
    })
  })

  it("honors the this-week and next-week overrides regardless of the invoked weekday", () => {
    expect(resolvePlanningWeek(at("2026-09-10T03:30:00.000Z"), TZ, "this week")).toEqual({
      weekStart: CURRENT_WEEK_START,
      weekEnd: CURRENT_WEEK_END,
    })
    expect(resolvePlanningWeek(at("2026-09-09T03:30:00.000Z"), TZ, "next week")).toEqual({
      weekStart: NEXT_WEEK_START,
      weekEnd: NEXT_WEEK_END,
    })
  })

  it("resolves a date override to the week containing it", () => {
    expect(resolvePlanningWeek(at("2026-09-10T03:30:00.000Z"), TZ, "2026-09-09")).toEqual({
      weekStart: CURRENT_WEEK_START,
      weekEnd: CURRENT_WEEK_END,
    })
    expect(resolvePlanningWeek(at("2026-09-09T03:30:00.000Z"), TZ, "2026-09-14")).toEqual({
      weekStart: NEXT_WEEK_START,
      weekEnd: NEXT_WEEK_END,
    })
  })

  it("clamps a stale date override (a week that already ended) to the default rule", () => {
    const result = resolvePlanningWeek(at("2026-09-09T03:30:00.000Z"), TZ, "2026-08-31")
    expect(result).toEqual({ weekStart: CURRENT_WEEK_START, weekEnd: CURRENT_WEEK_END })
  })

  it("treats unparsed text as the default rule", () => {
    expect(resolvePlanningWeek(at("2026-09-07T03:30:00.000Z"), TZ, "paneer please")).toEqual({
      weekStart: CURRENT_WEEK_START,
      weekEnd: CURRENT_WEEK_END,
    })
  })

  it("flips the week at the Thursday 00:00 boundary in the profile timezone, not UTC", () => {
    // Wed 09-09 23:59:59 IST = Wed 09-09 18:29:59 UTC (still Wednesday in both zones) → current week.
    expect(resolvePlanningWeek(at("2026-09-09T18:29:59.000Z"), TZ)).toEqual({
      weekStart: CURRENT_WEEK_START,
      weekEnd: CURRENT_WEEK_END,
    })
    // Thu 09-10 00:00 IST = Wed 09-09 18:30:00 UTC. The UTC weekday is still
    // Wednesday, but the profile-timezone weekday has flipped to Thursday →
    // next week. This proves the rule reads the profile timezone, not UTC.
    expect(resolvePlanningWeek(at("2026-09-09T18:30:00.000Z"), TZ)).toEqual({
      weekStart: NEXT_WEEK_START,
      weekEnd: NEXT_WEEK_END,
    })
  })
})
