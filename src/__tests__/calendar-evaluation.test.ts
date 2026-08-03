import { describe, expect, it, vi } from "vitest"
import { evaluateCalendarCandidate } from "../calendar-evaluation"
import { createCalendarPlanLedger } from "../calendar-plan"

const CONTEXT = {
  getBusyIntervals: vi.fn().mockResolvedValue([]),
  ledger: createCalendarPlanLedger(),
  version: 1,
  expiresAt: Date.parse("2026-08-04T00:00:00.000Z"),
  timeZone: "Asia/Kolkata",
  now: Date.parse("2026-08-01T00:00:00.000Z"),
}

describe("Calendar candidate evaluation", () => {
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
          startTime: "19:00",
          timeIsExplicit: true,
          durationMinutes: 30,
          classification: "ordinary",
          recurrence: { cadence: "weekly", weekdays: { mode: "first_date_weekday" } },
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
})
