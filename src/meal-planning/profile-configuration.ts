import { z } from "zod"
import { mealScheduleSchema, validateMealSchedule } from "./schedule"
import type { MealProfile, MealSchedule } from "./types"

const MAX_PROFILE_LIST_ITEMS = 100
const MAX_PROFILE_TEXT_LENGTH = 160
const MAX_GUIDELINE_LENGTH = 500
const MAX_POLICIES = 50
const MAX_POLICY_VALUE_LENGTH = 1_000
const MAX_GUIDELINES = 50
const MAX_COOKING_BUDGET_MINUTES = 600
const MAX_POLICY_LABEL_LENGTH = 120
const MAX_MEAL_DEFINITION_ID_LENGTH = 128
const MAX_ELIGIBLE_MEALS_PER_SLOT = 500
const MAX_LOCATION_COUNTRY_LENGTH = 100
const MAX_LOCATION_CITY_LENGTH = 120

const writableMealScheduleSchema = mealScheduleSchema.superRefine((schedule, context) => {
  if (schedule.halfDays === undefined)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["halfDays"], message: "halfDays must be explicit" })
  schedule.slots.forEach((slot, index) => {
    if (slot.halfDayBehavior === undefined)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slots", index, "halfDayBehavior"],
        message: "halfDayBehavior must be explicit",
      })
  })
})

const RESERVED_POLICY_IDS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
])

const boundedText = (max = MAX_PROFILE_TEXT_LENGTH) => z.string().trim().min(1).max(max)
const textList = (max = MAX_PROFILE_LIST_ITEMS, textLength = MAX_PROFILE_TEXT_LENGTH) =>
  z.array(boundedText(textLength)).max(max)

/** Editable household fields accepted from an authenticated profile request. */
export const editableMealProfileSchema = z
  .object({
    dietaryExclusions: textList(),
    foodPreferences: z.object({ favourites: textList(), avoid: textList() }).strict(),
    allowNewFoods: z.boolean(),
    sensoryGuidelines: textList(MAX_GUIDELINES, MAX_GUIDELINE_LENGTH),
    morningCookingBudgetMinutes: z.number().int().min(0).max(MAX_COOKING_BUDGET_MINUTES),
    priorNightPrepAllowed: z.boolean(),
    pantryBaseline: textList(),
  })
  .strict()

/** Bounded request shape for saving a complete, versioned household configuration. */
export const mealProfileConfigurationRequestSchema = z
  .object({
    expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    profile: editableMealProfileSchema,
    customPolicies: z
      .array(
        z
          .object({
            id: z
              .string()
              .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
              .refine((id) => !RESERVED_POLICY_IDS.has(id), "policy ID is reserved"),
            label: boundedText(MAX_POLICY_LABEL_LENGTH),
            scope: z.enum(["persistent", "current_week"]),
            value: boundedText(MAX_POLICY_VALUE_LENGTH),
          })
          .strict(),
      )
      .max(MAX_POLICIES)
      .refine(
        (policies) => new Set(policies.map(({ id }) => id)).size === policies.length,
        "policy IDs must be unique",
      ),
    schedule: writableMealScheduleSchema,
    eligibleEstablishedMeals: z
      .record(
        z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
        z.array(z.string().min(1).max(MAX_MEAL_DEFINITION_ID_LENGTH)).max(MAX_ELIGIBLE_MEALS_PER_SLOT),
      )
      .optional(),
    location: z
      .object({
        country: boundedText(MAX_LOCATION_COUNTRY_LENGTH),
        city: boundedText(MAX_LOCATION_CITY_LENGTH),
      })
      .strict()
      .nullable(),
  })
  .strict()

export type MealProfileConfigurationRequest = z.infer<typeof mealProfileConfigurationRequestSchema>

/** Combines supported editable fields with the current catalogue and deprecated compatibility data. */
export function mergeEditableMealProfile(
  current: MealProfile,
  editable: MealProfileConfigurationRequest["profile"],
): MealProfile {
  return { ...current, ...editable }
}

/** Returns the first schedule/profile semantic validation error, if any. */
export function validateMealProfileConfiguration(profile: MealProfile, schedule: MealSchedule): string | null {
  const errors = validateMealSchedule(schedule, profile)
  return errors[0] ?? null
}
