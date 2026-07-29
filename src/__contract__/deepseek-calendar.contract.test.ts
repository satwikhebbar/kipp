import { describe, expect, it } from "vitest"
import { z } from "zod"
import { createToolProvider } from "../providers"
import { runTools } from "../runtime/tool-runner"
import type { ToolRegistry } from "../runtime/tools"

declare const process: { env: Record<string, string | undefined> }

const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.LLM_API_KEY
const enabled = process.env.DEEPSEEK_CONTRACT === "1" && Boolean(apiKey)
const contractIt = enabled ? it : it.skip
const handoffTools = ["submit_one_off_proposal", "request_clarification"]
const source = z.enum(["explicit", "inferred"])
const sourced = <Value extends z.ZodTypeAny>(value: Value) => z.object({ value, source })

function registry(): ToolRegistry {
  return {
    get_available_slots: {
      name: "get_available_slots",
      description: "Return safe free start-time candidates. No event details are available.",
      input: z.object({ localDate: z.string(), durationMinutes: z.number().int() }),
      output: z.object({ slots: z.array(z.string()) }),
      privacy: "private",
      handler: async () => ({ slots: ["17:00"] }),
    },
    submit_one_off_proposal: {
      name: "submit_one_off_proposal",
      description: "Submit a single Calendar proposal without writing to Calendar.",
      input: z.object({
        title: sourced(z.string()),
        localDate: sourced(z.string()),
        startTime: sourced(z.string()),
        durationMinutes: sourced(z.number().int()),
        classification: sourced(
          z.enum(["ordinary", "family-social", "school-pickup", "appointment", "maintenance", "physical"]),
        ),
      }),
      output: z.object({ accepted: z.literal(true) }),
      privacy: "private",
      handler: async () => ({ accepted: true }),
    },
    request_clarification: {
      name: "request_clarification",
      description: "Ask one focused question for a missing scheduling detail.",
      input: z.object({ message: z.string() }),
      output: z.object({ accepted: z.literal(true) }),
      privacy: "private",
      handler: async () => ({ accepted: true }),
    },
  }
}

async function runContract(prompt: string) {
  const tools = registry()
  return runTools(
    createToolProvider(apiKey ?? "", "deepseek", "deepseek-v4-flash", 0),
    tools,
    {
      allowedTools: ["get_available_slots", ...handoffTools],
      handoffTools,
      maxToolCallsPerTurn: 1,
      reasoning: "disabled",
      toolChoice: "required",
      nextAllowedTools: (executed) => (executed.includes("get_available_slots") ? handoffTools : Object.keys(tools)),
    },
    [
      {
        role: "system",
        text: "Use native tools only. Call exactly one decision action: submit_one_off_proposal or request_clarification. Proposal fields are objects with value and source, where source is explicit or inferred.",
      },
      { role: "user", text: prompt },
    ],
  )
}

describe("DeepSeek Calendar native-tool contract", () => {
  contractIt("returns a focused clarification through a handoff tool", async () => {
    const result = await runContract("Schedule a call with Jamie. The date and time are unknown.")
    expect(result).toMatchObject({ completed: true, toolNames: ["request_clarification"] })
  })

  contractIt("returns an explicit proposal through a handoff tool", async () => {
    const result = await runContract("Schedule a 15-minute professional call with Jamie on 2026-08-03 at 10:30.")
    expect(result).toMatchObject({ completed: true, toolNames: ["submit_one_off_proposal"] })
  })

  contractIt("uses availability once and then a handoff tool", async () => {
    const result = await runContract(
      "Schedule a 30-minute call with Jamie on 2026-08-03. You must call get_available_slots before choosing a time.",
    )
    expect(result).toMatchObject({ completed: true, toolNames: ["get_available_slots", "submit_one_off_proposal"] })
  })
})
