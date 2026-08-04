import { afterEach, beforeEach, describe, expect, it, vi as vitest } from "vitest"
import {
  CALENDAR_IMPORTANT_REMINDER_MINUTES,
  CALENDAR_MAX_DURATION_MINUTES,
  CALENDAR_ORDINARY_REMINDER_MINUTES,
  calendarDayBounds,
  managedEvent,
  managedEventIdentity,
  type OneOffProposal,
  reminderMinutes,
  scheduleOneOff,
  suggestOneOffAlternative,
  validateProposal,
  validateProposalIssues,
  zonedDateTimeToMillis,
} from "../calendar/scheduling"

const TIME_ZONE = "Asia/Kolkata"
const DATE = "2026-07-28"
const EXPLICIT_CALL: OneOffProposal = {
  title: "Call Jamie",
  localDate: DATE,
  startTime: "19:00",
  durationMinutes: 30,
  dateIsExplicit: true,
  timeIsExplicit: true,
  classification: "ordinary",
  needsClarification: false,
}

describe("Calendar scheduling policy", () => {
  beforeEach(() => {
    vitest.useFakeTimers()
    vitest.setSystemTime(new Date("2026-07-01T00:00:00.000Z"))
  })
  afterEach(() => vitest.useRealTimers())

  it("converts local time independently of the host timezone", () => {
    const timestamp = zonedDateTimeToMillis(DATE, "19:00", TIME_ZONE)
    expect(timestamp).not.toBeNull()
    expect(new Date(timestamp as number).toISOString()).toBe("2026-07-28T13:30:00.000Z")
  })

  it("returns exact ISO bounds for a local calendar day", () => {
    expect(calendarDayBounds(DATE, TIME_ZONE)).toEqual({
      timeMin: "2026-07-27T18:30:00.000Z",
      timeMax: "2026-07-28T18:30:00.000Z",
    })
    expect(calendarDayBounds("not-a-date", TIME_ZONE)).toBeNull()
  })

  it("honors a free explicit time without inferred buffers", () => {
    const scheduled = scheduleOneOff(EXPLICIT_CALL, [], TIME_ZONE)
    expect(scheduled).toMatchObject({ localStartTime: "19:00", reminderMinutes: CALENDAR_ORDINARY_REMINDER_MINUTES })
  })

  it("reports an explicit-time conflict instead of moving it", () => {
    const scheduled = scheduleOneOff(
      EXPLICIT_CALL,
      [{ start: "2026-07-28T13:30:00.000Z", end: "2026-07-28T14:00:00.000Z" }],
      TIME_ZONE,
    )
    expect(scheduled).toEqual({ conflict: true })
  })

  it("offers a same-day privacy-safe alternative for an explicit conflict", () => {
    const alternative = suggestOneOffAlternative(
      EXPLICIT_CALL,
      [{ start: "2026-07-28T13:30:00.000Z", end: "2026-07-28T14:00:00.000Z" }],
      TIME_ZONE,
    )
    expect(alternative).toMatchObject({ localStartTime: "19:45", reminderMinutes: CALENDAR_ORDINARY_REMINDER_MINUTES })
  })

  it("chooses the nearest viable alternative, including one before the requested time", () => {
    const alternative = suggestOneOffAlternative(
      { ...EXPLICIT_CALL, startTime: "21:15" },
      [{ start: "2026-07-28T15:45:00.000Z", end: "2026-07-28T16:15:00.000Z" }],
      TIME_ZONE,
    )

    expect(alternative).toMatchObject({ localStartTime: "20:30" })
  })

  it("keeps the inferred safety buffer and returns no alternative when the day is full", () => {
    const buffered = suggestOneOffAlternative(
      EXPLICIT_CALL,
      [{ start: "2026-07-28T13:30:00.000Z", end: "2026-07-28T14:00:00.000Z" }],
      TIME_ZONE,
    )
    const noAlternative = suggestOneOffAlternative(
      EXPLICIT_CALL,
      [{ start: "2026-07-28T03:00:00.000Z", end: "2026-07-28T17:30:00.000Z" }],
      TIME_ZONE,
    )

    expect(buffered).toMatchObject({ localStartTime: "19:45" })
    expect(noAlternative).toBeNull()
  })

  it("uses a preferred inferred slot and applies a one-hour important reminder", () => {
    const proposal: OneOffProposal = {
      ...EXPLICIT_CALL,
      title: "Pick up my son",
      startTime: undefined,
      timeIsExplicit: false,
      classification: "school-pickup",
    }
    const scheduled = scheduleOneOff(proposal, [], TIME_ZONE)
    expect(scheduled).toMatchObject({ localStartTime: "19:00", reminderMinutes: CALENDAR_IMPORTANT_REMINDER_MINUTES })
  })

  it("moves an inferred block past a busy buffer without moving an explicit block", () => {
    const busyBeforePreferredTime = [{ start: "2026-07-28T13:20:00.000Z", end: "2026-07-28T13:30:00.000Z" }]
    const inferred: OneOffProposal = { ...EXPLICIT_CALL, startTime: undefined, timeIsExplicit: false }

    expect(scheduleOneOff(inferred, busyBeforePreferredTime, TIME_ZONE)).toMatchObject({ localStartTime: "19:15" })
    expect(scheduleOneOff(EXPLICIT_CALL, busyBeforePreferredTime, TIME_ZONE)).toMatchObject({ localStartTime: "19:00" })
  })

  it("requires a time for an inferred block beyond the short default duration", () => {
    const proposal: OneOffProposal = {
      ...EXPLICIT_CALL,
      startTime: undefined,
      timeIsExplicit: false,
      durationMinutes: 45,
    }
    expect(scheduleOneOff(proposal, [], TIME_ZONE)).toEqual({
      clarification: "Please tell me what time works for this longer block.",
    })
  })

  it("rejects an explicit same-day time inside the minimum lead window", () => {
    const proposal: OneOffProposal = { ...EXPLICIT_CALL, localDate: "2026-07-28", startTime: "19:00" }
    const now = zonedDateTimeToMillis("2026-07-28", "18:45", TIME_ZONE) as number
    expect(scheduleOneOff(proposal, [], TIME_ZONE, now)).toEqual({ conflict: true })
  })

  it("requires a time for an inferred family or social request", () => {
    const proposal: OneOffProposal = {
      ...EXPLICIT_CALL,
      startTime: undefined,
      timeIsExplicit: false,
      classification: "family-social",
    }
    expect(scheduleOneOff(proposal, [], TIME_ZONE)).toEqual({
      clarification: "Please tell me what time works for this family or social plan.",
    })
  })

  it("enforces required proposal fields and duration bounds", () => {
    expect(validateProposal({ ...EXPLICIT_CALL, localDate: undefined })).toBe("Please tell me the date.")
    expect(validateProposal({ ...EXPLICIT_CALL, title: " " })).toBe("I need a short title for this calendar block.")
    expect(validateProposal({ ...EXPLICIT_CALL, durationMinutes: CALENDAR_MAX_DURATION_MINUTES + 15 })).toBe(
      "Please give me a duration between 15 minutes and 4 hours.",
    )
    expect(validateProposal({ ...EXPLICIT_CALL, durationMinutes: 20 })).toBe(
      "Please use a duration in 15-minute increments.",
    )
  })

  it("returns every independently discoverable semantic issue without prose", () => {
    expect(
      validateProposalIssues({
        ...EXPLICIT_CALL,
        title: " ",
        localDate: undefined,
        startTime: "not-a-time",
        durationMinutes: 20,
      }),
    ).toEqual([
      { code: "missing_date", field: "localDate" },
      { code: "invalid_title", field: "title", params: { maxCharacters: 120 } },
      { code: "invalid_duration_increment", field: "durationMinutes", params: { increment: 15 } },
      { code: "missing_or_invalid_time", field: "startTime" },
    ])
  })

  it("uses explicit reminder overrides and classification defaults", () => {
    expect(reminderMinutes(EXPLICIT_CALL)).toBe(CALENDAR_ORDINARY_REMINDER_MINUTES)
    expect(reminderMinutes({ ...EXPLICIT_CALL, reminderMinutes: 45 })).toBe(45)
    expect(reminderMinutes({ ...EXPLICIT_CALL, classification: "physical" })).toBe(CALENDAR_IMPORTANT_REMINDER_MINUTES)
  })

  it("gives a Telegram request one stable, Calendar-safe identity", async () => {
    const first = await managedEventIdentity("123", 456)
    const second = await managedEventIdentity("123", 456)
    expect(first).toEqual(second)
    expect(first.id).toMatch(/^kipp[0-9a-v]+$/)
    expect(first.requestId).toMatch(/^kipp-v1-[0-9a-v]+$/)
    expect(await managedEventIdentity("123", 457)).not.toEqual(first)
  })

  it("projects only useful trimmed description and location into a managed event", async () => {
    const identity = await managedEventIdentity("123", 456)
    const scheduled = scheduleOneOff(EXPLICIT_CALL, [], TIME_ZONE)
    if (!("start" in scheduled)) throw new Error("expected a scheduled event")

    expect(
      managedEvent(
        identity,
        { ...EXPLICIT_CALL, title: "  Call Jamie  ", description: "  Use her mobile  ", location: "  " },
        scheduled,
        TIME_ZONE,
      ),
    ).toMatchObject({
      ...identity,
      summary: "Call Jamie",
      description: "Use her mobile",
      reminderMinutes: CALENDAR_ORDINARY_REMINDER_MINUTES,
    })
  })
})
