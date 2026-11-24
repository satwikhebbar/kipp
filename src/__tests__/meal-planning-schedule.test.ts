import { describe, expect, it } from "vitest"
import { computeCoverageSet } from "../meal-planning/coverage"
import { effectiveMealSlot, mealDefinitionFitsSlot } from "../meal-planning/half-day"
import { normalizeLegacyMealSchedule, validateMealSchedule } from "../meal-planning/schedule"
import { SEED_PROFILE, SEED_SCHEDULE } from "../meal-planning/store"
import type { MealPlanContext, MealSchedule } from "../meal-planning/types"

const CUSTOM_SUNDAY_SCHEDULE: MealSchedule = {
  days: ["Sun"],
  halfDays: ["Sun"],
  slots: [
    {
      id: "morning-tea",
      name: "Morning tea",
      packed: true,
      dry: true,
      maxCookMinutes: null,
      halfDayBehavior: { action: "quick", maxCookMinutes: 15 },
    },
    {
      id: "lunch",
      name: "Lunch",
      packed: false,
      dry: false,
      maxCookMinutes: null,
      halfDayBehavior: { action: "omit" },
    },
    {
      id: "supper",
      name: "Supper",
      packed: false,
      dry: false,
      maxCookMinutes: null,
      halfDayBehavior: { action: "keep" },
    },
  ],
}

function context(schedule: MealSchedule): MealPlanContext {
  return {
    schedule,
    profile: SEED_PROFILE,
    customPolicies: [],
    weeklyInventory: { items: [], notes: [] },
    weeklyExceptions: { items: [] },
    request: { kind: "initial_plan", text: "Plan this week" },
  }
}

