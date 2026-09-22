import { describe, expect, it, vi } from "vitest"
import type { Env } from "../core/types"
import { logProviderRequestEvent } from "../meal-planning/agent-workflow"

describe("meal-planning provider request log", () => {
  it("surfaces protocol-failure diagnostics without attaching the provider payload", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      logProviderRequestEvent({ LOG_LEVEL: "info" } as Env, "wf-1", {
        phase: "failed",
        durationMs: 19_528,
        status: 200,
        failureCategory: "malformed-tool-arguments",
        finishReason: "length",
        choicesCount: 1,
        toolCallNames: ["evaluate_meal_plan"],
        argumentsCharacters: 36_111,
        argumentsParseReason: "truncated-json",
      })
      const line = JSON.parse(String(log.mock.calls[0]?.[0]))
      expect(line).toMatchObject({
        event: "meal-planning-provider-request",
        outcome: "failed",
        failureCategory: "malformed-tool-arguments",
        details: {
          phase: "failed",
          status: 200,
          finishReason: "length",
          argumentsParseReason: "truncated-json",
          toolCallNames: "evaluate_meal_plan",
        },
        metrics: { choicesCount: 1, argumentsCharacters: 36_111 },
      })
      expect(log).toHaveBeenCalledTimes(1)
    } finally {
      log.mockRestore()
    }
  })

  it("omits absent diagnostics and stays silent below info level", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      logProviderRequestEvent({ LOG_LEVEL: "info" } as Env, "wf-1", { phase: "dispatched", durationMs: 0 })
      const line = JSON.parse(String(log.mock.calls[0]?.[0]))
      expect(line).toMatchObject({ outcome: "started", details: { phase: "dispatched" } })
      expect(line.details).not.toHaveProperty("finishReason")

      log.mockClear()
      logProviderRequestEvent({ LOG_LEVEL: undefined } as Env, "wf-1", { phase: "dispatched", durationMs: 0 })
      expect(log).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  })
})
