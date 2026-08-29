import { describe, expect, it } from "vitest"
import { type MealPlanningAgentSessionResult, runMealPlanningAgentSession } from "../agent/meal-planning-session"
import { renderHouseholdContext } from "../meal-planning/agent-workflow"
import { loadScenarios } from "../meal-planning/corpus/load"
import type { MealGrid, MealPlanCandidate, MealPlanContext, MealPlanScenario } from "../meal-planning/types"
import { createGenerator, createToolProvider, type GenerateFn, type ToolConversationMessage } from "../providers"
import { messages, parseLLMJson, ToolProviderHttpError } from "../providers/llm"

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
const MAX_CLARIFY_LENGTH = 300
const WEEK_DAY_COUNT = 6
const SLOTS_PER_DAY = 5

// Eval debugging is a first-class feature: every test already dumps a full
// transcript (with provider reasoning) under EVAL_DEBUG=1, and vitest isolates
// a single scenario with `vitest run -t "<scenario name>"` — no separate
// debug scripts needed.
const evalDebug = process.env.EVAL_DEBUG === "1"
const MAX_LOG_SNIPPET = 1500

function renderMessage(message: ToolConversationMessage): string {
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

function dumpResult(result: MealPlanningAgentSessionResult): void {
  console.log(
    `=== RESULT: completed=${result.completed} terminal=${result.terminal?.kind} turns=${result.providerTurns} ===`,
  )
  console.log(`failureReason=${JSON.stringify(result.failureReason ?? null)}`)
  for (const message of result.messages) console.log(`---\n${renderMessage(message)}`)
  if (result.terminal?.kind === "propose_plan") {
    console.log("=== PROPOSAL justification ===")
    console.log(JSON.stringify(result.terminal.justification, null, 2))
    console.log("=== PROPOSAL feedbackItems ===")
    console.log(JSON.stringify(result.terminal.feedbackItems, null, 2))
    console.log("=== PROPOSAL easyBuys ===")
    console.log(JSON.stringify(result.terminal.candidate.easyBuys))
    console.log("=== PROPOSAL evaluation ===")
    console.log(JSON.stringify(result.terminal.evaluation, null, 2))
  }
}

/** One-shot LLM-as-a-judge: grades the plan on ONLY the rubric's properties, no tool loop. */
async function judgePlan(
  generator: GenerateFn,
  requestText: string,
  candidate: MealPlanCandidate,
  pantryBaseline: string[],
  rubric: string,
): Promise<{ pass: boolean; justification: string; reasons: string[] }> {
  const payload = JSON.stringify({
    easyBuys: candidate.easyBuys,
    pantryBaseline,
    grid: Object.fromEntries(
      Object.entries(candidate.grid).map(([day, slots]) => [
        day,
        Object.fromEntries(
          Object.entries(slots).map(([slot, cell]) => [slot, `${cell.dish} [${cell.items.join(", ")}]`]),
        ),
      ]),
    ),
  })
  const response = await generator(
    messages(
      'You are a strict but fair meal-plan grader. Read the parent\'s request and the generated plan, and judge ONLY the rubric\'s properties. Reply with JSON only: {"pass": boolean, "justification": string, "reasons": [string]}. The justification is a 1-3 sentence plain-language explanation of the verdict; reasons are short bullet-style strings for each rubric violation (empty when passing). Do not grade anything outside the rubric.',
      `Parent request: "${requestText}"\n\nPlan: ${payload}\n\nRUBRIC (judge only this):\n${rubric}`,
    ),
  )
  const parsed = parseLLMJson<{ pass?: boolean; justification?: string; reasons?: string[] }>(response.text ?? "")
  return { pass: parsed.pass === true, justification: parsed.justification ?? "", reasons: parsed.reasons ?? [] }
}

const C2_JUDGE_RUBRIC = `The parent says they have specific ingredients and asked for a week of school meals. The kitchen is stocked for most of the week, but the produce the parent lists is not in the inventory.
1. REPRESENTATION: every ingredient the parent says they have must be usable in the plan — present in the easyBuys list, in a dish's ingredients, or in the pantry baseline. Name any requested ingredient that is entirely missing.
2. EASY-BUY DEFINITION: easyBuys may contain only staples, all-season vegetables and fruits, and everyday neighborhood-grocery items. It must NOT contain dry fruits (dates, raisins, dry coconut), nuts, seeds, jaggery, paneer, or other specialty or long-shelf items. Name any violation.
3. SHORTNESS: the easyBuys list must be a short, purposeful list of the few ordinary ingredients being added — not the week's entire shopping list. Say whether it is over-stocked.
Pass only if all three hold. When in doubt, pass if there is no clear violation.`

/** Drives one real-provider session as the workflow does (context injected into the user message). */
async function runLive(context: MealPlanContext): Promise<MealPlanningAgentSessionResult> {
  const provider = createToolProvider(apiKey, providerName, model, PROVIDER_MAX_RETRIES)
  const userText =
    context.request.kind === "revision"
      ? `Revision feedback: ${(context.feedbackItems ?? []).map((item) => item.text).join(" ")}\n\n${renderHouseholdContext(context)}`
      : `Request: ${context.request.text}\n\n${renderHouseholdContext(context)}`
  try {
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: userText }], {
      context,
      ...(evalDebug ? { retainReasoning: true } : {}),
    })
    if (evalDebug) dumpResult(result)
    return result
  } catch (error) {
    if (error instanceof ToolProviderHttpError && error.providerMessage)
      throw new Error(`${error.message}: ${error.providerMessage}`)
    throw error
  }
}

/** Cheap one-shot text generator used by the LLM-as-a-judge checks. */
const generator = createGenerator(apiKey, providerName, model, PROVIDER_MAX_RETRIES)

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
    "C2: request-listed ingredients land in a short easy-buys list against a stocked kitchen (judge-graded)",
    async () => {
      const base = scenario("baseline-week").context
      const ctx: MealPlanContext = {
        ...base,
        // The request's produce (potato, tomato, onion, banana) is NOT stocked,
        // so the model must buy it; the dry-fruit/seeds snacks and the rest of
        // the week's staples ARE stocked, so easyBuys stays a short list.
        weeklyInventory: {
          items: base.weeklyInventory.items.filter((item) => item.name !== "banana"),
          notes: [],
        },
        request: {
          kind: "initial_plan",
          text: "Plan this week. We have rice, dal, potatoes, tomatoes, onions and bananas.",
        },
      }
      const terminal = requireProposal(await runLive(ctx))
      const verdict = await judgePlan(
        generator,
        ctx.request.text,
        terminal.candidate,
        ctx.profile.pantryBaseline,
        C2_JUDGE_RUBRIC,
      )
      console.log(
        `C2 judge: pass=${verdict.pass}\njustification: ${verdict.justification}\nreasons:\n${verdict.reasons.map((reason) => `  - ${reason}`).join("\n")}`,
      )
      expect(
        verdict.pass,
        `C2 judge justification:\n${verdict.justification}\n\nreasons:\n${verdict.reasons.join("\n")}`,
      ).toBe(true)
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