describe("configurable meal schedules", () => {
  it("keeps the starter half-day rule while normalizing old slot definitions", () => {
    const legacy = {
      ...SEED_SCHEDULE,
      halfDays: undefined,
      slots: SEED_SCHEDULE.slots.map(({ halfDayBehavior: _behavior, ...slot }) => slot),
    }
    const normalized = normalizeLegacyMealSchedule(legacy)
    expect(normalized.halfDays).toEqual(["Sat"])
    expect(normalized.slots.map((slot) => [slot.id, slot.halfDayBehavior?.action])).toEqual([
      ["breakfast", "keep"],
      ["snack1", "quick"],
      ["snack2", "omit"],
      ["school-lunch", "omit"],
      ["home-lunch", "keep"],
    ])
  })

  it("uses custom slot rules for a Sunday half day", () => {
    expect(validateMealSchedule(CUSTOM_SUNDAY_SCHEDULE)).toEqual([])
    expect(computeCoverageSet(context(CUSTOM_SUNDAY_SCHEDULE))).toEqual({
      required: [
        { day: "Sun", slotId: "morning-tea" },
        { day: "Sun", slotId: "supper" },
      ],
      closedDays: [],
      droppedSlots: [{ day: "Sun", slotId: "lunch" }],
    })
    expect(effectiveMealSlot(context(CUSTOM_SUNDAY_SCHEDULE), "Sun", "morning-tea")?.maxCookMinutes).toBe(15)
    expect(effectiveMealSlot(context(CUSTOM_SUNDAY_SCHEDULE), "Sun", "lunch")).toBeUndefined()
  })

  it("accepts established eligibility for custom slots when new foods are disabled", () => {
    const profile = {
      ...SEED_PROFILE,
      allowNewFoods: false,
      mealDefinitions: [
        {
          ...(SEED_PROFILE.mealDefinitions?.[0] as NonNullable<typeof SEED_PROFILE.mealDefinitions>[number]),
          suitableSlots: ["morning-tea", "lunch", "supper"],
          packedFood: { suitable: true, dry: true },
          typicalCookMinutes: 0,
        },
      ],
    }
    expect(validateMealSchedule(CUSTOM_SUNDAY_SCHEDULE, profile)).toEqual([])
    expect(
      validateMealSchedule(CUSTOM_SUNDAY_SCHEDULE, {
        ...profile,
        mealDefinitions: [{ ...profile.mealDefinitions[0], suitableSlots: ["breakfast"] }],
      }),
    ).toEqual(
      expect.arrayContaining([expect.stringContaining("Morning tea (morning-tea) has no eligible established meals")]),
    )
    expect(
      mealDefinitionFitsSlot(
        { ...profile.mealDefinitions[0], halfDaySnack: true, suitableSlots: [] },
        context(CUSTOM_SUNDAY_SCHEDULE),
        "Sun",
        "morning-tea",
      ),
    ).toBe(true)
  })

  it("enforces the 20-minute cap for half-day snacks even when the slot is listed", () => {
    const definition = {
      ...(SEED_PROFILE.mealDefinitions?.find((meal) => meal.halfDaySnack) as NonNullable<
        typeof SEED_PROFILE.mealDefinitions
      >[number]),
      suitableSlots: ["morning-tea"],
      typicalCookMinutes: 25,
    }
    expect(mealDefinitionFitsSlot(definition, context(CUSTOM_SUNDAY_SCHEDULE), "Sun", "morning-tea")).toBe(false)
    expect(mealDefinitionFitsSlot(definition, context(CUSTOM_SUNDAY_SCHEDULE), "Mon", "morning-tea")).toBe(true)
  })

  it("allows half-day-only eligibility on required half-day slots but not ordinary days", () => {
    const definition = {
      ...(SEED_PROFILE.mealDefinitions?.find((meal) => meal.halfDaySnack) as NonNullable<
        typeof SEED_PROFILE.mealDefinitions
      >[number]),
      suitableSlots: ["supper"],
      packedFood: { suitable: true, dry: true },
      typicalCookMinutes: 10,
    }
    const profile = { ...SEED_PROFILE, allowNewFoods: false, mealDefinitions: [definition] }
    expect(validateMealSchedule(CUSTOM_SUNDAY_SCHEDULE, profile)).toEqual([])
    expect(validateMealSchedule({ ...CUSTOM_SUNDAY_SCHEDULE, days: ["Mon", "Sun"] }, profile)).toEqual(
      expect.arrayContaining([expect.stringContaining("Morning tea (morning-tea) has no eligible established meals")]),
    )
  })

  it("rejects a required half-day snack slot when its only meal exceeds the global cap", () => {
    const schedule = {
      ...CUSTOM_SUNDAY_SCHEDULE,
      slots: CUSTOM_SUNDAY_SCHEDULE.slots.map((slot) =>
        slot.id === "morning-tea"
          ? { ...slot, halfDayBehavior: { action: "quick" as const, maxCookMinutes: 40 } }
          : slot,
      ),
    }
    const slowSnack = {
      ...(SEED_PROFILE.mealDefinitions?.find((meal) => meal.halfDaySnack) as NonNullable<
        typeof SEED_PROFILE.mealDefinitions
      >[number]),
      suitableSlots: ["morning-tea"],
      halfDaySnack: true,
      packedFood: { suitable: true, dry: true },
      typicalCookMinutes: 25,
    }
    expect(
      validateMealSchedule(schedule, {
        ...SEED_PROFILE,
        allowNewFoods: false,
        mealDefinitions: [slowSnack],
      }),
    ).toEqual(expect.arrayContaining([expect.stringContaining("no eligible established meals")]))
  })

  it("rejects malformed weekday, duplicate slot, and all-omitted half-day configurations", () => {
    expect(validateMealSchedule({ ...CUSTOM_SUNDAY_SCHEDULE, days: ["Funday"] })).not.toEqual([])
    expect(
      validateMealSchedule({
        ...CUSTOM_SUNDAY_SCHEDULE,
        slots: CUSTOM_SUNDAY_SCHEDULE.slots.map((slot) => ({ ...slot, halfDayBehavior: { action: "omit" } })),
      }),
    ).not.toEqual([])
  })

  it("rejects prototype property names as slot IDs while still detecting real duplicates", () => {
    const prototypeSlot = { ...CUSTOM_SUNDAY_SCHEDULE.slots[0], id: "constructor" }
    expect(validateMealSchedule({ ...CUSTOM_SUNDAY_SCHEDULE, slots: [prototypeSlot] })).not.toEqual([])
    expect(
      validateMealSchedule({
        ...CUSTOM_SUNDAY_SCHEDULE,
        slots: [CUSTOM_SUNDAY_SCHEDULE.slots[0], { ...CUSTOM_SUNDAY_SCHEDULE.slots[0] }],
      }),
    ).not.toEqual([])
  })
})
