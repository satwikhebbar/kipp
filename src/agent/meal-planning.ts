import { z } from "zod"
import { evaluateMealPlanSelection, evaluateMealPlanSelectionPatch } from "../meal-planning/evaluation"
import type {
  MealPlanCandidate,
  MealPlanContext,
  MealPlanSelectionCandidate,
  MealPlanSelectionPatch,
} from "../meal-planning/types"
import { EXCEPTION_KINDS, FAILURE_CODES, INVENTORY_STATUSES, POLICY_OUTCOMES } from "../meal-planning/types"
import { type ToolDefinition, ToolHandlerError } from "../runtime/tools"

export const MEAL_PLANNING_TOOL = {
  EVALUATE: "evaluate_meal_plan",
  PROPOSE: "propose_plan",
  UPDATE_WEEK_CONTEXT: "update_week_context",
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

/** A revision supplies selections for changed cells only; omitted state is retained server-side. */
export const mealPlanSelectionPatchSchema = z
  .object({
    grid: selectionGridSchema.describe("only changed cells, keyed by day then slot id; omit every untouched cell"),
    easyBuys: z.array(z.string()).optional().describe("replacement shopping list only when it changes"),
    policyOutcomes: z
      .record(z.string(), policyOutcomeSchema)
      .optional()
      .describe("replacement outcomes only when they change"),
  })
  .strict()

/**
 * The planner's provider-facing contract deliberately uses arrays for every
 * formerly dynamic map. OpenAI-compatible strict function schemas cannot
 * represent arbitrary object keys; keeping this wire shape separate lets the
 * application retain its map-shaped evaluation and persistence model.
 */
const ingredientAliasWireSchema = z
  .object({
    availableIngredient: z.string().min(1),
    definitionIngredient: z.string().min(1),
  })
  .strict()

const ingredientAliasesWireSchema = z.array(ingredientAliasWireSchema).optional()
const knownMealSelectionWireSchema = z
  .object({
    mealDefinitionId: z.string().min(1),
    ingredientChoices: ingredientChoicesSchema,
    ingredientAliasesUsed: ingredientAliasesWireSchema,
    usesPriorNightPrep: z.boolean().optional(),
  })
  .strict()
const provisionalMealSelectionWireSchema = z
  .object({
    provisionalMealId: z.string().min(1),
    ingredientChoices: ingredientChoicesSchema,
    ingredientAliasesUsed: ingredientAliasesWireSchema,
    usesPriorNightPrep: z.boolean().optional(),
  })
  .strict()
const newMealSelectionWireSchema = z
  .object({
    proposedMeal: newMealSelectionSchema.shape.proposedMeal,
    ingredientAliasesUsed: ingredientAliasesWireSchema,
    usesPriorNightPrep: z.boolean().optional(),
  })
  .strict()
const mealSelectionWireSchema = z.union([
  knownMealSelectionWireSchema,
  provisionalMealSelectionWireSchema,
  newMealSelectionWireSchema,
])
const gridDayWireSchema = z
  .object({
    day: z.string().min(1),
    cells: z
      .array(
        z
          .object({
            slot: z.string().min(1),
            selection: mealSelectionWireSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
const policyOutcomeWireSchema = z
  .object({
    policyId: z.string().min(1),
    outcome: z.enum(POLICY_OUTCOMES),
    rationale: z.string(),
  })
  .strict()

const mealPlanSelectionWireCandidateSchema = z
  .object({
    days: z.array(gridDayWireSchema),
    easyBuys: z.array(z.string()),
    policyOutcomes: z.array(policyOutcomeWireSchema),
  })
  .strict()

const mealPlanSelectionWirePatchSchema = z
  .object({
    days: z.array(gridDayWireSchema),
    easyBuys: z.array(z.string()).optional(),
    policyOutcomes: z.array(policyOutcomeWireSchema).optional(),
  })
  .strict()

export type MealPlanSelectionWireCandidate = z.infer<typeof mealPlanSelectionWireCandidateSchema>
export type MealPlanSelectionWirePatch = z.infer<typeof mealPlanSelectionWirePatchSchema>

/** Converts strict-schema-compatible provider data to the established internal map form. */
export function mealPlanSelectionCandidateFromWire(
  candidate: MealPlanSelectionWireCandidate,
  policyIds: readonly string[],
): MealPlanSelectionCandidate {
  return {
    grid: gridFromWire(candidate.days),
    easyBuys: candidate.easyBuys,
    policyOutcomes: policyOutcomesFromWire(candidate.policyOutcomes, policyIds),
  }
}

/** Converts a provider revision payload to the established map-shaped patch form. */
export function mealPlanSelectionPatchFromWire(
  candidate: MealPlanSelectionWirePatch,
  policyIds: readonly string[],
): MealPlanSelectionPatch {
  return {
    grid: gridFromWire(candidate.days),
    ...(candidate.easyBuys === undefined ? {} : { easyBuys: candidate.easyBuys }),
    ...(candidate.policyOutcomes === undefined
      ? {}
      : { policyOutcomes: policyOutcomesFromWire(candidate.policyOutcomes, policyIds) }),
  }
}

/** Useful for deterministic provider fixtures and transcript replay tests. */
export function mealPlanSelectionCandidateToWire(
  candidate: MealPlanSelectionCandidate,
): MealPlanSelectionWireCandidate {
  return {
    days: gridToWire(candidate.grid),
    easyBuys: candidate.easyBuys,
    policyOutcomes: Object.entries(candidate.policyOutcomes).map(([policyId, outcome]) => ({ policyId, ...outcome })),
  }
}

/** Useful for deterministic provider fixtures and transcript replay tests. */
export function mealPlanSelectionPatchToWire(candidate: MealPlanSelectionPatch): MealPlanSelectionWirePatch {
  return {
    days: gridToWire(candidate.grid),
    ...(candidate.easyBuys === undefined ? {} : { easyBuys: candidate.easyBuys }),
    ...(candidate.policyOutcomes === undefined
      ? {}
      : {
          policyOutcomes: Object.entries(candidate.policyOutcomes).map(([policyId, outcome]) => ({
            policyId,
            ...outcome,
          })),
        }),
  }
}

function gridToWire(grid: MealPlanSelectionCandidate["grid"]): MealPlanSelectionWireCandidate["days"] {
  return Object.entries(grid).map(([day, cells]) => ({
    day,
    cells: Object.entries(cells).map(([slot, selection]) => ({ slot, selection: selectionToWire(selection) })),
  }))
}

function gridFromWire(days: MealPlanSelectionWireCandidate["days"]): MealPlanSelectionCandidate["grid"] {
  const grid: MealPlanSelectionCandidate["grid"] = {}
  for (const { day, cells } of days) {
    if (grid[day]) throw new ToolHandlerError("duplicate day in meal-plan tool input", "invalid-state")
    const slots: MealPlanSelectionCandidate["grid"][string] = {}
    for (const { slot, selection } of cells) {
      if (slots[slot]) throw new ToolHandlerError("duplicate slot in meal-plan tool input", "invalid-state")
      slots[slot] = selectionFromWire(selection)
    }
    grid[day] = slots
  }
  return grid
}

function selectionToWire(
  selection: MealPlanSelectionCandidate["grid"][string][string],
): z.infer<typeof mealSelectionWireSchema> {
  const { ingredientAliasesUsed, ...selectionWithoutAliases } = selection
  const aliases = ingredientAliasesUsed
    ? Object.entries(ingredientAliasesUsed).map(([availableIngredient, definitionIngredient]) => ({
        availableIngredient,
        definitionIngredient,
      }))
    : undefined
  return { ...selectionWithoutAliases, ...(aliases === undefined ? {} : { ingredientAliasesUsed: aliases }) }
}

function selectionFromWire(
  selection: z.infer<typeof mealSelectionWireSchema>,
): MealPlanSelectionCandidate["grid"][string][string] {
  const { ingredientAliasesUsed, ...selectionWithoutAliases } = selection
  const aliases = ingredientAliasesUsed
    ? Object.fromEntries(
        ingredientAliasesUsed.map(({ availableIngredient, definitionIngredient }) => [
          availableIngredient,
          definitionIngredient,
        ]),
      )
    : undefined
  if (ingredientAliasesUsed && Object.keys(aliases ?? {}).length !== ingredientAliasesUsed.length)
    throw new ToolHandlerError("duplicate ingredient alias in meal-plan tool input", "invalid-state")
  return { ...selectionWithoutAliases, ...(aliases === undefined ? {} : { ingredientAliasesUsed: aliases }) }
}

function policyOutcomesFromWire(
  outcomes: readonly z.infer<typeof policyOutcomeWireSchema>[],
  policyIds: readonly string[],
): MealPlanSelectionCandidate["policyOutcomes"] {
  const allowed = new Set(policyIds)
  const result: MealPlanSelectionCandidate["policyOutcomes"] = {}
  for (const { policyId, outcome, rationale } of outcomes) {
    if (!allowed.has(policyId)) throw new ToolHandlerError("unknown policy in meal-plan tool input", "invalid-state")
    if (result[policyId])
      throw new ToolHandlerError("duplicate policy outcome in meal-plan tool input", "invalid-state")
    result[policyId] = { outcome, rationale }
  }
  return result
}

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

export const weekContextUpdateInputSchema = z
  .object({
    inventoryChanges: z.array(inventoryItemSchema).default([]),
    exceptionAdds: z.array(weeklyExceptionSchema).default([]),
    replan: z.boolean(),
  })
  .strict()
  .describe(
    "Apply only facts the parent supplied: inventoryChanges upsert named items, exceptionAdds add calendar/schedule exceptions, and replan is true only when the parent explicitly asks to revise the plan.",
  )

export type WeekContextUpdateInput = z.infer<typeof weekContextUpdateInputSchema>

/** Parent-message facts extracted before an initial plan is evaluated. */
export const weekContextExtractionInputSchema = z
  .object({
    inventoryChanges: z.array(inventoryItemSchema).default([]),
    exceptionAdds: z.array(weeklyExceptionSchema).default([]),
  })
  .strict()

export type WeekContextExtractionInput = z.infer<typeof weekContextExtractionInputSchema>

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

export const proposePlanWireInputSchema = z
  .object({
    candidate: mealPlanSelectionWireCandidateSchema,
    // The model may only attach a scope interpretation to unscoped feedback;
    // inventory, exceptions, and the feedback source itself stay authoritative
    // in the workflow context and are never echoed by the terminal call.
    feedbackItems: z.array(feedbackItemSchema).optional(),
    // Debug aid only. The session truncates this before retaining it, so a
    // verbose explanation never costs the model another terminal turn.
    justification: z.string().trim().min(1).optional(),
  })
  .strict()

export const proposePlanRevisionWireInputSchema = z
  .object({
    candidate: mealPlanSelectionWirePatchSchema,
    feedbackItems: z.array(feedbackItemSchema).optional(),
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
export function createEvaluateMealPlanTool(context: MealPlanContext, revisionBase?: MealPlanCandidate): ToolDefinition {
  const isRevision = revisionBase !== undefined
  const policyIds = context.customPolicies.map((policy) => policy.id)
  return {
    name: MEAL_PLANNING_TOOL.EVALUATE,
    description: isRevision
      ? "Validate one revision patch against the active plan and household context. Omitted cells remain unchanged. Returns typed failures and measurements; it never persists a plan."
      : "Validate exactly one complete Mon–Sat meal-plan candidate against the household context. Returns typed failures and measurements; it never persists a plan.",
    input: isRevision ? mealPlanSelectionWirePatchSchema : mealPlanSelectionWireCandidateSchema,
    output: mealPlanEvaluationSchema,
    privacy: "private",
    batching: "isolated",
    handler: async (candidate) => {
      const internalCandidate = isRevision
        ? mealPlanSelectionPatchFromWire(candidate as MealPlanSelectionWirePatch, policyIds)
        : mealPlanSelectionCandidateFromWire(candidate as MealPlanSelectionWireCandidate, policyIds)
      return revisionBase
        ? evaluateMealPlanSelectionPatch(internalCandidate as MealPlanSelectionPatch, revisionBase, context).evaluation
        : evaluateMealPlanSelection(internalCandidate as MealPlanSelectionCandidate, context).evaluation
    },
  }
}

export { acceptedOutputSchema }
