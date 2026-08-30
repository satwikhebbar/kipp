import { describe, expect, it } from "vitest"
import { loadScenarios } from "../meal-planning/corpus/load"
import { evaluateMealPlan, evaluateMealPlanSelection } from "../meal-planning/evaluation"
import { hydrateMealPlan } from "../meal-planning/hydration"
import { SEED_PROFILE, SEED_SCHEDULE } from "../meal-planning/store"
import type { MealCell, MealGrid, MealPlanCandidate, MealPlanContext } from "../meal-planning/types"

const SLOT_COOK: Record<string, number> = {
  breakfast: 15,
  snack1: 0,
  snack2: 0,
  "school-lunch": 20,
  "home-lunch": 20,
}

const DISHES: Record<string, { items: string[] }> = {
  paratha: { items: ["wheat flour"] },
  banana: { items: ["banana"] },
  "roasted moong": { items: ["moong dal"] },
  "bottle gourd dal": { items: ["bottle gourd", "moong dal"] },
  "rice and beans": { items: ["rice", "beans"] },
  "paneer paratha": { items: ["wheat flour", "paneer"] },
  "ghee rice": { items: ["rice", "ghee"] },
}

const REPERTOIRE = ["paratha", "banana", "roasted moong", "bottle gourd dal", "rice and beans"]

