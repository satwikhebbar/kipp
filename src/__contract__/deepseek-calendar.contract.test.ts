import { describe, expect, it } from "vitest"
import { runCalendarAgentSession } from "../agent/calendar-session"
import { createCalendarPlanLedger } from "../calendar-plan"
import { createToolProvider } from "../providers"
import { ToolProviderHttpError } from "../providers/llm"

declare const process: { env: Record<string, string | undefined> }

const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.LLM_API_KEY
const enabled = process.env.DEEPSEEK_CONTRACT === "1" && Boolean(apiKey)
const contractIt = enabled ? it : it.skip
const NOW = Date.parse("2026-08-01T00:00:00.000Z")
const CONTRACT_TTL_MS = 900_000

async function runContract(requestText: string) {
  const provider = createToolProvider(apiKey ?? "", "deepseek", "deepseek-v4-flash", 0)
  try {
    return await runCalendarAgentSession(provider, [{ role: "user", text: requestText }], {
      calendar: { listEvents: async () => ({ events: [], truncated: false }) },
      evaluation: {
        getBusyIntervals: async () => [],
        ledger: createCalendarPlanLedger(),
        version: 1,
        expiresAt: NOW + CONTRACT_TTL_MS,
        timeZone: "Asia/Kolkata",
        now: NOW,
      },
    })
  } catch (error) {
    if (error instanceof ToolProviderHttpError && error.providerMessage)
      throw new Error(`${error.message}: ${error.providerMessage}`)
    throw error
  }
}

describe("DeepSeek agent-centered Calendar native-tool contract", () => {
  contractIt("returns a focused clarification through needs_user_input", async () => {
    const result = await runContract(
      "Current instant: 2026-08-01T00:00:00Z. Calendar time zone: Asia/Kolkata. Schedule a call with Jamie; the date and time are unknown.",
    )

    expect(result.completed).toBe(true)
    expect(result.terminal).toMatchObject({ kind: "needs_user_input", interaction: { kind: "reply" } })
    expect(result.toolNames.at(-1)).toBe("needs_user_input")
  })

  contractIt("does not invent a first date or cadence for an underspecified recurrence", async () => {
    const result = await runContract(
      "Current instant: 2026-08-03T14:09:51Z. Calendar time zone: Asia/Kolkata. Schedule a recurring review.",
    )

    expect(result.completed).toBe(true)
    expect(result.terminal).toMatchObject({ kind: "needs_user_input", interaction: { kind: "reply" } })
    expect(result.toolNames.at(-1)).toBe("needs_user_input")
    expect(result.toolNames).not.toContain("ready_to_create")
  })

  contractIt("evaluates and authorizes an explicit one-off proposal", async () => {
    const result = await runContract(
      "Current instant: 2026-08-01T00:00:00Z. Calendar time zone: Asia/Kolkata. Schedule a 15-minute professional call with Jamie on 2026-08-03 at 10:30.",
    )

    expect(result.completed).toBe(true)
    expect(result.terminal).toMatchObject({ kind: "ready_to_create" })
    expect(result.toolNames).toEqual(["evaluate_calendar_candidate", "ready_to_create"])
  })

  contractIt("submits an untimed candidate for deterministic availability selection", async () => {
    const result = await runContract(
      "Current instant: 2026-08-01T00:00:00Z. Calendar time zone: Asia/Kolkata. Schedule a 30-minute call with Jamie on 2026-08-03; choose a policy-safe time.",
    )

    expect(result.completed).toBe(true)
    expect(result.terminal).toMatchObject({ kind: "ready_to_create" })
    expect([
      ["evaluate_calendar_candidate", "ready_to_create"],
      ["list_calendar_events", "evaluate_calendar_candidate", "ready_to_create"],
    ]).toContainEqual(result.toolNames)
  })

  contractIt("classifies and authorizes a supported recurrence without raw RRULE input", async () => {
    const result = await runContract(
      "Current instant: 2026-08-01T00:00:00Z. Calendar time zone: Asia/Kolkata. Schedule a 30-minute weekly review every Monday and Wednesday at 19:00, starting 2026-08-03, for 6 occurrences.",
    )

    expect(result.completed).toBe(true)
    expect(result.terminal).toMatchObject({ kind: "ready_to_create" })
    expect(result.toolNames).toEqual(["evaluate_calendar_candidate", "ready_to_create"])
  })
})
