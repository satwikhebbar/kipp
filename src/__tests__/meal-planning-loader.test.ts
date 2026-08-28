import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  computeCoverageSet,
  loadScenarios,
  parseScenario,
  ScenarioValidationError,
  validateScenarioStructure,
} from "../meal-planning/corpus/load"
import type { MealPlanContext, MealPlanScenario } from "../meal-planning/types"

function validContext(overrides: Partial<MealPlanContext> = {}): MealPlanContext {
  return {
    schedule: {
      days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
      slots: [
        { id: "breakfast", name: "Breakfast", packed: false, dry: false, maxCookMinutes: null },
        { id: "snack1", name: "Snack 1", packed: true, dry: true, maxCookMinutes: 0 },
        { id: "home-lunch", name: "Home lunch", packed: false, dry: false, maxCookMinutes: null },
      ],
    },
    profile: {
      dietaryExclusions: ["peanut"],
      dishRepertoire: ["paratha", "banana"],
      foodPreferences: { favourites: ["paratha"], avoid: [] },
      allowNewFoods: false,
      sensoryGuidelines: [],
      morningCookingBudgetMinutes: 40,
      priorNightPrepAllowed: false,
      pantryBaseline: ["rice", "wheat flour"],
    },
    customPolicies: [
      { id: "snack-policy", label: "Snack policy", scope: "persistent", value: "Snacks dry and quick." },
    ],
    weeklyInventory: { items: [{ name: "banana", status: "available" }], notes: [] },
    weeklyExceptions: { items: [{ kind: "school_closed", appliesTo: { day: "Sat" }, instruction: "Holiday" }] },
    recentPlan: null,
    request: { kind: "initial_plan", text: "Plan normally." },
    ...overrides,
  }
}

function validScenario(overrides: Partial<MealPlanScenario> = {}): MealPlanScenario {
  return {
    id: "baseline-week",
    name: "Baseline week",
    summary: "A normal Mon-Sat week with a Saturday holiday.",
    context: validContext(),
    candidates: [
      {
        label: "valid",
        plan: {
          grid: {
            Mon: {
              breakfast: {
                dish: "paratha",
                vegetarian: true,
                items: ["wheat flour"],
                cookMinutes: 15,
                priorNightPrep: false,
              },
              snack1: {
                dish: "banana",
                vegetarian: true,
                items: ["banana"],
                cookMinutes: 0,
                priorNightPrep: false,
              },
              "home-lunch": {
                dish: "paratha",
                vegetarian: true,
                items: ["wheat flour"],
                cookMinutes: 15,
                priorNightPrep: false,
              },
            },
          },
          easyBuys: [],
          policyOutcomes: { "snack-policy": { outcome: "satisfied", rationale: "Snacks dry and quick." } },
        },
        expect: { pass: true, measurements: { morningCookMax: 30, priorNightPrepMax: 0, dishRepeatCount: 0 } },
      },
    ],
    behavior: { expectsClarification: false, expectedPolicyOutcomes: { "snack-policy": "satisfied" } },
    ...overrides,
  }
}

const FIVE_SLOTS = [
  { id: "breakfast", name: "Breakfast", packed: false, dry: false, maxCookMinutes: null },
  { id: "snack1", name: "Snack 1", packed: true, dry: true, maxCookMinutes: 0 },
  { id: "snack2", name: "Snack 2", packed: true, dry: true, maxCookMinutes: 0 },
  { id: "school-lunch", name: "School lunch", packed: true, dry: false, maxCookMinutes: null },
  { id: "home-lunch", name: "Home lunch", packed: false, dry: false, maxCookMinutes: null },
]

