import { describe, expect, it } from "vitest"
import {
  type CalendarPlan,
  consumeCalendarOption,
  consumeCalendarPlan,
  createCalendarPlanLedger,
  issueCalendarOptions,
  issueCalendarPlan,
} from "../calendar-plan"

const PLAN: CalendarPlan = {
  kind: "one_off",
  proposal: {
    title: "Call Jamie",
    localDate: "2026-08-03",
    startTime: "19:00",
    durationMinutes: 30,
    dateIsExplicit: true,
    timeIsExplicit: true,
    classification: "ordinary",
    needsClarification: false,
  },
  scheduled: {
    start: "2026-08-03T13:30:00.000Z",
    end: "2026-08-03T14:00:00.000Z",
    localStartTime: "19:00",
    reminderMinutes: 10,
  },
}

describe("Calendar plan authorization", () => {
  it("rejects forged, stale, reused, expired, and superseded plan IDs", () => {
    const ledger = createCalendarPlanLedger()
    const first = issueCalendarPlan(ledger, PLAN, 1, 2_000, "first")

    expect(consumeCalendarPlan(ledger, "forged", 1, 1_000)).toEqual({ ok: false, reason: "forged" })
    expect(consumeCalendarPlan(ledger, first, 2, 1_000)).toEqual({ ok: false, reason: "stale" })

    const second = issueCalendarPlan(ledger, PLAN, 1, 2_000, "second")
    expect(consumeCalendarPlan(ledger, first, 1, 1_000)).toEqual({ ok: false, reason: "superseded" })
    expect(consumeCalendarPlan(ledger, second, 1, 1_000)).toEqual({ ok: true, plan: PLAN })
    expect(consumeCalendarPlan(ledger, second, 1, 1_000)).toEqual({ ok: false, reason: "reused" })

    const expired = issueCalendarPlan(ledger, PLAN, 2, 1_000, "expired")
    expect(consumeCalendarPlan(ledger, expired, 2, 1_000)).toEqual({ ok: false, reason: "expired" })
  })

  it("authorizes exactly one option from the current choice set", () => {
    const ledger = createCalendarPlanLedger()
    issueCalendarOptions(ledger, [PLAN, PLAN], 1, 2_000, ["first", "second"])

    expect(consumeCalendarOption(ledger, "first", 1, 1_000)).toEqual({ ok: true, plan: PLAN })
    expect(consumeCalendarOption(ledger, "first", 1, 1_000)).toEqual({ ok: false, reason: "reused" })
    expect(consumeCalendarOption(ledger, "second", 1, 1_000)).toEqual({ ok: false, reason: "superseded" })
  })
})
