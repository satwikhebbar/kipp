import { describe, expect, it } from "vitest"
import { type MealPlanningAgentSessionResult, runMealPlanningAgentSession } from "../agent/meal-planning-session"
import { renderHouseholdContext } from "../meal-planning/agent-workflow"
import { loadScenarios } from "../meal-planning/corpus/load"
import type { MealCell, MealGrid, MealPlanCandidate, MealPlanContext, MealPlanScenario } from "../meal-planning/types"
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
// Scenarios are independent sessions, so run them concurrently (2-3 at a time
// keeps the eval wall-clock down; each test still retries provider hiccups).
const contractIt = enabled
  ? (name: string, fn: () => void | Promise<void>) => it.concurrent(name, fn, CONTRACT_TIMEOUT_MS)
  : (name: string) => it.skip(name, () => {})

const scenario = (id: string): MealPlanScenario => {
  const found = loadScenarios().find((entry) => entry.id === id)
  if (!found) throw new Error(`missing scenario ${id}`)
  return found
}

const MAX_PROVIDER_TURNS = 8
const PROVIDER_MAX_RETRIES = 3
// Mirror of the agent-facing prompt policy: at most 10 easy buys a week,
// more only when the inventory cannot support a plausible plan. The judge
// (C2/T07) decides "easy to buy", the cap guards the "not the whole shopping
// list" clause on normal weeks.
const MAX_EASY_BUYS = 10
const MAX_CLARIFY_LENGTH = 500
const WEEK_DAY_COUNT = 6
const SLOTS_PER_DAY = 5
const MORNING_BUDGET_MINUTES = 35
// Cook minutes used to build the T12 prior-week grid (mirrors the seed schedule).
const BREAKFAST_COOK_MIN = 15
const MAIN_COOK_MIN = 20
const SNACK_COOK_MIN = 0

// Eval debugging is a first-class feature and ON BY DEFAULT for contract runs:
// every test dumps a full transcript (with provider reasoning) plus the
// terminal details, so a failed run carries everything needed without a
// re-run. Set EVAL_DEBUG=0 to silence. A single scenario still runs isolated
// via `vitest run -t "<scenario name>"` — no separate debug scripts needed.
const evalDebug = enabled && process.env.EVAL_DEBUG !== "0"
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
          Object.entries(slots).map(([slot, cell]) => [
            slot,
            `${cell.dish} [${cell.items.join(", ")}] (cook ${cell.cookMinutes})`,
          ]),
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

const T04_JUDGE_RUBRIC = `The parent's only instruction was "Tuesday will be difficult." The agent produced a full plan.
Judge only this: the plan must reflect a sensible reading of the difficulty from the parent/cook's perspective. In particular, Tuesday's morning cooking should be kept light — fewer minutes than other days, or an obvious quick/no-cook arrangement — and the plan must otherwise be complete and reasonable. A passing plan acknowledges the difficulty in a way that genuinely makes Tuesday easier. Name any problem.`

const T07_JUDGE_RUBRIC = `The parent said they ONLY have onions, tomatoes, potatoes, rice, atta, dal and bananas, and asked for a full week of school meals.
1. INVENTORY-USE: the plan should build on those seven items wherever reasonable — they should appear across the week rather than being ignored in favour of purchased ingredients.
2. EASY-BUYS: anything purchased must be an ordinary, easy-to-find staple, all-season vegetable or fruit, or everyday neighborhood-grocery item — never dry fruits, nuts, seeds, paneer, or other specialty/long-shelf items.
3. SIZING: the list must be a purposeful list of what this week genuinely needs given how little is in the kitchen — not padded, and not a huge one-shot stock-up. A scarce kitchen justifies more buys than a stocked one, so judge size relative to the week, not against a fixed number.
Pass only if all three hold. When in doubt, pass if there is no clear violation.`

// T12 cross-week variety rubric. The prior week is fixed by the scenario; its
// cooked dishes and principal ingredients are spelled out so the judge can
// compare without needing the recent plan passed in.
const T12_JUDGE_RUBRIC = `The family already planned and cooked the previous week, whose dishes were: paratha, poha, upma, bottle gourd dal, rajma, khichdi, chole, and rice and beans, plus fruit and dry snacks (banana, apple, orange, pear, dates, mixed seeds, dry coconut). The principal ingredients that anchored that week were rice, moong dal, kidney beans, chickpeas, and wheat flour.

The plan below is for the FOLLOWING week.
1. COOKED-DISH ROTATION: the new week should not repeat the previous week's cooked dishes (breakfast, school lunch, home lunch) unless the dish is a declared favourite. Repeating fruit or dry snacks as snacks is acceptable. The declared favourite is "paratha", so paratha may repeat.
2. PRINCIPAL-INGREDIENT ROTATION: a principal ingredient that anchored the previous week (e.g. moong dal, kidney beans, rice, chickpeas, wheat flour) should not anchor a large share of the new week's cooked meals.
3. OVERALL VARIETY: the two weeks should feel distinct, not a re-skin of the same dishes. Do not pass a plan that fills most of the week with the favourite dish or a single renamed anchor.
Pass only if all three hold. When in doubt, pass if there is no clear violation.`

