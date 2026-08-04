import { describe, expect, it, vi } from "vitest"
import { runCalendarAgentSession } from "../agent/calendar-session"
import { createCalendarPlanLedger } from "../calendar-plan"
import type { ToolConversationMessage, ToolProviderClient } from "../providers"

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

function toolOutput(messages: ToolConversationMessage[], name: string): Record<string, unknown> {
  const message = [...messages].reverse().find((candidate) => candidate.role === "tool" && candidate.name === name)
  if (message?.role !== "tool") throw new Error(`Missing ${name} output`)
  return (message.output as { ok: true; output: Record<string, unknown> }).output
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

  it("repairs a dropped explicit occurrence count before issuing a plan", async () => {
    const proposal = {
      title: "Substack metrics review",
      firstDate: "2026-08-08",
      dateIsExplicit: true,
      startTime: "09:00",
      timeIsExplicit: true,
      durationMinutes: 30,
      classification: "ordinary",
      recurrence: { cadence: "biweekly" },
      recurrenceIsExplicit: true,
    }
    let turn = 0
    const provider: ToolProviderClient = {
      generate: vi.fn(async ({ messages }) => {
        turn++
        if (turn === 1)
          return {
            toolCalls: [
              {
                id: "dropped-count",
                name: "evaluate_calendar_candidate",
                input: { kind: "recurring", proposal: { ...proposal, end: { mode: "default_horizon" } } },
              },
            ],
            usage: { inputTokens: 0, outputTokens: 0 },
          }
        if (turn === 2)
          return {
            toolCalls: [
              {
                id: "preserved-count",
                name: "evaluate_calendar_candidate",
                input: { kind: "recurring", proposal: { ...proposal, end: { mode: "count", occurrences: 6 } } },
              },
            ],
            usage: { inputTokens: 0, outputTokens: 0 },
          }
        return {
          toolCalls: [
            {
              id: "ready",
              name: "ready_to_create",
              input: { planId: toolOutput(messages, "evaluate_calendar_candidate").planId },
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
        }
      }),
    }

    const sessionOptions = options()
    const result = await runCalendarAgentSession(
      provider,
      [
        { role: "user", text: "Schedule a recurring review of Substack metrics" },
        { role: "user", text: "Saturday, 9AM, biweekly, 30min, 6 times" },
      ],
      sessionOptions,
    )

    expect(result.terminal).toMatchObject({ kind: "ready_to_create" })
    expect(result.toolExecutions).toContainEqual(
      expect.objectContaining({
        tool: "evaluate_calendar_candidate",
        outcome: "failed",
        failureCategory: "invalid-input",
      }),
    )
    expect(sessionOptions.evaluation.getBusyIntervals).toHaveBeenCalledOnce()
  })

  it("repairs a choice handoff that exposes its opaque option ID", async () => {
    let turn = 0
    const provider: ToolProviderClient = {
      generate: vi.fn(async ({ messages }) => {
        turn++
        if (turn === 1)
          return {
            toolCalls: [
              {
                id: "evaluate",
                name: "evaluate_calendar_candidate",
                input: {
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
                    end: { mode: "count", occurrences: 3 },
                  },
                },
              },
            ],
            usage: { inputTokens: 0, outputTokens: 0 },
          }
        const evaluation = toolOutput(messages, "evaluate_calendar_candidate") as {
          issues: Array<{ code: string }>
          options: Array<{ optionId: string }>
        }
        const optionId = evaluation.options[0]?.optionId as string
        return {
          toolCalls: [
            {
              id: `choice-${turn}`,
              name: "needs_user_input",
              input: {
                message:
                  turn === 2
                    ? `Option ID ${optionId} moves the conflicting occurrence.`
                    : "The first occurrence conflicts. I can move only that date to 7:45 PM. Choose a button below.",
                reasonCodes: evaluation.issues.map((issue) => issue.code),
                interaction: { kind: "options", optionIds: evaluation.options.map((option) => option.optionId) },
              },
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
        }
      }),
    }
    const sessionOptions = options()
    sessionOptions.evaluation.getBusyIntervals.mockResolvedValue([
      { start: "2026-08-04T13:30:00.000Z", end: "2026-08-04T14:00:00.000Z" },
    ])

    const result = await runCalendarAgentSession(
      provider,
      [{ role: "user", text: "Schedule a weekly review" }],
      sessionOptions,
    )

    expect(result.terminal).toMatchObject({
      kind: "needs_user_input",
      message: expect.not.stringContaining("Option ID"),
      reasonCodes: ["requested_time_conflicts"],
    })
    expect(result.toolExecutions).toContainEqual(
      expect.objectContaining({ tool: "needs_user_input", outcome: "failed", failureCategory: "invalid-state" }),
    )
    const firstRequest = vi.mocked(provider.generate).mock.calls[0]?.[0]
    expect(firstRequest?.messages[0]).toEqual(
      expect.objectContaining({
        role: "system",
        text: expect.stringContaining("option IDs must never appear in the human-facing message"),
      }),
    )
  })
})
