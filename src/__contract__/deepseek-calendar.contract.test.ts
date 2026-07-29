import { describe, expect, it, vi } from "vitest"
import type { Env } from "../types"

vi.mock("cloudflare:workers", () => {
  class WorkflowEntrypoint {
    env!: Env
  }
  return { WorkflowEntrypoint }
})

declare const process: { env: Record<string, string | undefined> }

const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.LLM_API_KEY
const enabled = process.env.DEEPSEEK_CONTRACT === "1" && Boolean(apiKey)
const contractIt = enabled ? it : it.skip

function environment(): Env {
  return {
    LLM_API_KEY: apiKey ?? "",
    LLM_PROVIDER: "deepseek",
    LLM_MODEL: "deepseek-v4-flash",
    LLM_MAX_RETRIES: "0",
    TIMEZONE: "Asia/Kolkata",
  } as Env
}

async function runContract(requestText: string) {
  const { planOneOff } = await import("../calendar-workflow")
  return planOneOff(environment(), requestText)
}

function expectSuccessfulHandoff(
  result: Awaited<ReturnType<typeof runContract>>,
  tool: "submit_one_off_proposal" | "request_clarification",
): void {
  expect(result).toMatchObject({ toolRunCompleted: true })
  expect(result.toolExecutions.filter((execution) => execution.outcome === "succeeded")).toEqual([
    { tool, outcome: "succeeded" },
  ])
}

describe("DeepSeek Calendar native-tool contract", () => {
  contractIt("returns a focused clarification through a handoff tool", async () => {
    const result = await runContract("Schedule a call with Jamie. The date and time are unknown.")
    expect(result.decision).toMatchObject({ kind: "clarification" })
    expectSuccessfulHandoff(result, "request_clarification")
  })

  contractIt("returns an explicit proposal through a handoff tool", async () => {
    const result = await runContract("Schedule a 15-minute professional call with Jamie on 2026-08-03 at 10:30.")
    expect(result.decision).toMatchObject({
      kind: "proposal",
      proposal: { localDate: "2026-08-03", startTime: "10:30", durationMinutes: 15 },
    })
    expectSuccessfulHandoff(result, "submit_one_off_proposal")
  })

  contractIt("submits an untimed proposal for deterministic availability selection", async () => {
    const result = await runContract("Schedule a 30-minute call with Jamie on 2026-08-03.")
    expect(result.decision).toMatchObject({
      kind: "proposal",
      proposal: { localDate: "2026-08-03", durationMinutes: 30 },
    })
    expect(result.decision?.kind === "proposal" ? result.decision.proposal.startTime : undefined).toBeUndefined()
    expectSuccessfulHandoff(result, "submit_one_off_proposal")
  })
})
