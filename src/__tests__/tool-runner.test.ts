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
    const result = await runTools({ generate }, registry, { allowedTools: ["echo"] }, [{ role: "user", text: "start" }])
    expect(result).toMatchObject({ completed: true, finalText: "done" })
    expect(result.messages).toContainEqual({
      role: "tool",
      toolCallId: "one",
      name: "echo",
      output: { ok: true, output: { value: "hello" } },
    })
    expect(result.toolExecutions).toEqual([{ tool: "echo", outcome: "succeeded" }])
  })

  it("summarizes guard failures without exposing tool input or output", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({
        toolCalls: [{ id: "bad", name: "missing", input: { secret: "do not log" } }],
        usage: {},
      })
      .mockResolvedValueOnce({ text: "done", usage: {} })

    const result = await runTools({ generate }, registry, { allowedTools: ["echo"] }, [{ role: "user", text: "start" }])

    expect(result.toolExecutions).toEqual([{ tool: "unknown", outcome: "failed", failureCategory: "unknown-tool" }])
  })

  it("stops before calls exceed the fixed workflow limit", async () => {
    const calls = Array.from({ length: MAX_TOOL_CALLS + 1 }, (_, index) => ({
      id: String(index),
      name: "echo",
      input: { value: "x" },
    }))
    const generate = vi.fn().mockResolvedValue({ toolCalls: calls, usage: { inputTokens: 0, outputTokens: 0 } })
    await expect(
      runTools({ generate }, registry, { allowedTools: ["echo"] }, [{ role: "user", text: "start" }]),
    ).resolves.toMatchObject({ completed: false })
  })

  it("stops after a handoff tool without an unnecessary provider follow-up", async () => {
    const generate = vi.fn().mockResolvedValue({
      toolCalls: [{ id: "one", name: "echo", input: { value: "hello" } }],
      usage: { inputTokens: 0, outputTokens: 0 },
    })

    const result = await runTools(
      { generate },
      registry,
      { allowedTools: ["echo"], handoffTools: ["echo"], toolChoice: "required", reasoning: "disabled" },
      [{ role: "user", text: "start" }],
    )

    expect(result).toMatchObject({ completed: true, providerTurns: 1, toolCallCount: 1 })
    expect(generate).toHaveBeenCalledOnce()
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ tools: [registry.echo], toolChoice: "required", reasoning: "disabled" }),
    )
  })

  it("narrows the next turn to handoff tools after an availability action", async () => {
    const availability = {
      ...registry.echo,
      name: "availability",
    }
    const proposal = {
      ...registry.echo,
      name: "proposal",
    }
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ toolCalls: [{ id: "one", name: "availability", input: { value: "x" } }], usage: {} })
      .mockResolvedValueOnce({ toolCalls: [{ id: "two", name: "proposal", input: { value: "x" } }], usage: {} })

    await runTools(
      { generate },
      { availability, proposal },
      {
        allowedTools: ["availability", "proposal"],
        handoffTools: ["proposal"],
        maxToolCallsPerTurn: 1,
        toolChoice: "required",
        nextAllowedTools: () => ["proposal"],
      },
      [{ role: "user", text: "start" }],
    )

    expect(generate.mock.calls[1][0]).toEqual(expect.objectContaining({ tools: [proposal], toolChoice: "required" }))
  })
})
