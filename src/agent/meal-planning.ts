import { z } from "zod"
import { evaluateMealPlan } from "../meal-planning/evaluation"
import type { MealPlanContext } from "../meal-planning/types"
import { EXCEPTION_KINDS, FAILURE_CODES, INVENTORY_STATUSES, POLICY_OUTCOMES } from "../meal-planning/types"
import type { ToolDefinition } from "../runtime/tools"

export const MEAL_PLANNING_TOOL = {
  EVALUATE: "evaluate_meal_plan",
  PROPOSE: "propose_plan",
  CLARIFY: "needs_clarification",
} as const

export const mealCellSchema = z
  .object({
    dish: z.string().min(1),
    vegetarian: z.boolean(),
    items: z.array(z.string()),
    cookMinutes: z.number().int().min(0),
    priorNightPrep: z.boolean(),
  })
  .strict()
  .describe(
    'One meal cell. Include every field. Example: {"dish": "paratha", "vegetarian": true, "items": ["wheat flour"], "cookMinutes": 15, "priorNightPrep": false}',
  )

const gridSchema = z
  .record(
    z.string(),
    z
      .record(z.string(), mealCellSchema)
      .describe(
        'one entry per slot id present that day, keyed by slot id (e.g. "breakfast", "snack1", "school-lunch")',
      ),
  )
  .describe('one entry per school day, keyed by day ("Mon".."Sat")')

const policyOutcomeSchema = z
  .object({
    outcome: z.enum(POLICY_OUTCOMES),
    rationale: z.string(),
  })
  .strict()
  .describe('{"outcome": "satisfied" | "trade-off" | "needs-clarification", "rationale": "short reason"}')

export const mealPlanCandidateSchema = z
  .object({
    grid: gridSchema,
    easyBuys: z.array(z.string()),
    policyOutcomes: z.record(z.string(), policyOutcomeSchema),
  })
  .strict()

const failureSchema = z
  .object({
    code: z.enum(FAILURE_CODES),
    day: z.string().optional(),
    slot: z.string().optional(),
    detail: z.string(),
  })
  .strict()

const measurementsSchema = z
  .object({
    morningCookByDay: z.record(z.string(), z.number()),
    morningCookMax: z.number(),
    priorNightPrepByDay: z.record(z.string(), z.number()),
    priorNightPrepMax: z.number(),
    dishRepeatCount: z.number(),
    dishRepeats: z.array(z.string()),
    inventoryUsed: z.array(z.string()),
    urgentUseByDay: z.string().optional(),
    easyBuyCount: z.number(),
  })
  .strict()

export const mealPlanEvaluationSchema = z
  .object({
    pass: z.boolean(),
    failures: z.array(failureSchema),
    measurements: measurementsSchema,
  })
  .strict()

export const inventoryItemSchema = z
  .object({
    name: z.string(),
    status: z.enum(INVENTORY_STATUSES),
    quantityNote: z.string().optional(),
    useNote: z.string().optional(),
  })
  .strict()

export const weeklyInventorySchema = z
  .object({
    items: z.array(inventoryItemSchema),
    notes: z.array(z.string()),
  })
  .strict()

export const weeklyExceptionSchema = z
  .object({
    kind: z.enum(EXCEPTION_KINDS),
    appliesTo: z
      .object({
        day: z.string().optional(),
        mealSlots: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    instruction: z.string(),
  })
  .strict()

export const weeklyExceptionsSchema = z
  .object({
    items: z.array(weeklyExceptionSchema),
  })
  .strict()

export const feedbackItemSchema = z
  .object({
    id: z.string().min(1),
    text: z.string(),
    scope: z
      .object({
        day: z.string().optional(),
        slot: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export const proposePlanInputSchema = z
  .object({
    candidate: mealPlanCandidateSchema,
    weeklyInventory: weeklyInventorySchema,
    weeklyExceptions: weeklyExceptionsSchema,
    feedbackItems: z.array(feedbackItemSchema).optional(),
  })
  .strict()

export const needsClarificationInputSchema = z
  .object({
    message: z.string().trim().min(1),
    reasonCodes: z.array(z.enum(FAILURE_CODES)).min(1),
    interaction: z.object({ kind: z.literal("reply") }).strict(),
  })
  .strict()

const acceptedOutputSchema = z.object({ accepted: z.literal(true) }).strict()

/** Creates the deterministic candidate-evaluation tool for one bounded meal-planning session. */
export function createEvaluateMealPlanTool(context: MealPlanContext): ToolDefinition {
  return {
    name: MEAL_PLANNING_TOOL.EVALUATE,
    description:
      "Validate exactly one complete Mon–Sat meal-plan candidate against the household context. Returns typed failures and measurements; it never persists a plan.",
    input: mealPlanCandidateSchema,
    output: mealPlanEvaluationSchema,
    privacy: "private",
    batching: "isolated",
    handler: async (candidate) => evaluateMealPlan(candidate, context),
  }
}

export { acceptedOutputSchema }
