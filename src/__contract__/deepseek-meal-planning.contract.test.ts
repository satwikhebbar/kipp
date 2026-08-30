import { describe, expect, it } from "vitest"
import { expandMealCatalog } from "../agent/meal-catalog-expansion"
import { type MealPlanningAgentSessionResult, runMealPlanningAgentSession } from "../agent/meal-planning-session"
import { renderHouseholdContext } from "../meal-planning/agent-workflow"
import { loadScenarios } from "../meal-planning/corpus/load"
import { SEED_SCHEDULE } from "../meal-planning/store"
import type {
  FeedbackItem,
  MealCell,
  MealGrid,
  MealPlanCandidate,
  MealPlanContext,
  MealPlanScenario,
} from "../meal-planning/types"
import {
  createGenerator,
  createToolProvider,
  type GenerateFn,
  type ToolConversationMessage,
  type ToolProviderClient,
} from "../providers"
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
// Guard against essay-length clarifications in chat. Not a shipped limit;
// 600 is generous (a real T07 clarification ran 527 chars legitimately).
const MAX_CLARIFY_LENGTH = 600
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

// T12 keeps a judge for exactly one genuinely qualitative clause: whether the
// two weeks "feel distinct" to a parent. Dish-name rotation and anchor
// (principal-ingredient) reuse are asserted deterministically in the test.
const T12_JUDGE_RUBRIC = `The family already planned and cooked the previous week, and the plan below is for the FOLLOWING week. The structural checks (cooked-dish rotation, anchor-ingredient reuse) are already graded by code.
1. OVERALL VARIETY: the two weeks should feel genuinely distinct to a parent, not a re-skin of the same meals under different names. Do not pass a plan that fills most of the week with the favourite dish or a single renamed anchor.
Pass only if it holds. When in doubt, pass if there is no clear violation.`

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

// Easy-buys may contain only ordinary staples, all-season produce and everyday
// grocery items. Long-shelf / specialty items (the former judge's EASY-BUY
// DEFINITION clause) are a small, stable prohibited set — the complement is
// open, so the assertion is negative, not an allowed-set membership check.
const EASY_BUY_PROHIBITED = [
  "dates",
  "raisin",
  "dry coconut",
  "jaggery",
  "paneer",
  "cashew",
  "almond",
  "walnut",
  "peanut",
  "pistachio",
  "seed",
]

// "Light Tuesday" operationalised: one light morning meal (a 15-min breakfast
// and nothing else cooked that morning) is the quick/no-cook arrangement the
// rubric used to accept; anything else counts as light only if it is strictly
// lighter than the week's heaviest morning.
const LIGHT_TUESDAY_CEILING_MIN = 15

/** All cell items across the grid (dish names not included). */
function allGridItems(grid: MealGrid): string[] {
  return Object.values(grid).flatMap((day) => Object.values(day).flatMap((cell) => cell.items))
}

/** Cells that are actually cooked (cookMinutes > 0), excluding dry snacks and no-cook lunches. */
function cookedCells(grid: MealGrid): MealCell[] {
  return Object.values(grid).flatMap((day) => Object.values(day).filter((cell) => cell.cookMinutes > 0))
}

/**
 * Deterministic easy-buy contract (shared by B1/T01, C2, T07):
 * ingredient tokens only (never a dish name that is not also used as an
 * ingredient), nothing already on hand is re-bought, nothing
 * long-shelf/specialty appears, and (when given) a count cap.
 */
function assertValidEasyBuys(candidate: MealPlanCandidate, opts: { maxCount?: number; onHand: string[] }): void {
  const dishNames = new Set(Object.values(candidate.grid).flatMap((day) => Object.values(day).map((cell) => cell.dish)))
  const usedAsIngredient = new Set(allGridItems(candidate.grid))
  const onHand = opts.onHand.map((item) => item.toLowerCase())
  if (opts.maxCount !== undefined) {
    expect(candidate.easyBuys.length).toBeLessThanOrEqual(opts.maxCount)
  }
  for (const buy of candidate.easyBuys) {
    const token = buy.toLowerCase()
    // A fruit that is both a snack dish and an ingredient (e.g. banana) is a
    // legitimate buy; only a buy that is a dish name AND never used as an
    // ingredient is a real token/dish-name mix-up.
    expect(
      dishNames.has(buy) && !usedAsIngredient.has(buy),
      `easy-buy "${buy}" is a dish name, not an ingredient`,
    ).toBe(false)
    for (const banned of EASY_BUY_PROHIBITED) {
      expect(token.includes(banned), `easy-buy "${buy}" is a long-shelf/specialty item`).toBe(false)
    }
    const alreadyOnHand = onHand.some((item) => token.includes(item))
    expect(alreadyOnHand, `easy-buy "${buy}" is already on hand`).toBe(false)
  }
}

