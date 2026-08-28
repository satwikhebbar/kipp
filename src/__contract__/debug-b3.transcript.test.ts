import { it } from "vitest"
import { runMealPlanningAgentSession } from "../agent/meal-planning-session"
import { renderHouseholdContext } from "../meal-planning/agent-workflow"
import { loadScenarios } from "../meal-planning/corpus/load"
import { createToolProvider, type ToolConversationMessage } from "../providers"

declare const process: { env: Record<string, string | undefined> }

const providerName = "deepseek"
const model = process.env.LIVE_MODEL ?? "deepseek-v4-flash"
const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.LLM_API_KEY ?? ""

const enabled = process.env.DEEPSEEK_CONTRACT === "1" && Boolean(apiKey)

const itNow = enabled ? it : it.skip
const MAX_LOG_SNIPPET = 1500
const DEBUG_TIMEOUT_MS = 600_000

function render(message: ToolConversationMessage): string {
  switch (message.role) {
    case "user":
      return `USER: ${message.text}`
    case "tool":
      return `TOOL(${message.toolCallId}) ${JSON.stringify(message.output).slice(0, MAX_LOG_SNIPPET)}`
    case "assistant": {
      const calls =
        "toolCalls" in message && message.toolCalls
          ? message.toolCalls.map((call) => `  ${call.name}(${JSON.stringify(call.input)})`).join("\n")
          : ""
      const reasoning =
        "reasoningContent" in message && message.reasoningContent ? `REASONING:\n${message.reasoningContent}` : ""
      return `ASSISTANT${reasoning ? " (with reasoning)" : ""}:\n${calls}${reasoning ? `\n${reasoning}` : ""}`
    }
    default:
      return `SYSTEM: ${message.text}`
  }
}

itNow(
  "debug B3 transcript",
  async () => {
    const provider = createToolProvider(apiKey, providerName, model, 0)
    const ctx = loadScenarios().find((entry) => entry.id === "batched-feedback")?.context
    if (!ctx) throw new Error("missing batched-feedback scenario")
    const userText =
      ctx.request.kind === "revision"
        ? `Revision feedback: ${(ctx.feedbackItems ?? []).map((item) => item.text).join(" ")}\n\n${renderHouseholdContext(ctx)}`
        : `Request: ${ctx.request.text}\n\n${renderHouseholdContext(ctx)}`
    console.log("=== USER MESSAGE ===")
    console.log(userText)
    console.log("=== FEEDBACK ITEMS ===")
    for (const item of ctx.feedbackItems ?? []) console.log(JSON.stringify(item))
    console.log("=== RECENT PLAN (first 6 days, dishes) ===")
    const grid = ctx.recentPlan?.grid ?? {}
    for (const [day, slots] of Object.entries(grid)) {
      console.log(day, Object.fromEntries(Object.entries(slots).map(([slot, cell]) => [slot, cell.dish])))
    }
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: userText }], {
      context: ctx,
      retainReasoning: true,
    })
    console.log(
      `=== RESULT: completed=${result.completed} terminal=${result.terminal?.kind} turns=${result.providerTurns} ===`,
    )
    console.log(`failureReason=${JSON.stringify(result.failureReason ?? null)}`)
    for (const message of result.messages) console.log(`---\n${render(message)}`)
    if (result.terminal?.kind === "propose_plan") {
      console.log("=== PROPOSAL justification ===")
      console.log(JSON.stringify(result.terminal.justification, null, 2))
      console.log("=== PROPOSAL feedbackItems ===")
      console.log(JSON.stringify(result.terminal.feedbackItems, null, 2))
      console.log("=== PROPOSAL easyBuys ===")
      console.log(JSON.stringify(result.terminal.candidate.easyBuys))
    }
  },
  DEBUG_TIMEOUT_MS,
)
