import { describe, expect, it } from "vitest"
import { type MealPlanningAgentSessionResult, runMealPlanningAgentSession } from "../agent/meal-planning-session"
import { renderHouseholdContext } from "../meal-planning/agent-workflow"
import { loadScenarios } from "../meal-planning/corpus/load"
import type { MealGrid, MealPlanContext, MealPlanScenario } from "../meal-planning/types"
import { createToolProvider, type ToolConversationMessage } from "../providers"
import { ToolProviderHttpError } from "../providers/llm"

declare const process: { env: Record<string, string | undefined> }

const providerName = process.env.LIVE_PROVIDER ?? "deepseek"
const model = process.env.LIVE_MODEL ?? (providerName === "gemini" ? "gemini-3.7-flash" : "deepseek-v4-flash")
const apiKey =
  providerName === "gemini"
    ? (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? process.env.LLM_API_KEY ?? "")
    : (process.env.DEEPSEEK_API_KEY ?? process.env.LLM_API_KEY ?? "")
const enabled = (process.env.LIVE_CONTRACT === "1" || process.env.DEEPSEEK_CONTRACT === "1") && Boolean(apiKey)
// Each test is a real multi-turn session; thinking mode makes turns slower, so
// give each scenario a generous ceiling well inside the workflow's 30-min TTL.
const CONTRACT_TIMEOUT_MS = 600_000
// A live meal-planning session is up to 8 provider turns of a 30-cell nested schema.
const contractIt = enabled
  ? (name: string, fn: () => void | Promise<void>) => it(name, fn, CONTRACT_TIMEOUT_MS)
  : (name: string) => it.skip(name, () => {})

const scenario = (id: string): MealPlanScenario => {
  const found = loadScenarios().find((entry) => entry.id === id)
  if (!found) throw new Error(`missing scenario ${id}`)
  return found
}

const MAX_PROVIDER_TURNS = 8
const PROVIDER_MAX_RETRIES = 3
const MAX_EASY_BUYS = 5
const MAX_REQUESTED_EASY_BUYS = 8
const MAX_CLARIFY_LENGTH = 300
const WEEK_DAY_COUNT = 6
const SLOTS_PER_DAY = 5

/** Drives one real-provider session as the workflow does (context injected into the user message). */
async function runLive(context: MealPlanContext): Promise<MealPlanningAgentSessionResult> {
  const provider = createToolProvider(apiKey, providerName, model, PROVIDER_MAX_RETRIES)
  const userText =
    context.request.kind === "revision"
      ? `Revision feedback: ${(context.feedbackItems ?? []).map((item) => item.text).join(" ")}\n\n${renderHouseholdContext(context)}`
      : `Request: ${context.request.text}\n\n${renderHouseholdContext(context)}`
  try {
    return await runMealPlanningAgentSession(provider, [{ role: "user", text: userText }], { context })
  } catch (error) {
    if (error instanceof ToolProviderHttpError && error.providerMessage)
      throw new Error(`${error.message}: ${error.providerMessage}`)
    throw error
  }
}

function requireProposal(result: MealPlanningAgentSessionResult) {
  expect(result.completed, JSON.stringify(result.failureReason ?? null)).toBe(true)
  expect(result.terminal?.kind, "session must end in propose_plan").toBe("propose_plan")
  if (result.terminal?.kind !== "propose_plan") throw new Error("no proposal")
  expect(result.terminal.evaluation.pass, JSON.stringify(result.terminal.evaluation.failures)).toBe(true)
  expect(result.providerTurns).toBeLessThanOrEqual(MAX_PROVIDER_TURNS)
  return result.terminal
}

function assistantText(messages: ToolConversationMessage[]): string {
  return messages
    .filter((message) => message.role === "assistant" && "text" in message && message.text)
    .map((message) => ("text" in message ? message.text : ""))
    .join("\n")
}

function noOpaqueLeak(messages: ToolConversationMessage[]): void {
  const text = assistantText(messages)
  expect(text).not.toMatch(/fb-[a-z0-9]+|tg-\d+/)
}

function dishesBySlot(grid: MealGrid, day: string): Record<string, string> {
  const dayGrid = grid[day] ?? {}
  return Object.fromEntries(Object.entries(dayGrid).map(([slot, cell]) => [slot, cell?.dish ?? ""]))
}

