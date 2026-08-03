import { describe, expect, it, vi } from "vitest"
import { runCalendarAgentSession } from "../agent/calendar-session"
import { createCalendarPlanLedger } from "../calendar-plan"
import type { ToolProviderClient } from "../providers"

function providerWith(...responses: Awaited<ReturnType<ToolProviderClient["generate"]>>[]): ToolProviderClient {
  return { generate: vi.fn().mockImplementation(async () => responses.shift()) }
}

function options() {
  return {
    calendar: { listEvents: vi.fn() },
    evaluation: {
      getBusyIntervals: vi.fn().mockResolvedValue([]),
      ledger: createCalendarPlanLedger(),
      version: 1,
      expiresAt: Date.parse("2026-08-04T00:00:00.000Z"),
      timeZone: "Asia/Kolkata",
      now: Date.parse("2026-08-01T00:00:00.000Z"),
    },
  }
}

describe("bounded Calendar agent session", () => {
  it("accepts ready_to_create only for the plan issued by the current evaluation", async () => {
    const provider = providerWith(
      {
        toolCalls: [
          {
            id: "evaluate",
            name: "evaluate_calendar_candidate",
            input: {
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
            },
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      {
        toolCalls: [{ id: "ready", name: "ready_to_create", input: { planId: "forged" } }],
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      {
        toolCalls: [{ id: "ready-again", name: "ready_to_create", input: { planId: "forged" } }],
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    )

    const result = await runCalendarAgentSession(provider, [{ role: "user", text: "Call Jamie" }], options())

    expect(result.terminal).toBeNull()
    expect(result.toolExecutions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: "ready_to_create", outcome: "failed", failureCategory: "invalid-state" }),
      ]),
    )
  })

  it("requires one needs_user_input handoff to include every evaluated issue", async () => {
    const malformed = {
      kind: "one_off",
      proposal: {
        title: " ",
        localDate: "",
        startTime: "bad",
        durationMinutes: 20,
        dateIsExplicit: false,
        timeIsExplicit: true,
        classification: "ordinary",
        needsClarification: true,
      },
    }
    const provider = providerWith(
      {
        toolCalls: [{ id: "evaluate", name: "evaluate_calendar_candidate", input: malformed }],
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      {
        toolCalls: [
          {
            id: "ask",
            name: "needs_user_input",
            input: {
              message: "What date?",
              reasonCodes: ["missing_date"],
              interaction: { kind: "reply" },
            },
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      {
        toolCalls: [
          {
            id: "complete-ask",
            name: "needs_user_input",
            input: {
              message: "Please provide a title, date, valid time, and duration in 15-minute increments.",
              reasonCodes: ["missing_date", "invalid_title", "invalid_duration_increment", "missing_or_invalid_time"],
              interaction: { kind: "reply" },
            },
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    )

    const result = await runCalendarAgentSession(provider, [{ role: "user", text: "Schedule it" }], options())

    expect(result.terminal).toMatchObject({
      kind: "needs_user_input",
      reasonCodes: expect.arrayContaining(["missing_date", "invalid_title", "missing_or_invalid_time"]),
    })
    expect(result.providerTurns).toBe(3)
  })
})
