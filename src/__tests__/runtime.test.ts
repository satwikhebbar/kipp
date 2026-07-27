import { describe, expect, it } from "vitest"
import { z } from "zod"
import { ToolGuard, type ToolRegistry } from "../runtime/tools"

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
    await expect(guard.execute("echo", { value: 1 })).resolves.toEqual({ ok: false, category: "invalid-input" })
    await expect(guard.execute("echo", { value: "safe" })).resolves.toEqual({ ok: true, output: { value: "safe" } })
  })

  it("reports invalid handler output without exposing handler details", async () => {
    const guard = new ToolGuard(registry, ["brokenOutput"])
    await expect(guard.execute("brokenOutput", {})).resolves.toEqual({ ok: false, category: "invalid-output" })
  })

  it("keeps LinkedIn's production tool allowlist empty", () => {
    const linkedinAllowedTools: readonly string[] = []
    expect(linkedinAllowedTools).toEqual([])
  })
})