describe("meal-planning corpus loader", () => {
  it("parses a valid fixture and computes the coverage set minus closed and half-day-dropped slots", () => {
    const scenario = parseScenario(validScenario())
    expect(scenario.id).toBe("baseline-week")

    const coverage = computeCoverageSet(scenario.context)
    expect(coverage.closedDays).toEqual(["Sat"])
    expect(coverage.droppedSlots).toEqual([])
    expect(coverage.required.some((cell) => cell.day === "Sat")).toBe(false)
    expect(coverage.required).toContainEqual({ day: "Mon", slotId: "snack1" })
    expect(coverage.required).toHaveLength(3 * 5)
  })

  it("drops a half-day slot by exact id and by exact name", () => {
    const byId = parseScenario(
      validScenario({
        context: validContext({
          weeklyExceptions: {
            items: [
              { kind: "school_closed", appliesTo: { day: "Sat" }, instruction: "Holiday" },
              { kind: "half_day", appliesTo: { day: "Wed", mealSlots: ["home-lunch"] }, instruction: "Short day" },
            ],
          },
        }),
      }),
    )
    const byName = parseScenario(
      validScenario({
        context: validContext({
          weeklyExceptions: {
            items: [
              { kind: "half_day", appliesTo: { day: "Wed", mealSlots: ["Home lunch"] }, instruction: "Short day" },
            ],
          },
        }),
      }),
    )

    for (const scenario of [byId, byName]) {
      const coverage = computeCoverageSet(scenario.context)
      expect(coverage.droppedSlots).toContainEqual({ day: "Wed", slotId: "home-lunch" })
      expect(coverage.required).not.toContainEqual({ day: "Wed", slotId: "home-lunch" })
      expect(coverage.required).toContainEqual({ day: "Wed", slotId: "snack1" })
    }
  })

  it("a Saturday half-day exception represents the reduced weekend schedule (3 of 5 slots)", () => {
    const scenario = parseScenario(
      validScenario({
        context: validContext({
          schedule: { days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], slots: FIVE_SLOTS },
          weeklyExceptions: {
            items: [
              {
                kind: "half_day",
                appliesTo: { day: "Sat", mealSlots: ["school-lunch", "home-lunch"] },
                instruction: "Half day",
              },
            ],
          },
        }),
      }),
    )
    const coverage = computeCoverageSet(scenario.context)
    expect(coverage.required.filter((cell) => cell.day === "Sat")).toHaveLength(3)
    expect(coverage.required).toHaveLength(5 * 5 + 3)
  })

  it("rejects a grid day key that is not a configured day", () => {
    const scenario = validScenario({
      candidates: [
        {
          label: "typo-day",
          plan: {
            grid: {
              Sun: {
                breakfast: {
                  dish: "paratha",
                  vegetarian: true,
                  items: ["wheat flour"],
                  cookMinutes: 15,
                  priorNightPrep: false,
                },
              },
            },
            easyBuys: [],
            policyOutcomes: {},
          },
          expect: { pass: false },
        },
      ],
    })
    expect(validateScenarioStructure(scenario)[0]?.message).toMatch('day "Sun" is not one of the configured days')
    expect(() => parseScenario(scenario)).toThrow(ScenarioValidationError)
  })

  it("rejects a grid slot key that is not a configured slot id", () => {
    const scenario = validScenario({
      candidates: [
        {
          label: "typo-slot",
          plan: {
            grid: {
              Mon: {
                "lunch-box": {
                  dish: "paratha",
                  vegetarian: true,
                  items: ["wheat flour"],
                  cookMinutes: 15,
                  priorNightPrep: false,
                },
              },
            },
            easyBuys: [],
            policyOutcomes: {},
          },
          expect: { pass: false },
        },
      ],
    })
    expect(validateScenarioStructure(scenario)[0]?.message).toMatch(
      'slot "lunch-box" is not one of the configured slot',
    )
    expect(() => parseScenario(scenario)).toThrow(ScenarioValidationError)
  })

  it("rejects an exception that references an unknown day or meal slot", () => {
    const badDay = validScenario({
      context: validContext({
        weeklyExceptions: { items: [{ kind: "half_day", appliesTo: { day: "Never" }, instruction: "Bad" }] },
      }),
    })
    expect(validateScenarioStructure(badDay)[0]?.message).toMatch('day "Never" is not a configured day')

    const badSlot = validScenario({
      context: validContext({
        weeklyExceptions: {
          items: [{ kind: "half_day", appliesTo: { day: "Wed", mealSlots: ["brunch"] }, instruction: "Bad" }],
        },
      }),
    })
    expect(validateScenarioStructure(badSlot)[0]?.message).toMatch('meal slot "brunch" matches no configured')
  })

  it("rejects a day that is both school_closed and half_day", () => {
    const scenario = validScenario({
      context: validContext({
        weeklyExceptions: {
          items: [
            { kind: "school_closed", appliesTo: { day: "Sat" }, instruction: "Holiday" },
            { kind: "half_day", appliesTo: { day: "Sat", mealSlots: ["home-lunch"] }, instruction: "Also short" },
          ],
        },
      }),
    })
    expect(validateScenarioStructure(scenario)[0]?.message).toMatch("cannot be both school_closed and half_day")
    expect(() => parseScenario(scenario)).toThrow(ScenarioValidationError)
  })

  it("requires revision scenarios to reference a recentPlan", () => {
    const scenario = validScenario({
      context: validContext({ request: { kind: "revision", text: "Fix the school lunch." } }),
    })
    expect(validateScenarioStructure(scenario)[0]?.message).toMatch("revision scenarios must reference a recentPlan")
  })

  it("rejects an urgentUseByDay that is not a configured day", () => {
    const scenario = validScenario({
      context: validContext({ requireUrgentUseEarly: true, urgentUseByDay: "Never" }),
    })
    expect(validateScenarioStructure(scenario)[0]?.message).toMatch('urgentUseByDay "Never" is not a configured day')
    expect(() => parseScenario(scenario)).toThrow(ScenarioValidationError)
  })

  it("reports schema violations as ScenarioValidationError issues", () => {
    const badCell = {
      ...validScenario(),
      candidates: [
        {
          label: "bad",
          plan: {
            grid: { Mon: { snack1: { dish: "", vegetarian: true, items: [] } } },
            easyBuys: [],
            policyOutcomes: {},
          },
          expect: { pass: false },
        },
      ],
    }
    expect(() => parseScenario(badCell)).toThrow(ScenarioValidationError)
  })

  it("loads the full scenario corpus sorted by id", () => {
    const scenarios = loadScenarios()
    expect(scenarios.length).toBe(16)
    expect(scenarios.map((scenario) => scenario.id)).toEqual([...scenarios.map((scenario) => scenario.id)].sort())
  })

  it("returns an empty list for a missing scenarios directory but re-throws other readdir errors", () => {
    const missingDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "does-not-exist")
    expect(loadScenarios(missingDir)).toEqual([])

    const pathToFile = fileURLToPath(import.meta.url)
    expect(() => loadScenarios(pathToFile)).toThrowError()
  })
})