describe("DeepSeek agent-centered meal-planning live contract", () => {
  contractIt(
    "B1/T01: builds a full plan from context alone (no re-asking) with policy outcomes and short easy-buys",
    async () => {
      const ctx = scenario("baseline-week").context
      const result = await runLive(ctx)
      const terminal = requireProposal(result)
      noOpaqueLeak(result.messages)

      const policyIds = new Set(ctx.customPolicies.map((policy) => policy.id))
      for (const id of policyIds) {
        expect(terminal.candidate.policyOutcomes[id], `policy ${id} needs a stored outcome`).toBeDefined()
      }
      expect(terminal.candidate.easyBuys.length).toBeLessThanOrEqual(MAX_EASY_BUYS)
      // B6: easy-buys are ingredient tokens, never dish names.
      const dishNames = new Set(
        Object.values(terminal.candidate.grid).flatMap((day) => Object.values(day).map((cell) => cell.dish)),
      )
      for (const buy of terminal.candidate.easyBuys) {
        expect(dishNames.has(buy), `easy-buy "${buy}" is a dish name`).toBe(false)
      }
    },
  )

  contractIt("C1: a full six-day (30-slot) week is produced within the turn budget", async () => {
    const ctx = scenario("sat-open-week").context
    const result = await runLive(ctx)
    const terminal = requireProposal(result)
    expect(Object.keys(terminal.candidate.grid)).toHaveLength(WEEK_DAY_COUNT)
    for (const day of Object.keys(terminal.candidate.grid)) {
      expect(Object.keys(terminal.candidate.grid[day])).toHaveLength(SLOTS_PER_DAY)
    }
  })

  contractIt("B3/B4: a two-item batched revision completes with both feedback items represented", async () => {
    const ctx = scenario("batched-feedback").context
    const result = await runLive(ctx)
    const terminal = requireProposal(result)
    const submittedIds = new Set((terminal.feedbackItems ?? []).map((item) => item.id))
    for (const item of ctx.feedbackItems ?? []) {
      expect(submittedIds.has(item.id), `feedback ${item.id} must be represented`).toBe(true)
    }
  })

  contractIt(
    "C2: request-listed ingredients are added to a short easy-buys list against an empty inventory",
    async () => {
      const base = scenario("baseline-week").context
      const ctx: MealPlanContext = {
        ...base,
        weeklyInventory: { items: [], notes: [] },
        request: {
          kind: "initial_plan",
          text: "Plan this week. We have rice, dal, potatoes, tomatoes, onions and bananas.",
        },
      }
      const terminal = requireProposal(await runLive(ctx))
      const itemsInPlan = new Set(terminal.candidate.easyBuys)
      for (const ingredient of ["rice", "dal", "bananas"]) {
        expect(itemsInPlan.has(ingredient), `${ingredient} must be in easy-buys`).toBe(true)
      }
      expect(terminal.candidate.easyBuys.length).toBeLessThanOrEqual(MAX_REQUESTED_EASY_BUYS)
    },
  )

  contractIt("T04: an ambiguous constraint produces one concise clarification instead of a guess", async () => {
    const base = scenario("baseline-week").context
    const ctx: MealPlanContext = { ...base, request: { kind: "initial_plan", text: "Tuesday will be difficult." } }
    const result = await runLive(ctx)
    expect(result.completed, JSON.stringify(result.failureReason ?? null)).toBe(true)
    expect(result.terminal?.kind).toBe("needs_clarification")
    if (result.terminal?.kind !== "needs_clarification") throw new Error("no clarification")
    expect(result.terminal.message.length).toBeLessThanOrEqual(MAX_CLARIFY_LENGTH)
    noOpaqueLeak(result.messages)
    expect(result.terminal.message).not.toMatch(/fb-[a-z0-9]+|tg-\d+/)
  })

  contractIt("R01/R04: scoped meal feedback changes the targeted cell and leaves untouched days stable", async () => {
    const ctx = scenario("midweek-shortage").context
    const recent = ctx.recentPlan
    if (!recent) throw new Error("midweek-shortage needs recentPlan")
    const terminal = requireProposal(await runLive(ctx))

    const target = ctx.feedbackItems?.[0]?.scope
    if (!target?.day || !target.slot) throw new Error("midweek-shortage needs a scoped feedback item")
    expect(terminal.candidate.grid[target.day][target.slot].dish).not.toBe(recent[target.day][target.slot].dish)
    for (const day of ["Mon", "Tue", "Wed", "Thu"]) {
      expect(dishesBySlot(terminal.candidate.grid, day), `${day} must stay stable`).toEqual(dishesBySlot(recent, day))
    }
  })
})