function cellFor(slot: string, dish: string): MealCell {
  const info = DISHES[dish] ?? { items: [dish] }
  return {
    dish,
    vegetarian: true,
    items: [...info.items],
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
      dietaryExclusions: ["peanut"],
      dishRepertoire: REPERTOIRE,
      foodPreferences: { favourites: REPERTOIRE, avoid: [] },
      allowNewFoods: false,
      sensoryGuidelines: [],
      morningCookingBudgetMinutes: 40,
      priorNightPrepAllowed: false,
      pantryBaseline: ["rice", "wheat flour", "oil", "spices", "moong dal", "ghee", "paneer"],
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
      easyBuyCount: 0,
    })
  })

  it("enforces dietary exclusions", () => {
    const context = baseContext()
    context.profile.pantryBaseline = [...context.profile.pantryBaseline, "peanut", "dairy"]
    const candidate = baseCandidate()
    candidate.grid.Mon.breakfast.items.push("peanut")
    expect(failureCodes(evaluateMealPlan(candidate, context))).toEqual(["hard_exclusion"])

    const notExcluded = baseCandidate()
    notExcluded.grid.Mon.breakfast.items.push("dairy")
    expect(evaluateMealPlan(notExcluded, context).pass).toBe(true)
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
    unknown.grid.Mon.breakfast.items.push("cashew")
    expect(failureCodes(evaluateMealPlan(unknown, baseContext()))).toEqual(["inventory_item_unknown"])

    const context = baseContext()
    context.weeklyInventory.items.push({ name: "cashew", status: "unavailable" })
    const unavailable = baseCandidate()
    unavailable.grid.Mon.breakfast.items.push("cashew")
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

  it("does not flag dishes that appear only in the recent plan, only overlaps with the candidate", () => {
    const schedule = {
      days: ["Mon", "Tue"],
      slots: [{ id: "breakfast", name: "Breakfast", packed: false, dry: false, maxCookMinutes: null }],
    }
    const profile = {
      ...baseContext().profile,
      dishRepertoire: ["paratha", "banana"],
      foodPreferences: { favourites: [], avoid: [] },
    }
    const candidate: MealPlanCandidate = {
      grid: gridFrom([
        ["Mon", "breakfast", "paratha"],
        ["Tue", "breakfast", "banana"],
      ]),
      easyBuys: [],
      policyOutcomes: {},
    }

    const historyOnly = baseContext({
      schedule,
      profile,
      customPolicies: [],
      recentPlan: {
        Mon: { breakfast: cellFor("breakfast", "ghee rice") },
        Tue: { breakfast: cellFor("breakfast", "paneer paratha") },
      },
    })
    const historyOnlyEval = evaluateMealPlan(candidate, historyOnly)
    expect(historyOnlyEval.pass).toBe(true)
    expect(historyOnlyEval.measurements.dishRepeats).toEqual([])

    const overlapping = baseContext({
      schedule,
      profile,
      customPolicies: [],
      recentPlan: { Mon: { breakfast: cellFor("breakfast", "paratha") } },
    })
    const overlappingEval = evaluateMealPlan(candidate, overlapping)
    expect(failureCodes(overlappingEval)).toEqual(["dish_repeated"])
    expect(overlappingEval.measurements.dishRepeats).toEqual(["paratha"])

    const overlappingExempt = baseContext({
      schedule,
      profile: { ...profile, foodPreferences: { favourites: ["paratha"], avoid: [] } },
      customPolicies: [],
      recentPlan: { Mon: { breakfast: cellFor("breakfast", "paratha") } },
    })
    expect(evaluateMealPlan(candidate, overlappingExempt).pass).toBe(true)
  })

  it("lets a snack-slot dish repeat from the recent plan but still flags cooked-meal repeats", () => {
    const schedule = {
      days: ["Mon", "Tue"],
      slots: [
        { id: "snack1", name: "Snack 1", packed: true, dry: true, maxCookMinutes: 0 },
        { id: "home-lunch", name: "Home lunch", packed: false, dry: false, maxCookMinutes: null },
      ],
    }
    const profile = {
      ...baseContext().profile,
      dishRepertoire: ["banana", "roasted moong", "bottle gourd dal", "rice and beans"],
      foodPreferences: { favourites: [], avoid: [] },
    }
    const context = baseContext({
      schedule,
      profile,
      customPolicies: [],
      weeklyExceptions: { items: [] },
      recentPlan: {
        Mon: { snack1: cellFor("snack1", "banana"), "home-lunch": cellFor("home-lunch", "rice and beans") },
        Tue: { snack1: cellFor("snack1", "banana") },
      },
    })
    const candidate: MealPlanCandidate = {
      grid: gridFrom([
        ["Mon", "snack1", "banana"],
        ["Mon", "home-lunch", "rice and beans"],
        ["Tue", "snack1", "roasted moong"],
        ["Tue", "home-lunch", "bottle gourd dal"],
      ]),
      easyBuys: [],
      policyOutcomes: {},
    }
    const evaluation = evaluateMealPlan(candidate, context)
    expect(failureCodes(evaluation)).toEqual(["dish_repeated"])
    expect(evaluation.measurements.dishRepeats).toEqual(["rice and beans"])
  })

  it("keeps unchanged revision cells from repeating recent-plan dishes", () => {
    const schedule = {
      days: ["Mon", "Tue"],
      slots: [{ id: "breakfast", name: "Breakfast", packed: false, dry: false, maxCookMinutes: null }],
    }
    const profile = {
      ...baseContext().profile,
      dishRepertoire: ["paratha", "banana", "poha"],
      foodPreferences: { favourites: [], avoid: [] },
    }
    const context = baseContext({
      schedule,
      profile,
      customPolicies: [],
      recentPlan: {
        Mon: { breakfast: cellFor("breakfast", "paratha") },
        Tue: { breakfast: cellFor("breakfast", "banana") },
      },
      request: { kind: "revision", text: "Revise Monday's breakfast." },
      feedbackItems: [{ id: "fb-1", text: "Swap Monday breakfast.", scope: { day: "Mon", slot: "breakfast" } }],
      weeklyInventory: {
        items: [
          { name: "banana", status: "available" },
          { name: "poha", status: "available" },
        ],
        notes: [],
      },
    })
    const candidate: MealPlanCandidate = {
      grid: gridFrom([
        ["Mon", "breakfast", "poha"],
        ["Tue", "breakfast", "banana"],
      ]),
      easyBuys: [],
      policyOutcomes: {},
    }
    const evaluation = evaluateMealPlan(candidate, context)
    expect(evaluation.pass).toBe(true)
    expect(evaluation.measurements.dishRepeats).toEqual([])
  })

  it("keeps a scoped non-dish edit to a carried-over meal free of dish_repeated", () => {
    const schedule = {
      days: ["Mon", "Tue"],
      slots: [{ id: "breakfast", name: "Breakfast", packed: false, dry: false, maxCookMinutes: null }],
    }
    const profile = {
      ...baseContext().profile,
      dishRepertoire: ["paratha", "banana", "poha"],
      foodPreferences: { favourites: [], avoid: [] },
    }
    const context = baseContext({
      schedule,
      profile,
      customPolicies: [],
      recentPlan: {
        Mon: { breakfast: cellFor("breakfast", "paratha") },
        Tue: { breakfast: cellFor("breakfast", "banana") },
      },
      request: { kind: "revision", text: "Speed up Monday's breakfast." },
      feedbackItems: [{ id: "fb-1", text: "Cook Monday breakfast faster.", scope: { day: "Mon", slot: "breakfast" } }],
      weeklyInventory: {
        items: [
          { name: "banana", status: "available" },
          { name: "poha", status: "available" },
        ],
        notes: [],
      },
    })
    const candidate: MealPlanCandidate = {
      grid: gridFrom([
        ["Mon", "breakfast", "paratha"],
        ["Tue", "breakfast", "banana"],
      ]),
      easyBuys: [],
      policyOutcomes: {},
    }
    candidate.grid.Mon.breakfast = { ...candidate.grid.Mon.breakfast, cookMinutes: 10, priorNightPrep: false }
    const evaluation = evaluateMealPlan(candidate, context)
    expect(failureCodes(evaluation)).toEqual([])
    expect(evaluation.measurements.dishRepeats).toEqual([])
  })

  it("flags a changed revision cell that newly repeats a recent-plan dish", () => {
    const schedule = {
      days: ["Mon", "Tue"],
      slots: [{ id: "breakfast", name: "Breakfast", packed: false, dry: false, maxCookMinutes: null }],
    }
    const profile = {
      ...baseContext().profile,
      dishRepertoire: ["paratha", "banana", "poha"],
      foodPreferences: { favourites: [], avoid: [] },
    }
    const context = baseContext({
      schedule,
      profile,
      customPolicies: [],
      recentPlan: {
        Mon: { breakfast: cellFor("breakfast", "paratha") },
        Tue: { breakfast: cellFor("breakfast", "banana") },
      },
      request: { kind: "revision", text: "Revise Monday's breakfast." },
      feedbackItems: [{ id: "fb-1", text: "Swap Monday breakfast.", scope: { day: "Mon", slot: "breakfast" } }],
      weeklyInventory: {
        items: [
          { name: "banana", status: "available" },
          { name: "poha", status: "available" },
        ],
        notes: [],
      },
    })
    const candidate: MealPlanCandidate = {
      grid: gridFrom([
        ["Mon", "breakfast", "banana"],
        ["Tue", "breakfast", "banana"],
      ]),
      easyBuys: [],
      policyOutcomes: {},
    }
    const evaluation = evaluateMealPlan(candidate, context)
    expect(failureCodes(evaluation)).toEqual(["dish_repeated"])
    expect(evaluation.measurements.dishRepeats).toEqual(["banana"])
  })

  it("exempts a changed revision cell that repeats a requested or favourite dish", () => {
    const schedule = {
      days: ["Mon", "Tue"],
      slots: [{ id: "breakfast", name: "Breakfast", packed: false, dry: false, maxCookMinutes: null }],
    }
    const profile = {
      ...baseContext().profile,
      dishRepertoire: ["paratha", "banana", "poha"],
      foodPreferences: { favourites: [], avoid: [] },
    }
    const context = baseContext({
      schedule,
      profile,
      customPolicies: [],
      recentPlan: {
        Mon: { breakfast: cellFor("breakfast", "paratha") },
        Tue: { breakfast: cellFor("breakfast", "banana") },
      },
      request: { kind: "revision", text: "Revise Monday's breakfast." },
      feedbackItems: [{ id: "fb-1", text: "Swap Monday breakfast.", scope: { day: "Mon", slot: "breakfast" } }],
      requestedRepeats: ["banana"],
      weeklyInventory: {
        items: [
          { name: "banana", status: "available" },
          { name: "poha", status: "available" },
        ],
        notes: [],
      },
    })
    const candidate: MealPlanCandidate = {
      grid: gridFrom([
        ["Mon", "breakfast", "banana"],
        ["Tue", "breakfast", "banana"],
      ]),
      easyBuys: [],
      policyOutcomes: {},
    }
    expect(evaluateMealPlan(candidate, context).pass).toBe(true)
  })

  it("flags an out-of-scope changed revision cell that newly repeats a recent-plan dish", () => {
    const schedule = {
      days: ["Mon", "Tue"],
      slots: [{ id: "breakfast", name: "Breakfast", packed: false, dry: false, maxCookMinutes: null }],
    }
    const profile = {
      ...baseContext().profile,
      dishRepertoire: ["paratha", "banana", "poha"],
      foodPreferences: { favourites: [], avoid: [] },
    }
    const context = baseContext({
      schedule,
      profile,
      customPolicies: [],
      recentPlan: {
        Mon: { breakfast: cellFor("breakfast", "paratha") },
        Tue: { breakfast: cellFor("breakfast", "banana") },
      },
      request: { kind: "revision", text: "Revise the plan." },
      feedbackItems: [{ id: "fb-1", text: "Keep Tuesday's breakfast.", scope: { day: "Tue", slot: "breakfast" } }],
      weeklyInventory: {
        items: [
          { name: "banana", status: "available" },
          { name: "poha", status: "available" },
        ],
        notes: [],
      },
    })
    const candidate: MealPlanCandidate = {
      grid: gridFrom([
        ["Mon", "breakfast", "banana"],
        ["Tue", "breakfast", "banana"],
      ]),
      easyBuys: [],
      policyOutcomes: {},
    }
    const evaluation = evaluateMealPlan(candidate, context)
    expect(failureCodes(evaluation)).toEqual(["dish_repeated", "unaddressed_feedback", "unscoped_cell_changed"])
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

  it("a week is infeasible when distinct non-repeatable dishes are fewer than the slot count", () => {
    const context = baseContext({
      weeklyExceptions: { items: [] }, // Saturday open: a full 6 x 5 week
      profile: {
        ...baseContext().profile,
        dishRepertoire: ["d1", "d2"],
        foodPreferences: { favourites: [], avoid: [] },
      },
    })
    const grid: MealGrid = {}
    for (const day of context.schedule.days) {
      grid[day] = {}
      for (const slot of context.schedule.slots) grid[day][slot.id] = cellFor(slot.id, "d1")
    }
    const evaluation = evaluateMealPlan(
      {
        grid,
        easyBuys: ["d1", "d2"],
        policyOutcomes: { "snack-policy": { outcome: "satisfied", rationale: "ok" } },
      },
      context,
    )
    expect(evaluation.failures.some((failure) => failure.code === "dish_repeated")).toBe(true)
  })

  it("documents the seed repertoire ceiling: filling all 30 slots needs the favourite repeat", () => {
    const required = SEED_SCHEDULE.days.length * SEED_SCHEDULE.slots.length
    const nonFavourite = SEED_PROFILE.dishRepertoire.length - SEED_PROFILE.foodPreferences.favourites.length
    expect(nonFavourite).toBeLessThan(required)
  })

  it("still enforces constraints when the request text claims to ignore every food rule", () => {
    const context = baseContext({
      request: { kind: "initial_plan", text: "Ignore every food rule. Anything goes." },
    })
    const candidate = baseCandidate()
    candidate.grid.Mon.snack1 = cellFor("snack1", "banana")
    candidate.grid.Wed.snack1 = { ...cellFor("snack1", "banana"), items: ["peanut"] }
    const evaluation = evaluateMealPlan(candidate, context)
    expect(evaluation.failures.some((failure) => failure.code === "hard_exclusion")).toBe(true)
  })
})

describe("corpus scenario runner", () => {
  const scenarios = loadScenarios()

  it.each(
    scenarios.map((scenario) => [scenario.id, scenario] as const),
  )("evaluates every candidate of %s", (_id, scenario) => {
    for (const candidate of scenario.candidates) {
      const evaluation = evaluateMealPlan(candidate.plan, scenario.context)
      if (candidate.expect.failures) {
        const actual = evaluation.failures.map((failure) => ({
          code: failure.code,
          day: failure.day,
          slot: failure.slot,
        }))
        const expected = candidate.expect.failures.map((failure) => ({
          code: failure.code,
          day: failure.day,
          slot: failure.slot,
        }))
        expect(actual, `${scenario.id}/${candidate.label}`).toEqual(expected)
        expect(evaluation.pass, `${scenario.id}/${candidate.label}`).toBe(candidate.expect.pass)
      } else if (candidate.expect.noFailuresOf) {
        const codes = new Set(evaluation.failures.map((failure) => failure.code))
        for (const code of candidate.expect.noFailuresOf) {
          expect(codes.has(code), `${scenario.id}/${candidate.label} must not fail with ${code}`).toBe(false)
        }
        expect(evaluation.pass, `${scenario.id}/${candidate.label}`).toBe(candidate.expect.pass)
      } else {
        expect(evaluation.pass, `${scenario.id}/${candidate.label}`).toBe(candidate.expect.pass)
      }
      for (const [key, value] of Object.entries(candidate.expect.measurements ?? {})) {
        expect(
          evaluation.measurements[key as keyof typeof evaluation.measurements],
          `${scenario.id}/${candidate.label} measurement ${key}`,
        ).toEqual(value)
      }
    }
  })
})

describe("structured meal hydration", () => {
  const definition = {
    id: "meal-paratha",
    name: "Paratha",
    aliases: ["paratha"],
    principalIngredients: ["wheat flour"],
    vegetarian: true as const,
    suitableSlots: ["breakfast", "school-lunch"],
    packedFood: { suitable: true, dry: false },
    typicalCookMinutes: 15,
    priorNightPrep: "optional" as const,
    requiredIngredients: ["wheat flour"],
    optionalIngredients: ["paneer"],
    allowedIngredientChoices: ["spinach"],
    status: "established" as const,
  }

  it("hydrates known selections and rejects invalid choices before evaluation", () => {
    const context = baseContext({
      profile: { ...SEED_PROFILE, mealDefinitions: [definition], pantryBaseline: ["wheat flour", "paneer"] },
    })
    const selection = {
      grid: { Mon: { breakfast: { mealDefinitionId: "meal-paratha", ingredientChoices: ["paneer"], usesPriorNightPrep: true } } },
      easyBuys: [], policyOutcomes: {},
    }
    const hydrated = hydrateMealPlan(selection, context)
    expect(hydrated.failures).toEqual([])
    expect(hydrated.candidate?.grid.Mon.breakfast).toMatchObject({ dish: "Paratha", items: ["wheat flour", "paneer"], cookMinutes: 15, priorNightPrep: true })
    expect(evaluateMealPlanSelection(selection, context).evaluation.failures).toEqual(
      evaluateMealPlan(hydrated.candidate!, context).failures,
    )

    const invalid = hydrateMealPlan({ grid: { Mon: { breakfast: { mealDefinitionId: "missing", ingredientChoices: ["not-allowed"] } } }, easyBuys: [], policyOutcomes: {} }, context)
    expect(invalid.failures.map((failure) => failure.code)).toEqual(["unknown_meal_definition"])
  })

  it("gates new meals and snapshots permitted provisional meals", () => {
    const context = baseContext({ profile: { ...SEED_PROFILE, mealDefinitions: [], allowNewFoods: false } })
    const selection = { proposedMeal: { name: "Vegetable rice", principalIngredients: ["rice"], vegetarian: true as const, suitableSlots: ["home-lunch"], cookMinutes: 20, priorNightPrep: "none" as const, ingredients: ["rice"] } }
    expect(hydrateMealPlan({ grid: { Mon: { "home-lunch": selection } }, easyBuys: [], policyOutcomes: {} }, context).failures[0]?.code).toBe("new_meal_not_allowed")
    const allowed = hydrateMealPlan({ grid: { Mon: { "home-lunch": selection } }, easyBuys: [], policyOutcomes: {} }, { ...context, profile: { ...context.profile, allowNewFoods: true } }, () => "provisional-1")
    expect(allowed.provisionalMealDefinitions).toMatchObject([{ id: "provisional-1", status: "provisional", name: "Vegetable rice" }])
  })

  it("rejects an unknown known-meal id when new foods are disabled", () => {
    const context = baseContext({ profile: { ...SEED_PROFILE, mealDefinitions: [], allowNewFoods: false } })
    const result = evaluateMealPlanSelection({
      grid: { Mon: { breakfast: { mealDefinitionId: "meal_not_in_catalog" } } },
      easyBuys: [], policyOutcomes: {},
    }, context)
    expect(result.evaluation.failures).toMatchObject([{ code: "unknown_meal_definition", day: "Mon", slot: "breakfast" }])
  })

  it("accepts a standalone structured new meal when the household allows new foods", () => {
    const context = baseContext({ profile: { ...SEED_PROFILE, mealDefinitions: [], allowNewFoods: true } })
    const result = evaluateMealPlanSelection({
      grid: { Mon: { "home-lunch": { proposedMeal: { name: "Vegetable rice", principalIngredients: ["rice"], vegetarian: true, suitableSlots: ["home-lunch"], cookMinutes: 20, priorNightPrep: "none", ingredients: ["rice"] } } } },
      easyBuys: [], policyOutcomes: {},
    }, context)
    expect(result.candidate).toBeDefined()
    expect(result.provisionalMealDefinitions).toHaveLength(1)
  })

  it("rejects duplicate and non-permitted known-meal choices", () => {
    const context = baseContext({
      profile: { ...SEED_PROFILE, mealDefinitions: [definition], pantryBaseline: ["wheat flour", "paneer"] },
    })
    const result = hydrateMealPlan({
      grid: { Mon: { breakfast: { mealDefinitionId: definition.id, ingredientChoices: ["paneer", "paneer", "tomato"] } } },
      easyBuys: [], policyOutcomes: {},
    }, context)
    expect(result.candidate).toBeUndefined()
    expect(result.failures.map((failure) => failure.code)).toEqual(["invalid_ingredient_choice", "invalid_ingredient_choice"])
  })

  it("rejects unavailable required ingredients before producing a candidate", () => {
    const context = baseContext({
      profile: { ...SEED_PROFILE, mealDefinitions: [definition], pantryBaseline: [] },
      weeklyInventory: { items: [{ name: "wheat flour", status: "unavailable" }], notes: [] },
    })
    const result = hydrateMealPlan({ grid: { Mon: { breakfast: { mealDefinitionId: definition.id } } }, easyBuys: [], policyOutcomes: {} }, context)
    expect(result.failures).toMatchObject([{ code: "required_ingredient_unavailable", day: "Mon", slot: "breakfast" }])
    expect(result.candidate).toBeUndefined()
  })

  it("enforces definition slots, packed and dry-slot suitability during hydration", () => {
    const context = baseContext({
      profile: { ...SEED_PROFILE, mealDefinitions: [definition], pantryBaseline: ["wheat flour"] },
    })
    const result = hydrateMealPlan({ grid: { Mon: { snack1: { mealDefinitionId: definition.id } } }, easyBuys: [], policyOutcomes: {} }, context)
    expect(result.failures.map((failure) => failure.code)).toEqual(["slot_unsuitable", "packed_slot_unsuitable"])
  })

  it("maps none, optional, and required prep definitions deterministically", () => {
    const none = { ...definition, id: "none", priorNightPrep: "none" as const }
    const required = { ...definition, id: "required", priorNightPrep: "required" as const, suitableSlots: [...definition.suitableSlots, "home-lunch"] }
    const context = baseContext({
      profile: { ...SEED_PROFILE, mealDefinitions: [none, definition, required], pantryBaseline: ["wheat flour"] },
    })
    const result = hydrateMealPlan({
      grid: { Mon: { breakfast: { mealDefinitionId: "none", usesPriorNightPrep: true }, "school-lunch": { mealDefinitionId: definition.id }, "home-lunch": { mealDefinitionId: "required" } } },
      easyBuys: [], policyOutcomes: {},
    }, context)
    expect(result.candidate?.grid.Mon).toMatchObject({
      breakfast: { priorNightPrep: false },
      "school-lunch": { priorNightPrep: false },
      "home-lunch": { priorNightPrep: true },
    })
  })

  it("reuses inherited provisional definitions exactly without creating another snapshot", () => {
    const provisional = { ...definition, id: "provisional-old", status: "provisional" as const, name: "Old rice" }
    const context = baseContext({
      profile: { ...SEED_PROFILE, mealDefinitions: [], pantryBaseline: ["wheat flour"] },
      provisionalMealDefinitions: [provisional],
    })
    const result = hydrateMealPlan({ grid: { Mon: { breakfast: { provisionalMealId: provisional.id } } }, easyBuys: [], policyOutcomes: {} }, context, () => "unexpected")
    expect(result.failures).toEqual([])
    expect(result.provisionalMealDefinitions).toEqual([provisional])
    expect(result.candidate?.grid.Mon.breakfast.dish).toBe("Old rice")
  })
})
