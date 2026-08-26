import { z } from "zod"
import {
  type CustomPolicy,
  EXCEPTION_KINDS,
  type ExceptionAppliesTo,
  FAILURE_CODES,
  type FeedbackItem,
  type FoodPreferences,
  INVENTORY_STATUSES,
  type InventoryItem,
  type MealCell,
  type MealGrid,
  type MealPlanCandidate,
  type MealPlanContext,
  type MealPlanExpectation,
  type MealPlanFailureExpectation,
  type MealPlanScenario,
  type MealProfile,
  type MealSchedule,
  type MealSlot,
  type PlanRequest,
  POLICY_OUTCOMES,
  type PolicyOutcome,
  REQUEST_KINDS,
  type ScenarioBehavior,
  type ScenarioCandidate,
  type WeeklyException,
  type WeeklyExceptions,
  type WeeklyInventory,
} from "../types"

export const mealSlotSchema: z.ZodType<MealSlot> = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    packed: z.boolean(),
    dry: z.boolean(),
    maxCookMinutes: z.number().int().min(0).nullable(),
  })
  .strict()

export const mealScheduleSchema: z.ZodType<MealSchedule> = z
  .object({
    days: z.array(z.string().min(1)).min(1),
    slots: z.array(mealSlotSchema).min(1),
  })
  .strict()

export const foodPreferencesSchema: z.ZodType<FoodPreferences> = z
  .object({
    favourites: z.array(z.string().min(1)),
    avoid: z.array(z.string().min(1)),
  })
  .strict()

export const mealProfileSchema: z.ZodType<MealProfile> = z
  .object({
    dietaryExclusions: z.array(z.string().min(1)),
    dishRepertoire: z.array(z.string().min(1)),
    foodPreferences: foodPreferencesSchema,
    allowNewFoods: z.boolean(),
    sensoryGuidelines: z.array(z.string().min(1)),
    morningCookingBudgetMinutes: z.number().int().min(0),
    priorNightPrepAllowed: z.boolean(),
    pantryBaseline: z.array(z.string().min(1)),
  })
  .strict()

export const customPolicySchema: z.ZodType<CustomPolicy> = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    scope: z.enum(["persistent", "current_week"]),
    value: z.string().min(1),
  })
  .strict()

export const inventoryItemSchema: z.ZodType<InventoryItem> = z
  .object({
    name: z.string().min(1),
    status: z.enum(INVENTORY_STATUSES),
    quantityNote: z.string().optional(),
    useNote: z.string().optional(),
  })
  .strict()

export const weeklyInventorySchema: z.ZodType<WeeklyInventory> = z
  .object({
    items: z.array(inventoryItemSchema),
    notes: z.array(z.string()),
  })
  .strict()

export const exceptionAppliesToSchema: z.ZodType<ExceptionAppliesTo> = z
  .object({
    day: z.string().min(1).optional(),
    mealSlots: z.array(z.string().min(1)).optional(),
  })
  .strict()

export const weeklyExceptionSchema: z.ZodType<WeeklyException> = z
  .object({
    kind: z.enum(EXCEPTION_KINDS),
    appliesTo: exceptionAppliesToSchema.optional(),
    instruction: z.string().min(1),
  })
  .strict()

export const weeklyExceptionsSchema: z.ZodType<WeeklyExceptions> = z
  .object({
    items: z.array(weeklyExceptionSchema),
  })
  .strict()

export const planRequestSchema: z.ZodType<PlanRequest> = z
  .object({
    kind: z.enum(REQUEST_KINDS),
    text: z.string().min(1),
  })
  .strict()

export const feedbackItemSchema: z.ZodType<FeedbackItem> = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    scope: z.object({ day: z.string().optional(), slot: z.string().optional() }).strict().optional(),
  })
  .strict()

export const mealCellSchema: z.ZodType<MealCell> = z
  .object({
    dish: z.string().min(1),
    vegetarian: z.boolean(),
    items: z.array(z.string().min(1)),
    cookMinutes: z.number().int().min(0),
    priorNightPrep: z.boolean(),
  })
  .strict()

export const mealGridSchema: z.ZodType<MealGrid> = z.record(
  z.string().min(1),
  z.record(z.string().min(1), mealCellSchema),
)

export const mealPlanContextSchema: z.ZodType<MealPlanContext> = z
  .object({
    schedule: mealScheduleSchema,
    profile: mealProfileSchema,
    customPolicies: z.array(customPolicySchema),
    weeklyInventory: weeklyInventorySchema,
    weeklyExceptions: weeklyExceptionsSchema,
    recentPlan: mealGridSchema.nullable().optional(),
    request: planRequestSchema,
    feedbackItems: z.array(feedbackItemSchema).optional(),
    urgentUseByDay: z.string().min(1).optional(),
    requireUrgentUseEarly: z.boolean().optional(),
    requestedRepeats: z.array(z.string().min(1)).optional(),
  })
  .strict()

export const policyOutcomeSchema: z.ZodType<PolicyOutcome> = z
  .object({
    outcome: z.enum(POLICY_OUTCOMES),
    rationale: z.string().min(1),
  })
  .strict()

export const mealPlanCandidateSchema: z.ZodType<MealPlanCandidate> = z
  .object({
    grid: mealGridSchema,
    easyBuys: z.array(z.string().min(1)),
    policyOutcomes: z.record(z.string().min(1), policyOutcomeSchema),
  })
  .strict()

export const mealPlanFailureExpectationSchema: z.ZodType<MealPlanFailureExpectation> = z
  .object({
    code: z.enum(FAILURE_CODES),
    day: z.string().optional(),
    slot: z.string().optional(),
  })
  .strict()

export const mealPlanMeasurementsSchema = z.object({
  morningCookByDay: z.record(z.string(), z.number().int().min(0)),
  morningCookMax: z.number().int().min(0),
  priorNightPrepByDay: z.record(z.string(), z.number().int().min(0)),
  priorNightPrepMax: z.number().int().min(0),
  dishRepeatCount: z.number().int().min(0),
  dishRepeats: z.array(z.string()),
  inventoryUsed: z.array(z.string()),
  urgentUseByDay: z.string().optional(),
  easyBuyCount: z.number().int().min(0),
})

export const mealPlanExpectationSchema: z.ZodType<MealPlanExpectation> = z
  .object({
    pass: z.boolean(),
    failures: z.array(mealPlanFailureExpectationSchema).optional(),
    noFailuresOf: z.array(z.enum(FAILURE_CODES)).optional(),
    measurements: mealPlanMeasurementsSchema.partial().optional(),
  })
  .strict()

export const scenarioCandidateSchema: z.ZodType<ScenarioCandidate> = z
  .object({
    label: z.string().min(1),
    plan: mealPlanCandidateSchema,
    expect: mealPlanExpectationSchema,
  })
  .strict()

export const scenarioBehaviorSchema: z.ZodType<ScenarioBehavior> = z
  .object({
    expectsClarification: z.boolean(),
    clarificationSubject: z.string().optional(),
    expectedPolicyOutcomes: z.record(z.string().min(1), z.enum(POLICY_OUTCOMES)).optional(),
  })
  .strict()

export const mealPlanScenarioSchema: z.ZodType<MealPlanScenario> = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    summary: z.string().min(1),
    context: mealPlanContextSchema,
    candidates: z.array(scenarioCandidateSchema).min(1),
    behavior: scenarioBehaviorSchema.optional(),
  })
  .strict()
