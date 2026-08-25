import { describe, expect, it } from "vitest"
import { evaluateMealPlan } from "../meal-planning/evaluation"
import type { MealCell, MealGrid, MealPlanCandidate, MealPlanContext } from "../meal-planning/types"

const SLOT_COOK: Record<string, number> = {
  breakfast: 15,
  snack1: 0,
  snack2: 0,
  "school-lunch": 20,
  "home-lunch": 20,
}

const DISHES: Record<string, { ingredients: string[]; inventory: string[] }> = {
  paratha: { ingredients: ["wheat flour"], inventory: ["wheat flour"] },
  banana: { ingredients: ["banana"], inventory: ["banana"] },
  "roasted moong": { ingredients: ["moong dal"], inventory: ["moong dal"] },
  "bottle gourd dal": { ingredients: ["bottle gourd", "moong dal"], inventory: ["bottle gourd", "moong dal"] },
  "rice and beans": { ingredients: ["rice", "beans"], inventory: ["rice", "beans"] },
  "paneer paratha": { ingredients: ["wheat flour", "paneer"], inventory: ["wheat flour"] },
  "ghee rice": { ingredients: ["rice", "ghee"], inventory: ["rice"] },
}

const REPERTOIRE = ["paratha", "banana", "roasted moong", "bottle gourd dal", "rice and beans"]
const FREQUENT = ["wheat flour", "banana", "moong dal", "bottle gourd", "rice", "beans", "oil", "spices", "salt"]

function cellFor(slot: string, dish: string): MealCell {
  const info = DISHES[dish] ?? { ingredients: [dish], inventory: [dish] }
  return {
    dish,
    vegetarian: true,
    ingredients: [...info.ingredients],
    inventoryItems: [...info.inventory],
    cookMinutes: SLOT_COOK[slot] ?? 0,
    priorNightPrep: false,
  }
}

function gridFrom(rows: Array<[string, string, string]>): MealGrid {
  const grid: MealGrid = {}
  for (const [day, slot, dish] of rows) {
    grid[day] ??= {}
    grid[day][slot] = cellFor(slot, dish)
  }
  return grid
}

function baseContext(overrides: Partial<MealPlanContext> = {}): MealPlanContext {
  return {
    schedule: {
      days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
      slots: [
        { id: "breakfast", name: "Breakfast", packed: false, dry: false, maxCookMinutes: null },
        { id: "snack1", name: "Snack 1", packed: true, dry: true, maxCookMinutes: 0 },
        { id: "snack2", name: "Snack 2", packed: true, dry: true, maxCookMinutes: 0 },
        { id: "school-lunch", name: "School lunch", packed: true, dry: false, maxCookMinutes: null },
        { id: "home-lunch", name: "Home lunch", packed: false, dry: false, maxCookMinutes: null },
      ],
    },
    profile: {
      dietaryExclusions: [
        { token: "peanut", ambiguous: false },
        { token: "dairy", ambiguous: true },
      ],
      dishRepertoire: REPERTOIRE,
      foodPreferences: { favourites: REPERTOIRE, avoid: [] },
      allowNewFoods: false,
      sensoryGuidelines: [],
      morningCookingBudgetMinutes: 40,
      priorNightPrepAllowed: false,
      pantryBaseline: ["rice", "wheat flour", "oil", "spices", "moong dal", "ghee"],
      allowFrequentIngredients: FREQUENT,
    },
    customPolicies: [
      { id: "snack-policy", label: "Snack policy", scope: "persistent", value: "Snacks dry and quick." },
    ],
    weeklyInventory: {
      items: [
        { name: "banana", status: "available" },
        { name: "bottle gourd", status: "available" },
        { name: "beans", status: "available" },
      ],
      notes: [],
    },
    weeklyExceptions: { items: [{ kind: "school_closed", appliesTo: { day: "Sat" }, instruction: "Holiday" }] },
    recentPlan: null,
    request: { kind: "initial_plan", text: "Plan normally." },
    ...overrides,
  }
}

const FULL_SLOTS: Array<[string, string]> = [
  ["breakfast", "paratha"],
  ["snack1", "banana"],
  ["snack2", "roasted moong"],
  ["school-lunch", "bottle gourd dal"],
  ["home-lunch", "rice and beans"],
]

