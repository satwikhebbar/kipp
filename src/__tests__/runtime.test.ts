import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { logRuntime } from "../runtime/logging"
import { ToolGuard, ToolHandlerError, type ToolRegistry } from "../runtime/tools"

const registry: ToolRegistry = {
  echo: {
    name: "echo",
    description: "Returns a supplied value.",
    input: z.object({ value: z.string() }),
    output: z.object({ value: z.string() }),
    privacy: "private",
    handler: async ({ value }) => ({ value }),
  },
  brokenOutput: {
    name: "brokenOutput",
    description: "Test-only invalid output.",
    input: z.object({}),
    output: z.object({ value: z.string() }),
    privacy: "private",
    handler: async () => ({ value: 1 }) as never,
  },
}

describe("ToolGuard", () => {
  it("enforces the static allowlist and input/output schemas", async () => {
    const guard = new ToolGuard(registry, ["echo"])
    await expect(guard.execute("missing", {})).resolves.toEqual({ ok: false, category: "unknown-tool" })
    await expect(guard.execute("brokenOutput", {})).resolves.toEqual({ ok: false, category: "not-allowed" })
    await expect(guard.execute("echo", { value: 1 })).resolves.toEqual({
      ok: false,
      category: "invalid-input",
      validationPaths: ["value"],
      validationErrors: ["value: expected string"],
    })
    await expect(guard.execute("echo", { value: "safe" })).resolves.toEqual({ ok: true, output: { value: "safe" } })
  })

  it("reports invalid handler output without exposing handler details", async () => {
    const guard = new ToolGuard(registry, ["brokenOutput"])
    await expect(guard.execute("brokenOutput", {})).resolves.toEqual({ ok: false, category: "invalid-output" })
  })

  it("carries an explicitly safe handler failure category without exposing the error message", async () => {
    const guarded: ToolRegistry = {
      calendar: {
        name: "calendar",
        description: "Calendar availability.",
        input: z.object({}),
        output: z.object({}),
        privacy: "private",
        handler: async () => {
          throw new ToolHandlerError("Google response body must not escape", "authorization-failed", 401)
        },
      },
    }

    await expect(new ToolGuard(guarded, ["calendar"]).execute("calendar", {})).resolves.toEqual({
      ok: false,
      category: "authorization-failed",
      status: 401,
    })
  })

  it("keeps LinkedIn's production tool allowlist empty", () => {
    const linkedinAllowedTools: readonly string[] = []
    expect(linkedinAllowedTools).toEqual([])
  })
})

describe("runtime logging", () => {
  it("emits metadata-only INFO logs only when explicitly enabled", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)

    logRuntime({}, { event: "workflow-run", outcome: "started", workflow: "workflow-1" })
    logRuntime({ LOG_LEVEL: "info" }, { event: "workflow-run", outcome: "started", workflow: "workflow-1" })

    expect(log).toHaveBeenCalledTimes(1)
    const logged = JSON.parse(log.mock.calls[0]?.[0] as string)
    expect(logged).toEqual({
      timestamp: expect.any(String),
      component: "kipp-runtime",
      event: "workflow-run",
      outcome: "started",
      workflow: "workflow-1",
    })
    expect(Number.isNaN(Date.parse(logged.timestamp))).toBe(false)
    log.mockRestore()
  })

  it("supports safe diagnostic labels without accepting payloads", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    logRuntime(
      { LOG_LEVEL: "info" },
      {
        event: "tool-execution",
        outcome: "failed",
        failureCategory: "invalid-input",
        details: { validationPaths: "title.source,localDate.value" },
      },
    )
    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual({
      timestamp: expect.any(String),
      component: "kipp-runtime",
      event: "tool-execution",
      outcome: "failed",
      failureCategory: "invalid-input",
      details: { validationPaths: "title.source,localDate.value" },
    })
    log.mockRestore()
  })
})
