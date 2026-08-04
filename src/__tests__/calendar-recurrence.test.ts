import { describe, expect, it } from "vitest"
import {
  evaluateRecurrenceAvailability,
  expandRecurrence,
  managedRecurringEvent,
  type RecurringProposal,
  recurrenceHorizon,
  validateRecurringProposalIssues,
} from "../calendar-recurrence"

const TIME_ZONE = "Asia/Kolkata"
const MONTHLY: RecurringProposal = {
  title: "Monthly review",
  firstDate: "2026-01-31",
  dateIsExplicit: true,
  startTime: "19:00",
  timeIsExplicit: true,
  durationMinutes: 30,
  classification: "ordinary",
  recurrence: { cadence: "monthly", anchor: { mode: "day_of_month" } },
  recurrenceIsExplicit: true,
  end: { mode: "count", occurrences: 4 },
}

describe("Calendar recurrence policy", () => {
  it("uses six calendar months rather than a fixed day count", () => {
    expect(recurrenceHorizon("2026-01-31")).toBe("2026-07-31")
    expect(recurrenceHorizon("2024-08-31")).toBe("2025-02-28")
    expect(recurrenceHorizon("not-a-date")).toBeNull()
  })

  it.each([
    ["2026-01-31", ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]],
    ["2026-01-30", ["2026-01-30", "2026-02-28", "2026-03-30", "2026-04-30"]],
    ["2024-01-29", ["2024-01-29", "2024-02-29", "2024-03-29", "2024-04-29"]],
  ])("clamps a monthly %s anchor and returns to it later", (firstDate, dates) => {
    const result = expandRecurrence({ ...MONTHLY, firstDate })
    expect(result).toMatchObject({ dates })
    if ("rrule" in result) {
      expect(result.rrule).toContain("FREQ=MONTHLY")
      expect(result.rrule).toContain("COUNT=4")
    }
  })

  it("supports weekly named weekdays while requiring the first date to match", () => {
    const valid = expandRecurrence({
      ...MONTHLY,
      firstDate: "2026-08-03",
      recurrence: {
        cadence: "weekly",
        weekdays: { mode: "named", values: ["MO", "WE"] },
      },
      end: { mode: "count", occurrences: 5 },
    })
    expect(valid).toMatchObject({
      dates: ["2026-08-03", "2026-08-05", "2026-08-10", "2026-08-12", "2026-08-17"],
    })
    expect(
      expandRecurrence({
        ...MONTHLY,
        firstDate: "2026-08-04",
        recurrence: {
          cadence: "weekly",
          weekdays: { mode: "named", values: ["MO", "WE"] },
        },
      }),
    ).toEqual({ clarification: "The first date must fall on one of the selected weekdays." })
  })

  it("anchors biweekly recurrence to the explicit first occurrence", () => {
    expect(
      expandRecurrence({
        ...MONTHLY,
        firstDate: "2026-08-04",
        recurrence: { cadence: "biweekly" },
      }),
    ).toMatchObject({
      dates: ["2026-08-04", "2026-08-18", "2026-09-01", "2026-09-15"],
    })
  })

  it("supports every two months with the same month-end clamp", () => {
    expect(
      expandRecurrence({
        ...MONTHLY,
        recurrence: { cadence: "bimonthly", anchor: { mode: "day_of_month" } },
      }),
    ).toMatchObject({
      dates: ["2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31"],
      rrule: expect.stringContaining("INTERVAL=2"),
    })
  })

  it("keeps the first occurrence's ordinal weekday for monthly recurrence", () => {
    expect(
      expandRecurrence({
        ...MONTHLY,
        firstDate: "2026-08-08",
        recurrence: { cadence: "monthly", anchor: { mode: "ordinal_weekday", weekday: "SA" } },
      }),
    ).toMatchObject({
      dates: ["2026-08-08", "2026-09-12", "2026-10-10", "2026-11-14"],
      rrule: expect.stringContaining("BYDAY=+2SA"),
      humanCadence: "monthly on the second Saturday",
    })
  })

  it("supports an explicit last-weekday monthly anchor", () => {
    expect(
      expandRecurrence({
        ...MONTHLY,
        firstDate: "2026-08-29",
        recurrence: { cadence: "monthly", anchor: { mode: "last_weekday", weekday: "SA" } },
      }),
    ).toMatchObject({
      dates: ["2026-08-29", "2026-09-26", "2026-10-31", "2026-11-28"],
      rrule: expect.stringContaining("BYDAY=-1SA"),
      humanCadence: "monthly on the last Saturday",
    })
  })

  it("rejects a monthly weekday anchor that does not match the first occurrence", () => {
    expect(
      expandRecurrence({
        ...MONTHLY,
        firstDate: "2026-08-08",
        recurrence: { cadence: "monthly", anchor: { mode: "ordinal_weekday", weekday: "TU" } },
      }),
    ).toEqual({ clarification: "The first date must fall on one of the selected weekdays." })
  })

  it("treats an explicit end as inclusive and rejects bounds beyond six months", () => {
    expect(
      expandRecurrence({
        ...MONTHLY,
        firstDate: "2026-08-01",
        recurrence: { cadence: "daily" },
        end: { mode: "until", inclusiveDate: "2026-08-03" },
      }),
    ).toMatchObject({ dates: ["2026-08-01", "2026-08-02", "2026-08-03"] })
    expect(
      expandRecurrence({
        ...MONTHLY,
        firstDate: "2026-08-01",
        recurrence: { cadence: "daily" },
        end: { mode: "until", inclusiveDate: "2027-08-01" },
      }),
    ).toEqual({ clarification: "Recurring blocks can run for at most six calendar months." })
  })

  it("rejects an occurrence count whose final date crosses the hard horizon", () => {
    expect(
      expandRecurrence({
        ...MONTHLY,
        firstDate: "2026-08-01",
        recurrence: { cadence: "daily" },
        end: { mode: "count", occurrences: 200 },
      }),
    ).toEqual({ clarification: "That occurrence count would run beyond the six-month maximum." })
  })

  it("aggregates independent recurring policy issues as typed facts", () => {
    expect(
      validateRecurringProposalIssues({
        ...MONTHLY,
        title: " ",
        startTime: "not-a-time",
        durationMinutes: 20,
        firstDate: "not-a-date",
      }),
    ).toEqual([
      { code: "invalid_title", field: "title", params: { maxCharacters: 120 } },
      { code: "invalid_duration_increment", field: "durationMinutes", params: { increment: 15 } },
      { code: "missing_or_invalid_time", field: "startTime" },
      { code: "invalid_first_date", field: "firstDate" },
    ])
  })

  it("keeps one local wall-clock time across timezone offset changes", () => {
    const proposal: RecurringProposal = {
      ...MONTHLY,
      firstDate: "2026-03-01",
      startTime: "09:00",
      recurrence: { cadence: "weekly", weekdays: { mode: "first_date_weekday" } },
      end: { mode: "count", occurrences: 3 },
    }
    const result = evaluateRecurrenceAvailability(proposal, [], "America/New_York", Date.parse("2026-02-01T00:00:00Z"))
    expect(result.kind).toBe("available")
    if (result.kind === "available")
      expect(result.occurrences.map((occurrence) => occurrence.start)).toEqual([
        "2026-03-01T14:00:00.000Z",
        "2026-03-08T13:00:00.000Z",
        "2026-03-15T13:00:00.000Z",
      ])
  })

  it("uses the whole-series branch at exactly fifty percent conflict", () => {
    const proposal: RecurringProposal = {
      ...MONTHLY,
      firstDate: "2026-08-03",
      recurrence: { cadence: "weekly", weekdays: { mode: "first_date_weekday" } },
      end: { mode: "count", occurrences: 2 },
    }
    const result = evaluateRecurrenceAvailability(
      proposal,
      [{ start: "2026-08-03T13:30:00.000Z", end: "2026-08-03T14:00:00.000Z" }],
      TIME_ZONE,
      Date.parse("2026-08-01T00:00:00Z"),
    )
    expect(result).toMatchObject({ kind: "common-alternative", localStartTime: "19:45" })
  })

  it("proposes a complete per-date adjustment batch below fifty percent conflict", () => {
    const proposal: RecurringProposal = {
      ...MONTHLY,
      firstDate: "2026-08-03",
      recurrence: { cadence: "weekly", weekdays: { mode: "first_date_weekday" } },
      end: { mode: "count", occurrences: 3 },
    }
    const result = evaluateRecurrenceAvailability(
      proposal,
      [{ start: "2026-08-10T13:30:00.000Z", end: "2026-08-10T14:00:00.000Z" }],
      TIME_ZONE,
      Date.parse("2026-08-01T00:00:00Z"),
    )
    expect(result).toMatchObject({
      kind: "adjustments",
      adjustments: [{ localDate: "2026-08-10", scheduled: { localStartTime: "19:45" } }],
    })
  })

  it("fails closed when a minority conflict has no same-day or common-series alternative", () => {
    const proposal: RecurringProposal = {
      ...MONTHLY,
      firstDate: "2026-08-03",
      recurrence: { cadence: "weekly", weekdays: { mode: "first_date_weekday" } },
      end: { mode: "count", occurrences: 3 },
    }
    expect(
      evaluateRecurrenceAvailability(
        proposal,
        [{ start: "2026-08-10T03:00:00.000Z", end: "2026-08-10T17:30:00.000Z" }],
        TIME_ZONE,
        Date.parse("2026-08-01T00:00:00Z"),
      ),
    ).toEqual({ kind: "conflict" })
  })

  it("projects a native bounded RRULE onto the managed parent only", () => {
    const expanded = expandRecurrence(MONTHLY)
    const available = evaluateRecurrenceAvailability(MONTHLY, [], TIME_ZONE, Date.parse("2025-12-01T00:00:00Z"))
    if (!("rrule" in expanded) || available.kind !== "available") throw new Error("expected an available recurrence")
    expect(
      managedRecurringEvent(
        { id: "series", requestId: "request" },
        MONTHLY,
        available.occurrences[0],
        expanded.rrule,
        available.reminderMinutes,
        TIME_ZONE,
      ),
    ).toMatchObject({
      id: "series",
      recurrence: [expanded.rrule],
      start: "2026-01-31T13:30:00.000Z",
    })
  })
})
