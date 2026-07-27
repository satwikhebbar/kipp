import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { MAX_TOOL_CALLS, runTools } from "../runtime/tool-runner"
import type { ToolRegistry } from "../runtime/tools"

describe("runTools", () => {
  const registry: ToolRegistry = {
    echo: {
      name: "echo",
      description: "Echo",
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      privacy: "private",
      handler: async ({ value }) => ({ value }),
    },
  }

  it("executes only allowlisted, schema-checked calls in a serial conversation", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({
        toolCalls: [{ id: "one", name: "echo", input: { value: "hello" } }],
        usage: { inputTokens: 0, outputTokens: 0 },
      })
      .mockResolvedValueOnce({ text: "done", usage: { inputTokens: 0, outputTokens: 0 } })
    const result = await runTools({ generate }, registry, ["echo"], [{ role: "user", text: "start" }])
    expect(result).toMatchObject({ completed: true, finalText: "done" })
    expect(result.messages).toContainEqual({
      role: "tool",
      toolCallId: "one",
      name: "echo",
      output: { ok: true, output: { value: "hello" } },
    })
  })

  it("stops before calls exceed the fixed workflow limit", async () => {
    const calls = Array.from({ length: MAX_TOOL_CALLS + 1 }, (_, index) => ({
      id: String(index),
      name: "echo",
      input: { value: "x" },
    }))
    const generate = vi.fn().mockResolvedValue({ toolCalls: calls, usage: { inputTokens: 0, outputTokens: 0 } })
    await expect(runTools({ generate }, registry, ["echo"], [{ role: "user", text: "start" }])).resolves.toMatchObject({
      completed: false,
    })
  })
})
