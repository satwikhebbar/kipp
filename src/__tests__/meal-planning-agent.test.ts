import { describe, expect, it, vi } from "vitest"
import { MEAL_PLANNING_AGENT_PROMPT, runMealPlanningAgentSession } from "../agent/meal-planning-session"
import { loadScenarios } from "../meal-planning/corpus/load"
import { evaluateMealPlan } from "../meal-planning/evaluation"
import type { MealCell, MealDefinition, MealGrid, MealPlanCandidate, MealPlanContext, MealPlanSelectionCandidate } from "../meal-planning/types"
import type { ToolProviderClient } from "../providers"

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const SLOT_COOK: Record<string, number> = { breakfast: 15, snack1: 0, snack2: 0, "school-lunch": 20, "home-lunch": 20 }

function fixtureIngredients(dish: string, slot: string): string[] {
  if (dish === "paratha") return slot === "school-lunch" || slot === "home-lunch" ? ["rice"] : ["wheat flour"]
  if (dish === "rice and beans") return ["rice", "beans"]
  if (dish === "paneer paratha") return ["wheat flour", "paneer"]
  if (dish === "banana") return ["banana"]
  return ["rice"]
}

function fixtureDefinition(dish: string, slot: string, items = fixtureIngredients(dish, slot), cookMinutes = SLOT_COOK[slot]): MealDefinition {
  return {
    id: `fixture_${dish.replaceAll(" ", "_")}_${slot}`,
    name: dish,
    principalIngredients: items,
    vegetarian: true,
    suitableSlots: [slot],
    packedFood: { suitable: true, dry: true },
    typicalCookMinutes: cookMinutes,
    priorNightPrep: "none",
    requiredIngredients: items,
    optionalIngredients: [],
    status: "established",
  }
}

const FIXTURE_DEFINITIONS = ["paratha", "poha", "banana", "rice and beans", "paneer paratha", "khichdi", "idli"]
  .flatMap((dish) => Object.keys(SLOT_COOK).map((slot) => fixtureDefinition(dish, slot)))

function selectionCandidate(candidate: MealPlanCandidate): MealPlanSelectionCandidate {
  return {
    ...candidate,
    grid: Object.fromEntries(Object.entries(candidate.grid).map(([day, slots]) => [day, Object.fromEntries(
      Object.entries(slots).map(([slot, cell]) => [slot, { mealDefinitionId: `fixture_${cell.dish.replaceAll(" ", "_")}_${slot}` }]),
    )])),
  }
}

function contextWithCandidateDefinitions(context: MealPlanContext, candidate: MealPlanCandidate): MealPlanContext {
  const definitions = new Map<string, MealDefinition>()
  for (const slots of Object.values(candidate.grid)) {
    for (const [slot, cell] of Object.entries(slots)) {
      const id = `fixture_${cell.dish.replaceAll(" ", "_")}_${slot}`
      if (!definitions.has(id)) {
        definitions.set(id, {
          id,
          name: cell.dish,
          principalIngredients: cell.items,
          vegetarian: true,
          suitableSlots: [slot],
          packedFood: { suitable: true, dry: true },
          typicalCookMinutes: cell.cookMinutes,
          priorNightPrep: cell.priorNightPrep ? "required" : "none",
          requiredIngredients: cell.items,
          optionalIngredients: [],
          status: "established",
        })
      }
    }
  }
  return { ...context, profile: { ...context.profile, mealDefinitions: [...definitions.values()] } }
}

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

function passingCandidate(): MealPlanCandidate {
  return {
    grid: gridWith("Mon", "breakfast", cell("paratha", ["wheat flour"], "breakfast")),
    easyBuys: [],
    policyOutcomes: {},
  }
}

