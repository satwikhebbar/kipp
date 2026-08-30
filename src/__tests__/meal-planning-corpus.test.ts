import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { loadScenarios, validateScenarioStructure } from "../meal-planning/corpus/load"
import { mealPlanScenarioSchema } from "../meal-planning/corpus/schema"
import { FAILURE_CODES } from "../meal-planning/types"

const REQUIRED_IDS = [
  "baseline-week",
  "dietary-ambiguity",
  "packing-constraints",
  "no-prior-night-prep",
  "urgent-perishables",
  "holiday-half-day",
  "policy-tradeoff",
  "new-food-setting",
  "requested-repeat",
  "midweek-shortage",
  "whole-day-replan",
  "batched-feedback",
  "cheat-day",
  "no-dairy-week",
  "sat-open-week",
  "vague-feedback",
]

// Scenario JSON represents the persisted MealCell contract so it can pin the
// evaluator independently of model selection. Selection/hydration failures
// are covered in the hydration and agent-session suites instead.
const HYDRATION_ONLY_FAILURE_CODES = new Set([
  "unknown_meal_definition",
  "invalid_ingredient_choice",
  "required_ingredient_unavailable",
  "new_meal_not_allowed",
  "invalid_new_meal",
  "packed_slot_unsuitable",
  "duplicate_meal_selection",
])

describe("meal-planning corpus health", () => {
  const scenarios = loadScenarios()

  it("loads the 16 required scenario fixtures", () => {
    expect(scenarios).toHaveLength(16)
    const ids = new Set(scenarios.map((scenario) => scenario.id))
    for (const id of REQUIRED_IDS) expect(ids.has(id), `missing scenario ${id}`).toBe(true)
  })

  it("loads fixtures sorted deterministically by id", () => {
    const ids = scenarios.map((scenario) => scenario.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual([...ids].sort())
  })

  it("every fixture parses and validates against the zod schema", () => {
    for (const scenario of scenarios) {
      expect(mealPlanScenarioSchema.safeParse(scenario).success, scenario.id).toBe(true)
      expect(validateScenarioStructure(scenario), scenario.id).toEqual([])
    }
  })

  it("rejects misspelled fixture keys by strict-parsing the raw JSON text", () => {
    const dirPath = join(dirname(fileURLToPath(import.meta.url)), "..", "meal-planning", "corpus", "scenarios")
    for (const file of ["baseline-week", "whole-day-replan", "batched-feedback"]) {
      const raw = JSON.parse(readFileSync(join(dirPath, `${file}.json`), "utf8"))
      expect(mealPlanScenarioSchema.safeParse(raw).success, file).toBe(true)
    }
  })

  it("every scenario has at least one pass:true candidate", () => {
    for (const scenario of scenarios) {
      expect(
        scenario.candidates.some((candidate) => candidate.expect.pass),
        `${scenario.id} has no pass:true candidate`,
      ).toBe(true)
    }
  })

  it("exercises every evaluator failure code with a candidate expectation", () => {
    const exercised = new Set<string>()
    for (const scenario of scenarios) {
      for (const candidate of scenario.candidates) {
        for (const failure of candidate.expect.failures ?? []) exercised.add(failure.code)
      }
    }
    for (const code of FAILURE_CODES.filter((code) => !HYDRATION_ONLY_FAILURE_CODES.has(code))) {
      expect(exercised.has(code), `failure code ${code} is not exercised by any fixture`).toBe(true)
    }
  })

  it("revision scenarios reference a recent plan and batched feedback", () => {
    for (const scenario of scenarios) {
      if (scenario.context.request.kind !== "revision") continue
      expect(scenario.context.recentPlan, `${scenario.id} revision needs recentPlan`).toBeDefined()
      expect(
        (scenario.context.feedbackItems ?? []).length,
        `${scenario.id} revision needs feedbackItems`,
      ).toBeGreaterThan(0)
    }
  })

  it("every scenario exercises its declared distinct branch", () => {
    const branchByScenario: Record<string, string[]> = {
      "baseline-week": ["non_vegetarian_school_meal", "missing_slot"],
      "dietary-ambiguity": ["hard_exclusion"],
      "packing-constraints": ["slot_unsuitable", "morning_capacity_exceeded", "missing_policy_outcome"],
      "no-prior-night-prep": ["prior_night_prep_not_allowed", "prior_night_prep_limit"],
      "urgent-perishables": ["use_early_ignored"],
      "holiday-half-day": ["extra_slot_for_closed_day", "missing_slot"],
      "policy-tradeoff": ["missing_policy_outcome"],
      "new-food-setting": [],
      "requested-repeat": ["dish_repeated"],
      "midweek-shortage": ["inventory_item_unavailable", "unscoped_cell_changed", "inventory_item_unknown"],
      "whole-day-replan": ["unscoped_cell_changed"],
      "batched-feedback": ["unaddressed_feedback"],
      "cheat-day": ["missing_policy_outcome"],
      "no-dairy-week": ["hard_exclusion"],
      "sat-open-week": ["dish_repeated"],
      "vague-feedback": ["unscoped_cell_changed", "unaddressed_feedback"],
    }
    const loadedIds = new Set(scenarios.map((scenario) => scenario.id))
    for (const id of Object.keys(branchByScenario)) {
      expect(loadedIds.has(id), `branchByScenario references unknown scenario ${id}`).toBe(true)
    }
    for (const scenario of scenarios) {
      const codes = new Set<string>(
        scenario.candidates.flatMap((candidate) => candidate.expect.failures?.map((f) => f.code) ?? []),
      )
      for (const code of branchByScenario[scenario.id] ?? []) {
        expect(codes.has(code), `${scenario.id} should exercise ${code}`).toBe(true)
      }
    }
  })
})
