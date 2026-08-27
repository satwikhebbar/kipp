import { describe, expect, it, vi } from "vitest"
import { runMealPlanningAgentSession } from "../agent/meal-planning-session"
import { loadScenarios } from "../meal-planning/corpus/load"
import { evaluateMealPlan } from "../meal-planning/evaluation"
import type { MealCell, MealGrid, MealPlanContext } from "../meal-planning/types"
import type { ToolProviderClient } from "../providers"

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const SLOT_COOK: Record<string, number> = { breakfast: 15, snack1: 0, snack2: 0, "school-lunch": 20, "home-lunch": 20 }

function cell(dish: string, items: string[], slot: string): MealCell {
  return { dish, vegetarian: true, items, cookMinutes: SLOT_COOK[slot], priorNightPrep: false }
}

function gridWith(day: string, slot: string, override: MealCell): MealGrid {
  const grid: MealGrid = {}
  for (const d of DAYS) {
    grid[d] = {}
    for (const s of Object.keys(SLOT_COOK)) {
      grid[d][s] = cell("paratha", s === "school-lunch" || s === "home-lunch" ? ["rice"] : ["wheat flour"], s)
    }
  }
  grid[day][slot] = override
  return grid
}

function passingCandidate(): { grid: MealGrid; easyBuys: string[]; policyOutcomes: Record<string, never> } {
  return {
    grid: gridWith("Mon", "breakfast", cell("paratha", ["wheat flour"], "breakfast")),
    easyBuys: [],
    policyOutcomes: {},
  }
}

function failingCandidate(): { grid: MealGrid; easyBuys: string[]; policyOutcomes: Record<string, never> } {
  return {
    grid: gridWith("Mon", "breakfast", cell("biryani", ["rice"], "breakfast")),
    easyBuys: [],
    policyOutcomes: {},
  }
}

function context(overrides: Partial<MealPlanContext> = {}): MealPlanContext {
  return {
    schedule: {
      days: DAYS,
      slots: [
        { id: "breakfast", name: "Breakfast", packed: false, dry: false, maxCookMinutes: null },
        { id: "snack1", name: "Snack 1", packed: true, dry: true, maxCookMinutes: 0 },
        { id: "snack2", name: "Snack 2", packed: true, dry: true, maxCookMinutes: 0 },
        { id: "school-lunch", name: "School lunch", packed: true, dry: false, maxCookMinutes: null },
        { id: "home-lunch", name: "Home lunch", packed: false, dry: false, maxCookMinutes: null },
      ],
    },
    profile: {
      dietaryExclusions: [],
      dishRepertoire: ["paratha"],
      foodPreferences: { favourites: ["paratha"], avoid: [] },
      allowNewFoods: false,
      sensoryGuidelines: [],
      morningCookingBudgetMinutes: 40,
      priorNightPrepAllowed: false,
      pantryBaseline: ["wheat flour", "rice"],
    },
    customPolicies: [],
    weeklyInventory: { items: [], notes: [] },
    weeklyExceptions: { items: [] },
    request: { kind: "initial_plan", text: "plan the week" },
    ...overrides,
  }
}

function providerWith(...responses: Awaited<ReturnType<ToolProviderClient["generate"]>>[]): ToolProviderClient {
  return { generate: vi.fn().mockImplementation(async () => responses.shift()) }
}

function call(id: string, name: string, input: unknown) {
  return { id, name, input }
}

function evaluateResponse(candidate: unknown) {
  return { toolCalls: [call("evaluate", "evaluate_meal_plan", candidate)], usage: { inputTokens: 0, outputTokens: 0 } }
}

function proposeResponse(input: unknown) {
  return { toolCalls: [call("propose", "propose_plan", input)], usage: { inputTokens: 0, outputTokens: 0 } }
}

function clarifyResponse(input: unknown) {
  return { toolCalls: [call("clarify", "needs_clarification", input)], usage: { inputTokens: 0, outputTokens: 0 } }
}

