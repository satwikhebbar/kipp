import { describe, expect, it, vi } from "vitest"
import { evaluateCalendarCandidate } from "../calendar/evaluation"
import { createCalendarPlanLedger } from "../calendar/plan"

const CONTEXT = {
  getBusyIntervals: vi.fn().mockResolvedValue([]),
  ledger: createCalendarPlanLedger(),
  version: 1,
  expiresAt: Date.parse("2026-08-04T00:00:00.000Z"),
  timeZone: "Asia/Kolkata",
  now: Date.parse("2026-08-01T00:00:00.000Z"),
}

describe("Calendar candidate evaluation", () => {
  it.each([
    ["2026-03-08", "02:30", "America/New_York", "nonexistent_local_time", "startTime"],
    ["2026-11-01", "01:30", "America/New_York", "ambiguous_local_time", "startTime"],
    ["2026-08-04", "19:00", "Not/AZone", "invalid_time_zone", "timeZone"],
    ["2026-02-30", "19:00", "UTC", "invalid_local_date", "localDate"],
  ])("returns typed local-time clarification before availability reads: %s %s %s", async (localDate, startTime, timeZone, code, field) => {
    const getBusyIntervals = vi.fn()
    const ledger = createCalendarPlanLedger()
    const result = await evaluateCalendarCandidate(
      {
        kind: "one_off",
        proposal: {
          title: "A thought to discuss",
          localDate,
          startTime,
          durationMinutes: 30,
          dateIsExplicit: true,
          timeIsExplicit: true,
          classification: "ordinary",
          needsClarification: false,
        },
      },
      { ...CONTEXT, timeZone, getBusyIntervals, ledger },
    )
    expect(result).toMatchObject({ kind: "needs_input", issues: [{ code, field }] })
    expect(getBusyIntervals).not.toHaveBeenCalled()
    expect(ledger.records).toHaveLength(0)
  })

  it("reports a recurring gap on its actual occurrence date before issuing a plan", async () => {
    const getBusyIntervals = vi.fn()
    const ledger = createCalendarPlanLedger()
    const result = await evaluateCalendarCandidate(
      {
        kind: "recurring",
        proposal: {
          title: "Weekly review",
          firstDate: "2026-03-01",
          dateIsExplicit: true,
          startTime: "02:30",
          timeIsExplicit: true,
          durationMinutes: 30,
          classification: "ordinary",
          recurrence: { cadence: "weekly", weekdays: { mode: "first_date_weekday" } },
          recurrenceIsExplicit: true,
          needsClarification: false,
          end: { mode: "count", occurrences: 3 },
        },
      },
      { ...CONTEXT, timeZone: "America/New_York", getBusyIntervals, ledger },
    )
    expect(result).toEqual({
      kind: "needs_input",
      issues: [
        {
          code: "nonexistent_local_time",
          field: "startTime",
          params: { localDate: "2026-03-08", startTime: "02:30", timeZone: "America/New_York" },
        },
      ],
    })
    expect(getBusyIntervals).not.toHaveBeenCalled()
    expect(ledger.records).toHaveLength(0)
  })

  it.each([
    ["2026-03-08", "America/New_York", "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"],
    ["2026-11-01", "America/New_York", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"],
    ["2018-11-04", "America/Sao_Paulo", "2018-11-04T03:00:00.000Z", "2018-11-05T02:00:00.000Z"],
  ])("queries the actual local day bounds: %s %s", async (localDate, timeZone, timeMin, timeMax) => {
    const getBusyIntervals = vi.fn().mockResolvedValue([])
    const result = await evaluateCalendarCandidate(
      {
        kind: "one_off",
        proposal: {
          title: "Review",
          localDate,
          startTime: "09:00",
          durationMinutes: 30,
          dateIsExplicit: true,
          timeIsExplicit: true,
          classification: "ordinary",
          needsClarification: false,
        },
      },
      {
        ...CONTEXT,
        ledger: createCalendarPlanLedger(),
        timeZone,
        getBusyIntervals,
        now: Date.parse("2018-01-01T00:00:00Z"),
      },
    )
    expect(result.kind).toBe("ready")
    expect(getBusyIntervals).toHaveBeenCalledWith(timeMin, timeMax)
  })

  it("aggregates policy issues before any Calendar read", async () => {
    const getBusyIntervals = vi.fn()
    const result = await evaluateCalendarCandidate(
      {
        kind: "one_off",
        proposal: {
          title: " ",
          localDate: "",
          startTime: "invalid",
          durationMinutes: 20,
          dateIsExplicit: false,
          timeIsExplicit: true,
          classification: "ordinary",
          needsClarification: true,
        },
      },
      { ...CONTEXT, ledger: createCalendarPlanLedger(), getBusyIntervals },
    )

    expect(result).toMatchObject({
      kind: "needs_input",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "missing_date", field: "localDate" }),
        expect.objectContaining({ code: "invalid_title", field: "title" }),
        expect.objectContaining({ code: "invalid_duration_increment", field: "durationMinutes" }),
        expect.objectContaining({ code: "missing_or_invalid_time", field: "startTime" }),
      ]),
    })
    expect(getBusyIntervals).not.toHaveBeenCalled()
  })

  it("issues an opaque ready plan for a free recurring candidate", async () => {
    const ledger = createCalendarPlanLedger()
    const result = await evaluateCalendarCandidate(
      {
        kind: "recurring",
        proposal: {
          title: "Weekly review",
          firstDate: "2026-08-04",
          dateIsExplicit: true,
          startTime: "19:00",
          timeIsExplicit: true,
          durationMinutes: 30,
          classification: "ordinary",
          recurrence: { cadence: "weekly", weekdays: { mode: "first_date_weekday" } },
          recurrenceIsExplicit: true,
          needsClarification: false,
          end: { mode: "count", occurrences: 3 },
        },
      },
      { ...CONTEXT, ledger },
    )

    expect(result).toMatchObject({
      kind: "ready",
      planId: expect.any(String),
      facts: { candidateKind: "recurring", occurrenceCount: 3, localStartTime: "19:00" },
    })
    expect(ledger.records).toHaveLength(1)
    expect(ledger.records[0]?.plan).toMatchObject({ kind: "recurring", occurrences: { length: 3 } })
  })

  it("evaluates an Aug 8 biweekly series with the default horizon without throwing", async () => {
    const ledger = createCalendarPlanLedger()
    const getBusyIntervals = vi.fn().mockResolvedValue([])
    const result = await evaluateCalendarCandidate(
      {
        kind: "recurring",
        proposal: {
          title: "Substack metrics review",
          firstDate: "2026-08-08",
          dateIsExplicit: true,
          startTime: "09:00",
          timeIsExplicit: true,
          durationMinutes: 30,
          classification: "ordinary",
          recurrence: { cadence: "biweekly" },
          recurrenceIsExplicit: true,
          needsClarification: false,
          end: { mode: "default_horizon" },
        },
      },
      { ...CONTEXT, ledger, getBusyIntervals, now: Date.parse("2026-08-04T08:10:00.000Z") },
    )

    expect(result).toMatchObject({
      kind: "ready",
      planId: expect.any(String),
      facts: { candidateKind: "recurring", occurrenceCount: 14, localStartTime: "09:00" },
    })
    expect(getBusyIntervals).toHaveBeenCalledOnce()
  })

  it("distinguishes a valid recurring adjustment from having no available time", async () => {
    const result = await evaluateCalendarCandidate(
      {
        kind: "recurring",
        proposal: {
          title: "Weekly review",
          firstDate: "2026-08-04",
          dateIsExplicit: true,
          startTime: "19:00",
          timeIsExplicit: true,
          durationMinutes: 30,
          classification: "ordinary",
          recurrence: { cadence: "weekly", weekdays: { mode: "first_date_weekday" } },
          recurrenceIsExplicit: true,
          needsClarification: false,
          end: { mode: "count", occurrences: 3 },
        },
      },
      {
        ...CONTEXT,
        ledger: createCalendarPlanLedger(),
        getBusyIntervals: vi
          .fn()
          .mockResolvedValue([{ start: "2026-08-04T13:30:00.000Z", end: "2026-08-04T14:00:00.000Z" }]),
      },
    )

    expect(result).toMatchObject({
      kind: "choice_required",
      issues: [{ code: "requested_time_conflicts", field: "startTime" }],
      options: [
        {
          kind: "recurring_adjustments",
          adjustedDates: [{ localDate: "2026-08-04", localStartTime: "19:45" }],
        },
      ],
    })
  })

  it("rejects an invented recurring date and cadence before Calendar access", async () => {
    const getBusyIntervals = vi.fn()
    const result = await evaluateCalendarCandidate(
      {
        kind: "recurring",
        proposal: {
          title: "Recurring review",
          firstDate: "2026-08-04",
          dateIsExplicit: false,
          timeIsExplicit: false,
          durationMinutes: 30,
          classification: "ordinary",
          recurrence: { cadence: "weekly", weekdays: { mode: "first_date_weekday" } },
          recurrenceIsExplicit: false,
          needsClarification: false,
          end: { mode: "default_horizon" },
        },
      },
      { ...CONTEXT, ledger: createCalendarPlanLedger(), getBusyIntervals },
    )

    expect(result).toEqual({
      kind: "needs_input",
      issues: [
        { code: "missing_date", field: "firstDate" },
        { code: "unsupported_recurrence", field: "recurrence" },
      ],
    })
    expect(getBusyIntervals).not.toHaveBeenCalled()
  })

  it("asks before scheduling when an explicit unsupported recurrence is requested", async () => {
    const getBusyIntervals = vi.fn()
    const result = await evaluateCalendarCandidate(
      {
        kind: "recurring",
        proposal: {
          title: "Quarterly investment review",
          firstDate: "2026-09-26",
          dateIsExplicit: true,
          startTime: "11:30",
          timeIsExplicit: true,
          durationMinutes: 30,
          classification: "ordinary",
          recurrence: { cadence: "weekly", weekdays: { mode: "first_date_weekday" } },
          recurrenceIsExplicit: true,
          needsClarification: true,
          end: { mode: "default_horizon" },
        },
      },
      { ...CONTEXT, ledger: createCalendarPlanLedger(), getBusyIntervals },
    )

    expect(result).toEqual({
      kind: "needs_input",
      issues: [{ code: "unsupported_configuration", field: "recurrence" }],
    })
    expect(getBusyIntervals).not.toHaveBeenCalled()
  })

  it("flags an explicit unsupported configuration on a valid-date one-off without asking for the date", async () => {
    const getBusyIntervals = vi.fn()
    const result = await evaluateCalendarCandidate(
      {
        kind: "one_off",
        proposal: {
          title: "Quarterly investment review",
          localDate: "2026-09-26",
          startTime: "11:30",
          durationMinutes: 30,
          dateIsExplicit: true,
          timeIsExplicit: true,
          classification: "ordinary",
          needsClarification: true,
        },
      },
      { ...CONTEXT, ledger: createCalendarPlanLedger(), getBusyIntervals },
    )

    expect(result).toEqual({
      kind: "needs_input",
      issues: [{ code: "unsupported_configuration", field: "recurrence" }],
    })
    expect(getBusyIntervals).not.toHaveBeenCalled()
  })
})