/** Every requested ingredient must be usable: in a dish, an easy-buy, or the pantry baseline. */
function assertRequestedRepresented(requested: string[], candidate: MealPlanCandidate, pantryBaseline: string[]): void {
  const covered = [...allGridItems(candidate.grid), ...candidate.easyBuys, ...pantryBaseline].map((token) =>
    token.toLowerCase(),
  )
  for (const req of requested) {
    const needle = req.toLowerCase()
    const found = covered.some((token) => needle.includes(token) || token.includes(needle))
    expect(found, `requested ingredient "${req}" is not usable in the plan`).toBe(true)
  }
}

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

interface CatalogExpansionExchange {
  messages: ToolConversationMessage[]
  toolCalls: unknown
  error?: string
}

/** Runs catalog expansion against the live provider and retains a sign-off transcript without provider reasoning state. */
async function runLiveCatalogExpansion(parentDishNames: string[]) {
  const inner = createToolProvider(apiKey, providerName, model, PROVIDER_MAX_RETRIES)
  const exchanges: CatalogExpansionExchange[] = []
  const provider: ToolProviderClient = {
    async generate(input) {
      const exchange: CatalogExpansionExchange = { messages: input.messages, toolCalls: [] }
      exchanges.push(exchange)
      try {
        const response = await inner.generate(input)
        exchange.toolCalls = response.toolCalls ?? []
        return response
      } catch (error) {
        exchange.error = error instanceof ToolProviderHttpError ? error.providerMessage ?? error.message : String(error)
        throw error
      }
    },
  }
  let result: Awaited<ReturnType<typeof expandMealCatalog>> | undefined
  let failure: unknown
  try {
    result = await expandMealCatalog(provider, { parentDishNames, schedule: SEED_SCHEDULE })
    return result
  } catch (error) {
    failure = error
    throw error
  } finally {
    if (!evalDebug) return
    console.log("=== MEAL CATALOG EXPANSION ===")
    console.log(JSON.stringify({ parentDishNames, schedule: SEED_SCHEDULE.slots }, null, 2))
    for (const [index, exchange] of exchanges.entries()) {
      console.log(`--- catalog provider exchange ${index + 1} ---`)
      for (const message of exchange.messages) console.log(renderMessage(message))
      console.log(`TOOL CALLS: ${JSON.stringify(exchange.toolCalls, null, 2)}`)
      if (exchange.error) console.log(`PROVIDER ERROR: ${exchange.error}`)
    }
    console.log("=== CATALOG EXPANSION RESULT ===")
    console.log(JSON.stringify(result ?? { failure: String(failure) }, null, 2))
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

function assertEstablishedCatalog(
  parentDishNames: string[],
  result: Awaited<ReturnType<typeof expandMealCatalog>>,
): void {
  expect(result.failures).toEqual([])
  expect(result.definitions).toHaveLength(parentDishNames.length)
  const definitions = result.definitions ?? []
  const ids = new Set(definitions.map((definition) => definition.id))
  expect(ids.size).toBe(parentDishNames.length)
  const slots = new Map(SEED_SCHEDULE.slots.map((slot) => [slot.id, slot]))
  for (const [index, definition] of definitions.entries()) {
    expect(definition.aliases).toEqual([parentDishNames[index]])
    expect(definition.id).toMatch(/^meal_/)
    expect(definition.name.trim().toLocaleLowerCase()).toBe(parentDishNames[index].trim().toLocaleLowerCase())
    expect(definition.status).toBe("established")
    expect(definition.vegetarian).toBe(true)
    expect(definition.principalIngredients.length).toBeGreaterThan(0)
    expect(definition.requiredIngredients.length).toBeGreaterThan(0)
    expect(definition.typicalCookMinutes).toSatisfy(Number.isInteger)
    expect(definition.typicalCookMinutes).toBeGreaterThanOrEqual(0)
    expect(["none", "optional", "required"]).toContain(definition.priorNightPrep)
    expect(definition.packedFood).toMatchObject({ suitable: true })
    expect(typeof definition.packedFood?.dry).toBe("boolean")
    for (const slotId of definition.suitableSlots) {
      const slot = slots.get(slotId)
      expect(slot, `${definition.name} has unknown slot ${slotId}`).toBeDefined()
      if (slot?.maxCookMinutes !== null && slot?.maxCookMinutes !== undefined)
        expect(definition.typicalCookMinutes).toBeLessThanOrEqual(slot.maxCookMinutes)
    }
  }
}

describe("DeepSeek agent-centered meal-planning live contract", () => {
  contractIt("M01: parent repertoire expands into five validated established definitions", async () => {
    const parentDishNames = ["vegetable paratha", "poha", "idli chutney", "lemon rice", "roasted chana"]
    const result = await runLiveCatalogExpansion(parentDishNames)
    assertEstablishedCatalog(parentDishNames, result)
  })

  contractIt("M02: composed parent labels retain their scope", async () => {
    const parentDishNames = ["Paniyaram Chutney", "Rajma Chawal", "Puri + Aloo Sabji"]
    const result = await runLiveCatalogExpansion(parentDishNames)
    assertEstablishedCatalog(parentDishNames, result)
    const rajmaChawal = result.definitions?.find((definition) => definition.aliases?.[0] === "Rajma Chawal")
    expect(rajmaChawal?.priorNightPrep).toBe("required")
  })

  contractIt("M03: no-cook snack slots exclude cooked meals", async () => {
    const parentDishNames = ["Banana", "Roasted Chana", "Vegetable Paratha", "Lemon Rice"]
    const result = await runLiveCatalogExpansion(parentDishNames)
    assertEstablishedCatalog(parentDishNames, result)
    const byParentName = new Map((result.definitions ?? []).map((definition) => [definition.aliases?.[0], definition]))
    for (const name of ["Banana", "Roasted Chana"]) {
      const definition = byParentName.get(name)
      expect(definition?.suitableSlots.some((slot) => slot === "snack1" || slot === "snack2")).toBe(true)
      expect(definition?.suitableSlots.every((slot) => slot === "snack1" || slot === "snack2")).toBe(true)
      expect(definition?.typicalCookMinutes).toBe(0)
      expect(definition?.packedFood?.dry).toBe(true)
    }
    for (const name of ["Vegetable Paratha", "Lemon Rice"]) {
      const definition = byParentName.get(name)
      expect(definition?.suitableSlots).not.toContain("snack1")
      expect(definition?.suitableSlots).not.toContain("snack2")
      expect(definition?.typicalCookMinutes).toBeGreaterThan(0)
    }
  })

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

  contractIt("R02: two independent comments both land in one complete revised plan", async () => {
    const ctx = scenario("batched-feedback").context
    const recent = ctx.recentPlan
    if (!recent) throw new Error("batched-feedback needs recentPlan")
    const terminal = requireProposal(await runLive(ctx))

    const scoped = (ctx.feedbackItems ?? []).filter(
      (item): item is FeedbackItem & { scope: { day: string; slot: string } } =>
        Boolean(item.scope?.day && item.scope.slot),
    )
    expect(scoped.length, "batched-feedback needs two scoped items").toBeGreaterThanOrEqual(2)
    for (const item of scoped) {
      const before = recent[item.scope.day]?.[item.scope.slot]?.dish
      const after = terminal.candidate.grid[item.scope.day]?.[item.scope.slot]?.dish
      const cellMoved = before !== undefined && after !== undefined && after !== before
      const rationaleCovered = Object.values(terminal.candidate.policyOutcomes).some((outcome) =>
        outcome.rationale.includes(item.id),
      )
      expect(
        cellMoved || rationaleCovered,
        `feedback ${item.id} (${item.text}) must be addressed by a cell change or outcome rationale`,
      ).toBe(true)
    }
  })

  contractIt("R05: conflicting feedback ('no dairy' + 'make paneer') is clarified, not silently violated", async () => {
    const base = scenario("no-dairy-week").context
    // Graft a dairy-free Mon–Fri recent plan onto the no-dairy context (which
    // stocks paneer and knows paneer paratha, so the conflict is reachable).
    const cell = (dish: string, items: string[], cookMinutes: number): MealCell => ({
      dish,
      vegetarian: true,
      items,
      cookMinutes,
      priorNightPrep: false,
    })
    const recentPlan: MealGrid = {
      Mon: {
        breakfast: cell("paratha", ["wheat flour"], BREAKFAST_COOK_MIN),
        snack1: cell("banana", ["banana"], SNACK_COOK_MIN),
        snack2: cell("roasted chana", ["chana"], SNACK_COOK_MIN),
        "school-lunch": cell("bottle gourd dal", ["bottle gourd", "moong dal"], MAIN_COOK_MIN),
        "home-lunch": cell("rice and beans", ["rice", "beans"], MAIN_COOK_MIN),
      },
      Tue: {
        breakfast: cell("poha", ["poha"], BREAKFAST_COOK_MIN),
        snack1: cell("apple", ["apple"], SNACK_COOK_MIN),
        snack2: cell("dates", ["dates"], SNACK_COOK_MIN),
        "school-lunch": cell("rajma", ["kidney beans"], MAIN_COOK_MIN),
        "home-lunch": cell("quinoa bowl", ["quinoa"], MAIN_COOK_MIN),
      },
      Wed: {
        breakfast: cell("idli", ["idli rice"], BREAKFAST_COOK_MIN),
        snack1: cell("orange", ["orange"], SNACK_COOK_MIN),
        snack2: cell("mixed seeds", ["mixed seeds"], SNACK_COOK_MIN),
        "school-lunch": cell("khichdi", ["rice", "moong dal"], MAIN_COOK_MIN),
        "home-lunch": cell("sweet potato curry", ["sweet potato"], MAIN_COOK_MIN),
      },
      Thu: {
        breakfast: cell("upma", ["upma rava"], BREAKFAST_COOK_MIN),
        snack1: cell("pear", ["pear"], SNACK_COOK_MIN),
        snack2: cell("dry coconut", ["dry coconut"], SNACK_COOK_MIN),
        "school-lunch": cell("chole", ["chickpeas"], MAIN_COOK_MIN),
        "home-lunch": cell("dal fry", ["toor dal"], MAIN_COOK_MIN),
      },
      Fri: {
        breakfast: cell("dosa", ["dosa batter"], BREAKFAST_COOK_MIN),
        snack1: cell("pomegranate", ["pomegranate"], SNACK_COOK_MIN),
        snack2: cell("jaggery cubes", ["jaggery"], SNACK_COOK_MIN),
        "school-lunch": cell("masala oats", ["oats"], MAIN_COOK_MIN),
        "home-lunch": cell("vegetable poha", ["poha", "carrot"], MAIN_COOK_MIN),
      },
    }
    const ctx: MealPlanContext = {
      ...base,
      recentPlan,
      request: {
        kind: "revision",
        text: "No dairy this week, but make Tuesday lunch paneer.",
      },
      feedbackItems: [
        { id: "tg-dairy", text: "Make Tuesday lunch paneer.", scope: { day: "Tue", slot: "school-lunch" } },
      ],
    }
    const result = await runLive(ctx)
    // R05 must NOT end with a plan that smuggles dairy past the exclusion.
    if (result.terminal?.kind === "propose_plan") {
      const text = Object.values(result.terminal.candidate.grid)
        .flatMap((day) => Object.values(day).flatMap((c) => [c.dish, ...c.items]))
        .join(" ")
        .toLowerCase()
      for (const token of DAIRY_TOKENS) {
        expect(text.includes(token), `dairy leak in proposal: "${token}"`).toBe(false)
      }
      return
    }
    expect(result.completed, JSON.stringify(result.failureReason ?? null)).toBe(true)
    expect(result.terminal?.kind, "conflict must resolve as a clarification").toBe("needs_clarification")
    expect(result.terminal?.reasonCodes).toContain("hard_exclusion")
  })

  contractIt("C2: request-listed ingredients land in a short easy-buys list against a stocked kitchen", async () => {
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
    const onHand = [...ctx.weeklyInventory.items.map((item) => item.name), ...ctx.profile.pantryBaseline]
    // The produce the parent names must end up usable in the plan.
    assertRequestedRepresented(
      ["potatoes", "tomatoes", "onions", "bananas"],
      terminal.candidate,
      ctx.profile.pantryBaseline,
    )
    // Short, ordinary, and nothing on hand is re-bought.
    assertValidEasyBuys(terminal.candidate, { maxCount: MAX_EASY_BUYS, onHand })
  })

  contractIt("T07: a scarce kitchen either clarifies sensibly or proposes using ordinary staples", async () => {
    const base = scenario("baseline-week").context
    const scarce = ["onions", "tomatoes", "potatoes", "rice", "atta", "dal", "bananas"]
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
        items: scarce.map((name) => ({ name, status: "available" as const })),
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
    // acceptable terminals; only a proposal is checked further.
    if (result.terminal?.kind === "needs_clarification") {
      const message = result.terminal.message
      expect(message.length).toBeLessThanOrEqual(MAX_CLARIFY_LENGTH)
      noOpaqueLeak(result.messages)
      expect(message).not.toMatch(/fb-[a-z0-9]+|tg-\d+/)
      return
    }
    const terminal = requireProposal(result)
    noOpaqueLeak(result.messages)
    const onHand = [...ctx.weeklyInventory.items.map((item) => item.name), ...ctx.profile.pantryBaseline]
    // INVENTORY-USE: the seven claimed items must actually anchor the week,
    // not be ignored in favour of purchases. Count each claimed item that
    // appears in at least one meal, and require a majority.
    const used = new Set(allGridItems(terminal.candidate.grid))
    const anchored = scarce.filter((item) => used.has(item))
    expect(
      anchored.length,
      `only ${anchored.length}/${scarce.length} claimed items used: ${anchored.join(", ") || "none"}`,
    ).toBeGreaterThanOrEqual(Math.ceil(scarce.length / 2))
    // EASY-BUYS: ordinary and easy-to-find, nothing long-shelf/specialty, and
    // never a re-buy of the seven claimed items. No count cap — the scarce
    // kitchen justifies more buys than a stocked one.
    assertValidEasyBuys(terminal.candidate, { onHand })
  })

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

  contractIt("T04: a vague difficulty is either clarified or reflected as a lighter Tuesday", async () => {
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
    const tueCook = terminal.evaluation.measurements.morningCookByDay.Tue
    const maxCook = terminal.evaluation.measurements.morningCookMax
    // Lighter Tuesday, deterministically: at most one light morning meal, or
    // strictly lighter than the week's heaviest morning.
    expect(
      tueCook <= LIGHT_TUESDAY_CEILING_MIN || tueCook < maxCook,
      `Tuesday morning cook ${tueCook} is not lighter than the heaviest morning ${maxCook}`,
    ).toBe(true)
  })

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

  contractIt("R03: day-level feedback replans the targeted day and leaves other days stable", async () => {
    const ctx = scenario("whole-day-replan").context
    const recent = ctx.recentPlan
    if (!recent) throw new Error("whole-day-replan needs recentPlan")
    const scope = ctx.feedbackItems?.[0]?.scope
    if (!scope?.day || scope.slot) throw new Error("whole-day-replan needs a day-scoped feedback item")
    const terminal = requireProposal(await runLive(ctx))

    const replanned = Object.keys(terminal.candidate.grid[scope.day] ?? {})
    const original = Object.keys(recent[scope.day] ?? {})
    expect(replanned.length, "replanned day must keep its slots").toBe(original.length)
    expect(
      dishesBySlot(terminal.candidate.grid, scope.day),
      "day-scoped feedback must change the targeted day",
    ).not.toEqual(dishesBySlot(recent, scope.day))
    for (const day of Object.keys(recent)) {
      if (day === scope.day) continue
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

      // Principal-ingredient reuse, deterministically: the prior week's anchor
      // ingredients must not anchor more than half of the new week's cooked
      // cells. This replaces the judge's PRINCIPAL-INGREDIENT-ROTATION clause.
      const priorAnchors = ["rice", "moong dal", "kidney beans", "chickpeas", "wheat flour"]
      const newWeekCooked = cookedCells(terminal.candidate.grid)
      const anchorUse = new Map<string, number>()
      for (const cell of newWeekCooked) {
        for (const anchor of priorAnchors) {
          if (cell.items.some((item) => item.toLowerCase().includes(anchor))) {
            anchorUse.set(anchor, (anchorUse.get(anchor) ?? 0) + 1)
          }
        }
      }
      for (const anchor of priorAnchors) {
        const uses = anchorUse.get(anchor) ?? 0
        expect(
          uses,
          `prior anchor "${anchor}" reused in ${uses}/${newWeekCooked.length} cooked cells`,
        ).toBeLessThanOrEqual(Math.floor(newWeekCooked.length / 2))
      }

      // The judge now grades ONLY the qualitative clause: does the new week feel
      // genuinely distinct from the prior one.
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