function proposeInput(
  candidate: unknown,
  feedbackItems?: unknown,
  overrides?: { weeklyInventory?: unknown; weeklyExceptions?: unknown },
) {
  return {
    candidate,
    weeklyInventory: overrides?.weeklyInventory ?? { items: [], notes: [] },
    weeklyExceptions: overrides?.weeklyExceptions ?? { items: [] },
    ...(feedbackItems ? { feedbackItems } : {}),
  }
}

describe("bounded meal-planning agent session", () => {
  it("accepts propose_plan only when the candidate passes evaluation", async () => {
    const provider = providerWith(
      evaluateResponse(passingCandidate()),
      proposeResponse(proposeInput(passingCandidate())),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: "plan" }], { context: context() })
    expect(result.completed).toBe(true)
    expect(result.terminal).toMatchObject({ kind: "propose_plan" })
    if (result.terminal?.kind === "propose_plan") expect(result.terminal.evaluation.pass).toBe(true)
  })

  it("rejects propose_plan when the candidate fails evaluation", async () => {
    const provider = providerWith(
      evaluateResponse(passingCandidate()),
      proposeResponse(proposeInput(failingCandidate())),
      clarifyResponse({
        message: "Biryani is not in the repertoire; keep a familiar dish?",
        reasonCodes: ["unfamiliar_dish_not_allowed"],
        interaction: { kind: "reply" },
      }),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: "plan" }], { context: context() })
    expect(result.toolExecutions).toContainEqual(
      expect.objectContaining({ tool: "propose_plan", outcome: "failed", failureCategory: "invalid-state" }),
    )
    expect(result.terminal?.kind).toBe("needs_clarification")
  })

  it("requires needs_clarification to include every evaluator failure", async () => {
    const provider = providerWith(
      evaluateResponse(failingCandidate()),
      clarifyResponse({
        message: "What should lunch be?",
        reasonCodes: ["missing_slot"],
        interaction: { kind: "reply" },
      }),
      clarifyResponse({
        message: "Keep a familiar dish for the mornings.",
        reasonCodes: ["unfamiliar_dish_not_allowed"],
        interaction: { kind: "reply" },
      }),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: "plan" }], { context: context() })
    expect(result.toolExecutions).toContainEqual(
      expect.objectContaining({ tool: "needs_clarification", outcome: "failed", failureCategory: "invalid-state" }),
    )
    expect(result.terminal).toMatchObject({ kind: "needs_clarification", reasonCodes: ["unfamiliar_dish_not_allowed"] })
  })

  it("rejects propose_plan when a revision's raw feedback is left unrepresented", async () => {
    const raw = [{ id: "tg-1", text: "Wed lunch: too oily" }]
    const provider = providerWith(
      evaluateResponse(passingCandidate()),
      proposeResponse(proposeInput(passingCandidate(), [{ id: "tg-other", text: "ignored" }])),
      clarifyResponse({
        message: "Which meal should change?",
        reasonCodes: ["missing_slot"],
        interaction: { kind: "reply" },
      }),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: "less oily" }], {
      context: context({ request: { kind: "revision", text: "less oily" }, feedbackItems: raw }),
    })
    expect(result.toolExecutions).toContainEqual(
      expect.objectContaining({ tool: "propose_plan", outcome: "failed", failureCategory: "invalid-state" }),
    )
    expect(result.terminal?.kind).toBe("needs_clarification")
  })

  it("accepts a revision propose_plan when every raw feedback item is represented", async () => {
    const raw = [{ id: "tg-1", text: "Wed lunch: too oily" }]
    const provider = providerWith(
      evaluateResponse(passingCandidate()),
      proposeResponse(proposeInput(passingCandidate(), raw)),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: "less oily" }], {
      context: context({ request: { kind: "revision", text: "less oily" }, feedbackItems: raw }),
    })
    expect(result.completed).toBe(true)
    expect(result.terminal).toMatchObject({ kind: "propose_plan" })
    if (result.terminal?.kind === "propose_plan") expect(result.terminal.feedbackItems).toEqual(raw)
  })

  it("never exposes opaque feedback ids in a clarification message", async () => {
    const provider = providerWith(
      clarifyResponse({
        message: "Please confirm the tg-1 request",
        reasonCodes: ["missing_slot"],
        interaction: { kind: "reply" },
      }),
      clarifyResponse({
        message: "Please confirm the Wednesday lunch change",
        reasonCodes: ["missing_slot"],
        interaction: { kind: "reply" },
      }),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: "less oily" }], {
      context: context({
        request: { kind: "revision", text: "less oily" },
        feedbackItems: [{ id: "tg-1", text: "Wed lunch: too oily" }],
      }),
    })
    expect(result.toolExecutions).toContainEqual(
      expect.objectContaining({ tool: "needs_clarification", outcome: "failed", failureCategory: "invalid-state" }),
    )
    expect(result.terminal).toMatchObject({ kind: "needs_clarification" })
  })
})

