import { z } from "zod"
import { evaluateMealPlanSelection } from "../meal-planning/evaluation"
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

const priorNightPrepSchema = z.enum(["none", "optional", "required"])
const packedFoodSchema = z.object({ suitable: z.boolean(), dry: z.boolean() }).strict()
const ingredientChoicesSchema = z.array(z.string()).optional()
const ingredientAliasesUsedSchema = z.record(z.string(), z.string()).optional()
const knownMealSelectionSchema = z
  .object({
    mealDefinitionId: z.string().min(1),
    ingredientChoices: ingredientChoicesSchema,
    ingredientAliasesUsed: ingredientAliasesUsedSchema,
    usesPriorNightPrep: z.boolean().optional(),
  })
  .strict()
const provisionalMealSelectionSchema = z
  .object({
    provisionalMealId: z.string().min(1),
    ingredientChoices: ingredientChoicesSchema,
    ingredientAliasesUsed: ingredientAliasesUsedSchema,
    usesPriorNightPrep: z.boolean().optional(),
  })
  .strict()
const newMealSelectionSchema = z
  .object({
    proposedMeal: z
      .object({
        name: z.string().min(1),
        principalIngredients: z.array(z.string()).min(1),
        vegetarian: z.literal(true),
        suitableSlots: z.array(z.string()).min(1),
        packedFood: packedFoodSchema.optional(),
        cookMinutes: z.number().int().min(0),
        priorNightPrep: priorNightPrepSchema,
        ingredients: z.array(z.string()).min(1),
      })
      .strict(),
    ingredientAliasesUsed: ingredientAliasesUsedSchema,
    usesPriorNightPrep: z.boolean().optional(),
  })
  .strict()
const selectionGridSchema = z.record(
  z.string(),
  z.record(z.string(), z.union([knownMealSelectionSchema, provisionalMealSelectionSchema, newMealSelectionSchema])),
)
export const mealPlanSelectionCandidateSchema = z
  .object({
    grid: selectionGridSchema,
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

export const PROPOSE_JUSTIFICATION_MAX_CHARACTERS = 500

export const proposePlanInputSchema = z
  .object({
    candidate: mealPlanSelectionCandidateSchema,
    // The model may only attach a scope interpretation to unscoped feedback;
    // inventory, exceptions, and the feedback source itself stay authoritative
    // in the workflow context and are never echoed by the terminal call.
    feedbackItems: z.array(feedbackItemSchema).optional(),
    // Debug aid only. The session truncates this before retaining it, so a
    // verbose explanation never costs the model another terminal turn.
    justification: z.string().trim().min(1).optional(),
  })
  .strict()

export const needsClarificationInputSchema = z
  .object({
    message: z.string().trim().min(1),
    // A clarification about an ambiguous parent preference need not follow an
    // evaluator failure. When evaluation did run, the session still requires
    // every reported failure code to be included.
    reasonCodes: z.array(z.enum(FAILURE_CODES)),
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
    input: mealPlanSelectionCandidateSchema,
    output: mealPlanEvaluationSchema,
    privacy: "private",
    batching: "isolated",
    handler: async (candidate) => {
      return evaluateMealPlanSelection(candidate, context).evaluation
    },
  }
}

export { acceptedOutputSchema }