// Broader than the scenario's hard exclusions (paneer, ghee): catches dairy
// the exclusion net wouldn't flag, e.g. curd, milk, or butter in items, dish
// names, or easy-buys.
const DAIRY_TOKENS = [
  "paneer",
  "ghee",
  "milk",
  "curd",
  "yogurt",
  "yoghurt",
  "cheese",
  "butter",
  "khoya",
  "cream",
  "malai",
  "buttermilk",
  "lassi",
  "chaas",
]

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

  contractIt("T05: a tight morning budget and no night prep keep every morning within 35 cook minutes", async () => {
    const base = scenario("no-prior-night-prep").context
    const ctx: MealPlanContext = {
      ...base,
      profile: { ...base.profile, morningCookingBudgetMinutes: MORNING_BUDGET_MINUTES },
      request: {
        kind: "initial_plan",
        text: "No night prep this week. I have only 35 minutes before school, including getting him ready.",
      },
    }
    const terminal = requireProposal(await runLive(ctx))
    const measurements = terminal.evaluation.measurements
    expect(measurements.morningCookMax).toBeLessThanOrEqual(MORNING_BUDGET_MINUTES)
    expect(measurements.priorNightPrepMax).toBe(0)
  })

  contractIt("T02: a half day and a holiday produce a plan that omits the dropped slots", async () => {
    const ctx = scenario("holiday-half-day").context
    const terminal = requireProposal(await runLive(ctx))
    expect(Object.keys(terminal.candidate.grid.Sat ?? {}), "Sat is a school holiday; no cells allowed").toHaveLength(0)
    const wed = terminal.candidate.grid.Wed ?? {}
    expect(wed["school-lunch"], "Wed half day must skip the packed school lunch").toBeUndefined()
    expect(wed["home-lunch"], "Wed half day keeps the home lunch").toBeDefined()
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

  contractIt(
    "T07: a scarce kitchen either clarifies sensibly or proposes using ordinary staples (judge-graded)",
    async () => {
      const base = scenario("baseline-week").context
      const scarce = new Set(["onions", "tomatoes", "potatoes", "rice", "atta", "dal", "bananas"])
      const ctx: MealPlanContext = {
        ...base,
        // The parent claims ONLY these seven items; the pantry baseline (oil,
        // spices, ghee, flours...) stays as background kitchen staples. With
        // so little to work from, the model must buy a fair amount — this is
        // exactly the escape hatch in the easy-buys policy, so no hard cap.
        // allowNewFoods must be ON: baseline-week's 25-dish repertoire has
        // almost nothing cookable from a 7-item kitchen, so a plan from these
        // items is impossible under the familiar-dishes-only rule.
        weeklyInventory: {
          items: [...scarce].map((name) => ({ name, status: "available" as const })),
          notes: [],
        },
        profile: { ...base.profile, allowNewFoods: true },
        request: {
          kind: "initial_plan",
          text: "I only have onions, tomatoes, potatoes, rice, atta, dal and bananas.",
        },
      }
      const result = await runLive(ctx)
      expect(result.completed, JSON.stringify(result.failureReason ?? null)).toBe(true)
      // A scarce kitchen may legitimately ask (e.g. permission to repeat fruit
      // snacks or add dry snacks) instead of committing to a plan. Both are
      // acceptable terminals; only a proposal is judge-graded.
      if (result.terminal?.kind === "needs_clarification") {
        const message = result.terminal.message
        expect(message.length).toBeLessThanOrEqual(MAX_CLARIFY_LENGTH)
        noOpaqueLeak(result.messages)
        expect(message).not.toMatch(/fb-[a-z0-9]+|tg-\d+/)
        return
      }
      const terminal = requireProposal(result)
      noOpaqueLeak(result.messages)
      const verdict = await judgePlan(
        generator,
        ctx.request.text,
        terminal.candidate,
        ctx.profile.pantryBaseline,
        T07_JUDGE_RUBRIC,
      )
      console.log(
        `T07 judge: pass=${verdict.pass} easyBuys=${terminal.candidate.easyBuys.length}\njustification: ${verdict.justification}\nreasons:\n${verdict.reasons.map((reason) => `  - ${reason}`).join("\n")}`,
      )
      expect(
        verdict.pass,
        `T07 judge justification:\n${verdict.justification}\n\nreasons:\n${verdict.reasons.join("\n")}`,
      ).toBe(true)
    },
  )

  contractIt("T08: a no-dairy request keeps every dairy token out of the week", async () => {
    const base = scenario("no-dairy-week").context
    const ctx: MealPlanContext = {
      ...base,
      request: { kind: "initial_plan", text: "No dairy products this week." },
    }
    const result = await runLive(ctx)
    const terminal = requireProposal(result)
    noOpaqueLeak(result.messages)
    const text = [
      ...terminal.candidate.easyBuys,
      ...Object.values(terminal.candidate.grid).flatMap((day) =>
        Object.values(day).flatMap((cell) => [cell.dish, ...cell.items]),
      ),
    ]
      .join(" ")
      .toLowerCase()
    for (const token of DAIRY_TOKENS) {
      expect(text.includes(token), `dairy leak: "${token}"`).toBe(false)
    }
  })

  contractIt(
    "T04: a vague difficulty is either clarified or reflected as a lighter Tuesday (judge-graded)",
    async () => {
      const base = scenario("baseline-week").context
      const ctx: MealPlanContext = { ...base, request: { kind: "initial_plan", text: "Tuesday will be difficult." } }
      const result = await runLive(ctx)
      expect(result.completed, JSON.stringify(result.failureReason ?? null)).toBe(true)
      if (result.terminal?.kind === "needs_clarification") {
        const message = result.terminal.message
        expect(message.length).toBeLessThanOrEqual(MAX_CLARIFY_LENGTH)
        noOpaqueLeak(result.messages)
        expect(message).not.toMatch(/fb-[a-z0-9]+|tg-\d+/)
        return
      }
      const terminal = requireProposal(result)
      const verdict = await judgePlan(
        generator,
        ctx.request.text,
        terminal.candidate,
        ctx.profile.pantryBaseline,
        T04_JUDGE_RUBRIC,
      )
      console.log(
        `T04 judge: pass=${verdict.pass}\njustification: ${verdict.justification}\nreasons:\n${verdict.reasons.map((reason) => `  - ${reason}`).join("\n")}`,
      )
      expect(
        verdict.pass,
        `T04 judge justification:\n${verdict.justification}\n\nreasons:\n${verdict.reasons.join("\n")}`,
      ).toBe(true)
    },
  )

  contractIt("T04-CL: an underspecified dish name produces one targeted clarification", async () => {
    const base = scenario("baseline-week").context
    const ctx: MealPlanContext = {
      ...base,
      request: { kind: "initial_plan", text: "Please make Pav on Wednesday this week." },
    }
    const result = await runLive(ctx)
    expect(result.completed, JSON.stringify(result.failureReason ?? null)).toBe(true)
    expect(result.terminal?.kind).toBe("needs_clarification")
    if (result.terminal?.kind !== "needs_clarification") throw new Error("no clarification")
    expect(result.terminal.message.length).toBeLessThanOrEqual(MAX_CLARIFY_LENGTH)
    noOpaqueLeak(result.messages)
    expect(result.terminal.message).not.toMatch(/fb-[a-z0-9]+|tg-\d+/)
  })

  contractIt("T04-CL: a contrarian snack request produces one targeted clarification", async () => {
    const base = scenario("baseline-week").context
    const ctx: MealPlanContext = {
      ...base,
      request: { kind: "initial_plan", text: "Add pulao as a snack on Thursday." },
    }
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

  contractIt(
    "T12: a second week avoids unnecessary cross-week dish repeats and excessive principal-ingredient reuse",
    async () => {
      // Prior week built from a realistic SUBSET of the seed repertoire: fruit
      // and dry snacks repeat across days (the snack escape hatch), leaving
      // enough unused repertoire for the new week to vary. The new week must
      // also pass the evaluator, which enforces the same dish-repeat rule.
      const cell = (dish: string, items: string[], cookMinutes: number): MealCell => ({
        dish,
        vegetarian: true,
        items,
        cookMinutes,
        priorNightPrep: false,
      })
      const priorWeek: MealGrid = {
        Mon: {
          breakfast: cell("paratha", ["wheat flour"], BREAKFAST_COOK_MIN),
          snack1: cell("banana", ["banana"], SNACK_COOK_MIN),
          snack2: cell("dates", ["dates"], SNACK_COOK_MIN),
          "school-lunch": cell("bottle gourd dal", ["bottle gourd", "moong dal"], MAIN_COOK_MIN),
          "home-lunch": cell("rice and beans", ["rice", "beans"], MAIN_COOK_MIN),
        },
        Tue: {
          breakfast: cell("poha", ["poha"], BREAKFAST_COOK_MIN),
          snack1: cell("apple", ["apple"], SNACK_COOK_MIN),
          snack2: cell("mixed seeds", ["mixed seeds"], SNACK_COOK_MIN),
          "school-lunch": cell("rajma", ["kidney beans"], MAIN_COOK_MIN),
          "home-lunch": cell("chole", ["chickpeas"], MAIN_COOK_MIN),
        },
        Wed: {
          breakfast: cell("paratha", ["wheat flour"], BREAKFAST_COOK_MIN),
          snack1: cell("banana", ["banana"], SNACK_COOK_MIN),
          snack2: cell("dry coconut", ["dry coconut"], SNACK_COOK_MIN),
          "school-lunch": cell("khichdi", ["rice", "moong dal"], MAIN_COOK_MIN),
          "home-lunch": cell("rice and beans", ["rice", "beans"], MAIN_COOK_MIN),
        },
        Thu: {
          breakfast: cell("poha", ["poha"], BREAKFAST_COOK_MIN),
          snack1: cell("orange", ["orange"], SNACK_COOK_MIN),
          snack2: cell("dates", ["dates"], SNACK_COOK_MIN),
          "school-lunch": cell("rajma", ["kidney beans"], MAIN_COOK_MIN),
          "home-lunch": cell("bottle gourd dal", ["bottle gourd", "moong dal"], MAIN_COOK_MIN),
        },
        Fri: {
          breakfast: cell("upma", ["upma rava"], BREAKFAST_COOK_MIN),
          snack1: cell("pear", ["pear"], SNACK_COOK_MIN),
          snack2: cell("mixed seeds", ["mixed seeds"], SNACK_COOK_MIN),
          "school-lunch": cell("khichdi", ["rice", "moong dal"], MAIN_COOK_MIN),
          "home-lunch": cell("chole", ["chickpeas"], MAIN_COOK_MIN),
        },
      }
      const base = scenario("baseline-week").context
      const ctx: MealPlanContext = {
        ...base,
        profile: { ...base.profile, allowNewFoods: true },
        weeklyInventory: {
          items: base.weeklyInventory.items,
          notes: ["A fresh stock for the new week; some items overlap with last week."],
        },
        recentPlan: priorWeek,
        request: { kind: "initial_plan", text: "Plan next week." },
      }
      const result = await runLive(ctx)
      const terminal = requireProposal(result)
      noOpaqueLeak(result.messages)

      // Structural: the evaluator already rejects cross-week repeats of
      // non-snack dishes. Assert the plan is non-trivial — it must actually use
      // the repertoire headroom / new foods rather than repeating the prior week.
      const priorCooked = new Set(
        Object.values(priorWeek).flatMap((day) =>
          Object.entries(day)
            .filter(([slot]) => !["snack1", "snack2"].includes(slot))
            .map(([, cell]) => cell.dish),
        ),
      )
      const newCooked = new Set(
        Object.values(terminal.candidate.grid).flatMap((day) =>
          Object.entries(day)
            .filter(([slot]) => !["snack1", "snack2"].includes(slot))
            .map(([, cell]) => cell.dish),
        ),
      )
      const overlap = [...priorCooked].filter(
        (dish) => newCooked.has(dish) && !ctx.profile.foodPreferences.favourites.includes(dish),
      )
      expect(overlap, `cooked dishes repeated from the prior week (favourites are exempt)`).toEqual([])

      const verdict = await judgePlan(
        generator,
        ctx.request.text,
        terminal.candidate,
        ctx.profile.pantryBaseline,
        T12_JUDGE_RUBRIC,
      )
      console.log(
        `T12 judge: pass=${verdict.pass}\njustification: ${verdict.justification}\nreasons:\n${verdict.reasons.map((reason) => `  - ${reason}`).join("\n")}`,
      )
      expect(
        verdict.pass,
        `T12 judge justification:\n${verdict.justification}\n\nreasons:\n${verdict.reasons.join("\n")}`,
      ).toBe(true)
    },
  )
})