describe("corpus-driven planning loop", () => {
  const scenarios = loadScenarios()

  it.each(
    scenarios.map((scenario) => [scenario.id, scenario] as const),
  )("accepts every passing candidate of %s", async (_id, scenario) => {
    for (const candidate of scenario.candidates.filter((entry) => entry.expect.pass)) {
      const provider = providerWith(
        evaluateResponse(candidate.plan),
        proposeResponse(
          proposeInput(candidate.plan, scenario.context.feedbackItems, {
            weeklyInventory: scenario.context.weeklyInventory,
            weeklyExceptions: scenario.context.weeklyExceptions,
          }),
        ),
      )
      const result = await runMealPlanningAgentSession(
        provider,
        [{ role: "user", text: scenario.context.request.text }],
        { context: scenario.context },
      )
      expect(result.completed, `${scenario.id}/${candidate.label}`).toBe(true)
      expect(result.terminal?.kind, `${scenario.id}/${candidate.label}`).toBe("propose_plan")
      if (result.terminal?.kind === "propose_plan")
        expect(result.terminal.evaluation.pass, `${scenario.id}/${candidate.label}`).toBe(true)
    }
  })

  it.each(
    scenarios
      .filter((scenario) => scenario.behavior?.expectsClarification)
      .map((scenario) => [scenario.id, scenario] as const),
  )("ends a clarification scenario in needs_clarification with the expected policy outcomes", async (_id, scenario) => {
    const driving = scenario.candidates.find((candidate) => !candidate.expect.pass) ?? scenario.candidates[0]
    if (!driving) throw new Error(`${scenario.id} has no candidate to drive a clarification`)
    const evaluation = evaluateMealPlan(driving.plan, scenario.context)
    const reasonCodes = [...new Set(evaluation.failures.map((failure) => failure.code))]
    if (reasonCodes.length === 0)
      throw new Error(`${scenario.id} needs a failing candidate to drive needs_clarification`)
    const provider = providerWith(
      evaluateResponse(driving.plan),
      clarifyResponse({
        message: "Please clarify before I finalize the plan.",
        reasonCodes,
        interaction: { kind: "reply" },
      }),
    )
    const result = await runMealPlanningAgentSession(
      provider,
      [{ role: "user", text: scenario.context.request.text }],
      { context: scenario.context },
    )
    expect(result.terminal?.kind, scenario.id).toBe("needs_clarification")
    if (result.terminal?.kind === "needs_clarification")
      expect(result.terminal.reasonCodes, scenario.id).toEqual(reasonCodes)
    for (const [key, value] of Object.entries(scenario.behavior?.expectedPolicyOutcomes ?? {})) {
      expect(driving.plan.policyOutcomes[key]?.outcome, `${scenario.id} policy ${key}`).toBe(value)
    }
  })
})