function baseCandidate(overrides: Partial<MealPlanCandidate> = {}): MealPlanCandidate {
  const rows: Array<[string, string, string]> = []
  for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri"]) {
    for (const [slot, dish] of FULL_SLOTS) rows.push([day, slot, dish])
  }
  return {
    grid: gridFrom(rows),
    easyBuys: [],
    policyOutcomes: { "snack-policy": { outcome: "satisfied", rationale: "Snacks are dry and quick." } },
    ...overrides,
  }
}

function failureCodes(evaluation: ReturnType<typeof evaluateMealPlan>): string[] {
  return evaluation.failures.map((failure) => failure.code)
}

describe("meal-planning evaluator", () => {
  it("passes a valid full week and reports its measurements", () => {
    const evaluation = evaluateMealPlan(baseCandidate(), baseContext())
    expect(evaluation.pass).toBe(true)
    expect(evaluation.failures).toEqual([])
    expect(evaluation.measurements).toMatchObject({
      morningCookMax: 35,
      priorNightPrepMax: 0,
      dishRepeatCount: 0,
      principalIngredientMax: 0,
      easyBuyCount: 0,
    })
  })

  it("enforces clear dietary exclusions but not ambiguous ones", () => {
    const candidate = baseCandidate()
    candidate.grid.Mon.breakfast.ingredients.push("peanut")
    expect(failureCodes(evaluateMealPlan(candidate, baseContext()))).toEqual(["hard_exclusion"])

    const ambiguousCandidate = baseCandidate()
    ambiguousCandidate.grid.Mon.breakfast.ingredients.push("dairy")
    expect(evaluateMealPlan(ambiguousCandidate, baseContext()).pass).toBe(true)
  })

  it("flags a non-vegetarian cell on a school day", () => {
    const candidate = baseCandidate()
    candidate.grid.Tue["school-lunch"].vegetarian = false
    const evaluation = evaluateMealPlan(candidate, baseContext())
    expect(failureCodes(evaluation)).toEqual(["non_vegetarian_school_meal"])
  })

  it("flags a missing required slot", () => {
    const candidate = baseCandidate()
    delete candidate.grid.Mon.snack1
    const evaluation = evaluateMealPlan(candidate, baseContext())
    expect(failureCodes(evaluation)).toEqual(["missing_slot"])
    expect(evaluation.failures[0]).toMatchObject({ code: "missing_slot", day: "Mon", slot: "snack1" })
  })

  it("flags a cell on a school-closed day", () => {
    const candidate = baseCandidate()
    candidate.grid.Sat = { breakfast: cellFor("breakfast", "paratha") }
    expect(failureCodes(evaluateMealPlan(candidate, baseContext()))).toEqual(["extra_slot_for_closed_day"])
  })

  it("flags combined morning cooking over the budget", () => {
    const candidate = baseCandidate()
    candidate.grid.Mon["school-lunch"].cookMinutes = 30
    const evaluation = evaluateMealPlan(candidate, baseContext())
    expect(failureCodes(evaluation)).toEqual(["morning_capacity_exceeded"])
    expect(evaluation.failures[0]?.day).toBe("Mon")
  })

  it("flags prior-night prep when it is not allowed", () => {
    const candidate = baseCandidate()
    candidate.grid.Mon.breakfast.priorNightPrep = true
    expect(failureCodes(evaluateMealPlan(candidate, baseContext()))).toEqual(["prior_night_prep_not_allowed"])
  })

  it("flags more than two prior-night-prep cells on one day", () => {
    const context = baseContext()
    context.profile.priorNightPrepAllowed = true
    const candidate = baseCandidate()
    candidate.grid.Mon.breakfast.priorNightPrep = true
    candidate.grid.Mon.snack1.priorNightPrep = true
    candidate.grid.Mon["school-lunch"].priorNightPrep = true
    const evaluation = evaluateMealPlan(candidate, context)
    expect(failureCodes(evaluation)).toEqual(["prior_night_prep_limit"])
    expect(evaluation.measurements.priorNightPrepMax).toBe(3)
  })

  it("flags a cooked snack in a dry, zero-minute slot", () => {
    const candidate = baseCandidate()
    candidate.grid.Mon.snack1.cookMinutes = 5
    const evaluation = evaluateMealPlan(candidate, baseContext())
    expect(failureCodes(evaluation)).toEqual(["slot_unsuitable"])
    expect(evaluation.failures[0]).toMatchObject({ code: "slot_unsuitable", day: "Mon", slot: "snack1" })
  })

  it("flags inventory items that are unknown and those that are unavailable", () => {
    const unknown = baseCandidate()
    unknown.grid.Mon.breakfast.inventoryItems.push("paneer")
    expect(failureCodes(evaluateMealPlan(unknown, baseContext()))).toEqual(["inventory_item_unknown"])

    const context = baseContext()
    context.weeklyInventory.items.push({ name: "paneer", status: "unavailable" })
    const unavailable = baseCandidate()
    unavailable.grid.Mon.breakfast.inventoryItems.push("paneer")
    expect(failureCodes(evaluateMealPlan(unavailable, context))).toEqual(["inventory_item_unavailable"])
  })

  it("flags use-early items first used after the urgent deadline", () => {
    const context = baseContext()
    context.weeklyInventory.items[1].useNote = "use early"
    context.requireUrgentUseEarly = true
    context.urgentUseByDay = "Tue"

    const onTime = baseCandidate()
    expect(evaluateMealPlan(onTime, context).pass).toBe(true)

    const late = baseCandidate()
    late.grid.Mon["school-lunch"] = cellFor("school-lunch", "roasted moong")
    late.grid.Tue["school-lunch"] = cellFor("school-lunch", "roasted moong")
    const evaluation = evaluateMealPlan(late, context)
    expect(failureCodes(evaluation)).toEqual(["use_early_ignored"])
    expect(evaluation.measurements.urgentUseByDay).toBe("Wed")
  })

  it("flags unrequested dish repeats but exempts favourites and requested repeats", () => {
    const context = baseContext({
      schedule: {
        days: ["Mon", "Tue"],
        slots: [{ id: "breakfast", name: "Breakfast", packed: false, dry: false, maxCookMinutes: null }],
      },
      profile: {
        ...baseContext().profile,
        dishRepertoire: ["paratha", "banana"],
        foodPreferences: { favourites: [], avoid: [] },
      },
      customPolicies: [],
    })
    const candidate: MealPlanCandidate = {
      grid: gridFrom([
        ["Mon", "breakfast", "paratha"],
        ["Tue", "breakfast", "paratha"],
      ]),
      easyBuys: [],
      policyOutcomes: {},
    }
    const repeated = evaluateMealPlan(candidate, context)
    expect(failureCodes(repeated)).toEqual(["dish_repeated"])
    expect(repeated.measurements.dishRepeats).toEqual(["paratha"])

    const favourite = baseContext({
      schedule: context.schedule,
      profile: { ...context.profile, foodPreferences: { favourites: ["paratha"], avoid: [] } },
      customPolicies: [],
    })
    expect(evaluateMealPlan(candidate, favourite).pass).toBe(true)

    const requested = baseContext({
      schedule: context.schedule,
      profile: { ...context.profile, foodPreferences: { favourites: [], avoid: [] } },
      customPolicies: [],
      requestedRepeats: ["paratha"],
    })
    expect(evaluateMealPlan(candidate, requested).pass).toBe(true)
  })

  it("flags a principal ingredient used in more than two cells", () => {
    const context = baseContext({
      schedule: {
        days: ["Mon", "Tue"],
        slots: [
          { id: "breakfast", name: "Breakfast", packed: false, dry: false, maxCookMinutes: null },
          { id: "snack1", name: "Snack 1", packed: true, dry: true, maxCookMinutes: 0 },
          { id: "school-lunch", name: "School lunch", packed: true, dry: false, maxCookMinutes: null },
        ],
      },
      profile: {
        ...baseContext().profile,
        dishRepertoire: [...REPERTOIRE, "paneer paratha"],
        foodPreferences: { favourites: [...REPERTOIRE, "paneer paratha"], avoid: [] },
      },
      customPolicies: [],
    })
    const rows: Array<[string, string, string]> = []
    for (const day of ["Mon", "Tue"]) {
      for (const slot of ["breakfast", "snack1", "school-lunch"]) rows.push([day, slot, "paneer paratha"])
    }
    const candidate: MealPlanCandidate = { grid: gridFrom(rows), easyBuys: [], policyOutcomes: {} }
    const evaluation = evaluateMealPlan(candidate, context)
    expect(failureCodes(evaluation)).toEqual(["principal_ingredient_overused"])
    expect(evaluation.measurements.principalIngredientMax).toBe(6)
    expect(evaluation.measurements.principalIngredientOverused).toEqual(["paneer"])
  })

  it("rejects unfamiliar dishes when new foods are disallowed", () => {
    const candidate = baseCandidate()
    candidate.grid.Mon.breakfast = cellFor("breakfast", "paneer paratha")
    const evaluation = evaluateMealPlan(candidate, baseContext())
    expect(failureCodes(evaluation)).toEqual(["unfamiliar_dish_not_allowed"])
  })

  it("requires new dishes to be paired with familiar food when new foods are allowed", () => {
    const context = baseContext({
      schedule: {
        days: ["Mon"],
        slots: [
          { id: "breakfast", name: "Breakfast", packed: false, dry: false, maxCookMinutes: null },
          { id: "snack1", name: "Snack 1", packed: true, dry: true, maxCookMinutes: 0 },
        ],
      },
      profile: { ...baseContext().profile, allowNewFoods: true },
      customPolicies: [],
    })
    const paired: MealPlanCandidate = {
      grid: gridFrom([
        ["Mon", "breakfast", "paneer paratha"],
        ["Mon", "snack1", "banana"],
      ]),
      easyBuys: [],
      policyOutcomes: {},
    }
    expect(evaluateMealPlan(paired, context).pass).toBe(true)

    const unpaired: MealPlanCandidate = {
      grid: gridFrom([
        ["Mon", "breakfast", "paneer paratha"],
        ["Mon", "snack1", "ghee rice"],
      ]),
      easyBuys: [],
      policyOutcomes: {},
    }
    expect(failureCodes(evaluateMealPlan(unpaired, context))).toEqual(["unpaired_new_dish", "unpaired_new_dish"])
  })

  it("requires a recorded outcome for every persistent custom policy", () => {
    const candidate = baseCandidate()
    candidate.policyOutcomes = {}
    expect(failureCodes(evaluateMealPlan(candidate, baseContext()))).toEqual(["missing_policy_outcome"])
  })

  it("flags cell changes outside the feedback scope on a revision", () => {
    const context = baseContext({
      request: { kind: "revision", text: "Change the Tuesday school lunch." },
      feedbackItems: [{ id: "fb-1", text: "Make Tuesday lunch lighter.", scope: { day: "Tue", slot: "school-lunch" } }],
    })
    context.recentPlan = baseCandidate().grid

    const scoped = baseCandidate()
    scoped.grid.Tue["school-lunch"] = cellFor("school-lunch", "roasted moong")
    expect(evaluateMealPlan(scoped, context).pass).toBe(true)

    const outOfScope = baseCandidate()
    outOfScope.grid.Wed.breakfast = cellFor("breakfast", "banana")
    outOfScope.policyOutcomes["snack-policy"] = { outcome: "satisfied", rationale: "Discussed in fb-1." }
    const evaluation = evaluateMealPlan(outOfScope, context)
    expect(failureCodes(evaluation)).toEqual(["unscoped_cell_changed"])
    expect(evaluation.failures[0]).toMatchObject({ code: "unscoped_cell_changed", day: "Wed", slot: "breakfast" })
  })

  it("flags feedback that no changed cell or outcome rationale addresses", () => {
    const context = baseContext({
      request: { kind: "revision", text: "Fix the Tuesday school lunch." },
      feedbackItems: [{ id: "fb-1", text: "Make Tuesday lunch lighter.", scope: { day: "Tue", slot: "school-lunch" } }],
    })
    context.recentPlan = baseCandidate().grid
    const candidate = baseCandidate()
    expect(failureCodes(evaluateMealPlan(candidate, context))).toEqual(["unaddressed_feedback"])
  })

  it("skips slots dropped by half-day exceptions when checking coverage", () => {
    const context = baseContext({
      weeklyExceptions: {
        items: [
          { kind: "school_closed", appliesTo: { day: "Sat" }, instruction: "Holiday" },
          { kind: "half_day", appliesTo: { day: "Wed", mealSlots: ["home-lunch"] }, instruction: "Short day" },
        ],
      },
    })
    const candidate = baseCandidate()
    delete candidate.grid.Wed["home-lunch"]
    delete candidate.grid.Mon.snack2
    const evaluation = evaluateMealPlan(candidate, context)
    expect(failureCodes(evaluation)).toEqual(["missing_slot"])
    expect(evaluation.failures[0]).toMatchObject({ code: "missing_slot", day: "Mon", slot: "snack2" })
  })
})