function failingCandidate(): MealPlanCandidate {
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
      mealDefinitions: FIXTURE_DEFINITIONS,
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
  return { toolCalls: [call("evaluate", "evaluate_meal_plan", selectionCandidate(candidate as MealPlanCandidate))], usage: { inputTokens: 0, outputTokens: 0 } }
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
    candidate: selectionCandidate(candidate as MealPlanCandidate),
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
        reasonCodes: ["unknown_meal_definition"],
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
        reasonCodes: ["unknown_meal_definition"],
        interaction: { kind: "reply" },
      }),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: "plan" }], { context: context() })
    expect(result.toolExecutions).toContainEqual(
      expect.objectContaining({ tool: "needs_clarification", outcome: "failed", failureCategory: "invalid-state" }),
    )
    expect(result.terminal).toMatchObject({ kind: "needs_clarification", reasonCodes: ["unknown_meal_definition"] })
  })

  it("allows a targeted clarification with no evaluator failure for vague feedback", async () => {
    const provider = providerWith(
      clarifyResponse({
        message: "What should improve most: speed, nutrition, packing dryness, preference, or inventory use?",
        reasonCodes: [],
        interaction: { kind: "reply" },
      }),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: "Make this better." }], {
      context: context({
        request: { kind: "revision", text: "Make this better." },
        feedbackItems: [{ id: "tg-vague", text: "Make this better." }],
      }),
    })
    expect(result.completed).toBe(true)
    expect(result.terminal).toMatchObject({ kind: "needs_clarification", reasonCodes: [] })
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

  it("rejects propose_plan when a submitted feedback item alters the authoritative item", async () => {
    const raw = [{ id: "tg-1", text: "Wed lunch: too oily" }]
    const provider = providerWith(
      evaluateResponse(passingCandidate()),
      proposeResponse(proposeInput(passingCandidate(), [{ id: "tg-1", text: "rewritten: change dinner" }])),
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

  it("evaluates a scoped authoritative feedback item even when the model omits it from the submission", async () => {
    const raw = [
      { id: "tg-A", text: "Wed lunch: prefer poha", scope: { day: "Wed", slot: "home-lunch" as const } },
      { id: "tg-B", text: "Wed snack: add banana", scope: { day: "Wed", slot: "snack1" as const } },
    ]
    const recentPlan = gridWith("Wed", "home-lunch", cell("khichdi", ["rice"], "home-lunch"))
    recentPlan.Wed.snack1 = cell("khichdi", ["rice"], "snack1")
    const candidate = gridWith("Wed", "home-lunch", cell("poha", ["rice"], "home-lunch"))
    candidate.Wed.snack1 = cell("banana", ["banana"], "snack1")
    const submission = {
      grid: candidate,
      easyBuys: [] as string[],
      policyOutcomes: { "household-rule": { outcome: "satisfied", rationale: "tg-A tg-B" } },
    }
    // The model submits only B; A is dropped from feedbackItems yet its target
    // cell (Wed home-lunch) is changed and its id appears in a rationale. The
    // evaluator must still see A so that cell change is recognized as scoped.
    const provider = providerWith(evaluateResponse(submission), proposeResponse(proposeInput(submission, [raw[1]])))
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: "make these two changes" }], {
      context: context({
        request: { kind: "revision", text: "make these two changes" },
        feedbackItems: raw,
        recentPlan,
        profile: {
          ...context().profile,
          dishRepertoire: ["paratha", "poha", "banana"],
          pantryBaseline: ["wheat flour", "rice", "banana"],
        },
      }),
    })
    expect(result.completed).toBe(true)
    expect(result.terminal?.kind).toBe("propose_plan")
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

  it("keeps evaluate_meal_plan available after a successful evaluation so the model can revise before proposing", async () => {
    const provider = providerWith(
      evaluateResponse(passingCandidate()),
      evaluateResponse(passingCandidate()),
      proposeResponse(proposeInput(passingCandidate())),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: "plan" }], { context: context() })
    expect(result.completed).toBe(true)
    expect(result.providerTurns).toBe(3)
    expect(result.toolExecutions).toEqual([
      { tool: "evaluate_meal_plan", outcome: "succeeded" },
      { tool: "evaluate_meal_plan", outcome: "succeeded" },
      { tool: "propose_plan", outcome: "succeeded" },
    ])
    expect(result.terminal).toMatchObject({ kind: "propose_plan" })
  })

  it("keeps the planning prompt policy-agnostic (no hardcoded custom-policy ids)", () => {
    for (const id of [
      "snack-policy",
      "equipment-gap",
      "packing-capacity",
      "nutrition-target-fruit",
      "nutrition-target-nuts",
      "school-rule",
      "cheat-day",
    ]) {
      expect(MEAL_PLANNING_AGENT_PROMPT, `${id} must not be hardcoded`).not.toContain(id)
    }
    expect(MEAL_PLANNING_AGENT_PROMPT).toContain("Plans default to healthy, nutritious meals")
  })

  it("accepts a plan whose ingredients come from inventory supplied at propose time, even when the context inventory is empty", async () => {
    const ctx = context({
      weeklyInventory: { items: [], notes: [] },
      profile: { ...context().profile, dishRepertoire: ["paratha", "rice and beans"] },
      request: { kind: "initial_plan", text: "I have beans, carrots, bottle gourd, peas, bananas and apples." },
    })
    const candidate = {
      ...passingCandidate(),
      grid: gridWith("Mon", "home-lunch", cell("rice and beans", ["rice", "beans"], "home-lunch")),
      easyBuys: ["beans", "carrots"],
    }
    const supplied = {
      items: [
        { name: "beans", status: "available" as const },
        { name: "carrots", status: "available" as const },
      ],
      notes: [],
    }
    const provider = providerWith(
      evaluateResponse(candidate),
      proposeResponse(
        proposeInput(candidate, undefined, { weeklyInventory: supplied, weeklyExceptions: ctx.weeklyExceptions }),
      ),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: ctx.request.text }], {
      context: ctx,
    })
    expect(result.completed).toBe(true)
    if (result.terminal?.kind === "propose_plan")
      expect(result.terminal.weeklyInventory.items.map((item) => item.name)).toEqual(
        expect.arrayContaining(["beans", "carrots"]),
      )
  })

  it("rejects a proposal that resolves conflicting feedback by violating a hard exclusion", async () => {
    const ctx = context({
      profile: {
        ...context().profile,
        dishRepertoire: ["paratha", "paneer paratha"],
        dietaryExclusions: ["paneer"],
        pantryBaseline: [...context().profile.pantryBaseline, "paneer"],
      },
      request: { kind: "revision", text: "No dairy, but make lunch paneer" },
      feedbackItems: [{ id: "tg-1", text: "Make lunch paneer" }],
    })
    const candidate = {
      ...passingCandidate(),
      grid: gridWith("Mon", "school-lunch", cell("paneer paratha", ["wheat flour", "paneer"], "school-lunch")),
    }
    const provider = providerWith(
      evaluateResponse(candidate),
      proposeResponse(
        proposeInput(candidate, ctx.feedbackItems, {
          weeklyInventory: ctx.weeklyInventory,
          weeklyExceptions: ctx.weeklyExceptions,
        }),
      ),
      clarifyResponse({
        message: "Paneer is excluded this week — should lunch stay dairy-free?",
        reasonCodes: ["hard_exclusion"],
        interaction: { kind: "reply" },
      }),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: ctx.request.text }], {
      context: ctx,
    })
    expect(result.completed).toBe(true)
    expect(result.toolExecutions).toContainEqual(
      expect.objectContaining({ tool: "propose_plan", outcome: "failed", failureCategory: "invalid-state" }),
    )
    expect(result.terminal).toMatchObject({ kind: "needs_clarification", reasonCodes: ["hard_exclusion"] })
  })

  it("accepts a revision that declares a mid-week holiday and drops that day without a missing_slot", async () => {
    const ctx = context({
      request: { kind: "revision", text: "Tomorrow is a holiday" },
      weeklyExceptions: { items: [{ kind: "school_closed", appliesTo: { day: "Wed" }, instruction: "Holiday" }] },
    })
    const grid: MealGrid = {}
    for (const day of DAYS) {
      if (day === "Wed") continue
      grid[day] = {}
      for (const slot of Object.keys(SLOT_COOK)) {
        grid[day][slot] = cell(
          "paratha",
          slot === "school-lunch" || slot === "home-lunch" ? ["rice"] : ["wheat flour"],
          slot,
        )
      }
    }
    const candidate = { grid, easyBuys: [], policyOutcomes: {} }
    const provider = providerWith(
      evaluateResponse(candidate),
      proposeResponse(
        proposeInput(candidate, undefined, {
          weeklyInventory: ctx.weeklyInventory,
          weeklyExceptions: ctx.weeklyExceptions,
        }),
      ),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: ctx.request.text }], {
      context: ctx,
    })
    expect(result.completed).toBe(true)
    if (result.terminal?.kind === "propose_plan")
      expect(result.terminal.evaluation.failures.filter((failure) => failure.day === "Wed")).toEqual([])
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
        { context: contextWithCandidateDefinitions(scenario.context, candidate.plan) },
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
        { context: contextWithCandidateDefinitions(scenario.context, driving.plan) },
    )
    expect(result.terminal?.kind, scenario.id).toBe("needs_clarification")
    if (result.terminal?.kind === "needs_clarification")
      expect(result.terminal.reasonCodes, scenario.id).toEqual(reasonCodes)
    for (const [key, value] of Object.entries(scenario.behavior?.expectedPolicyOutcomes ?? {})) {
      expect(driving.plan.policyOutcomes[key]?.outcome, `${scenario.id} policy ${key}`).toBe(value)
    }
  })
})
