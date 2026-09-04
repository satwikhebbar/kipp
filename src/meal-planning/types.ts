export const FAILURE_CODES = [
  "hard_exclusion",
  "non_vegetarian_school_meal",
  "missing_slot",
  "extra_slot_for_closed_day",
  "extra_slot_for_half_day",
  "morning_capacity_exceeded",
  "prior_night_prep_not_allowed",
  "prior_night_prep_limit",
  "slot_unsuitable",
  "inventory_item_unknown",
  "inventory_item_unavailable",
  "use_early_ignored",
  "dish_repeated",
  "missing_policy_outcome",
  "unscoped_cell_changed",
  "unaddressed_feedback",
  "unknown_meal_definition",
  "invalid_ingredient_choice",
  "invalid_ingredient_alias",
  "required_ingredient_unavailable",
  "new_meal_not_allowed",
  "invalid_new_meal",
  "packed_slot_unsuitable",
  "duplicate_meal_selection",
] as const

export type FailureCode = (typeof FAILURE_CODES)[number]

export const EXCEPTION_KINDS = [
  "school_closed",
  "half_day",
  "schedule_change",
  "capacity_change",
  "occasion",
  "plan_request",
] as const

export type ExceptionKind = (typeof EXCEPTION_KINDS)[number]

export const INVENTORY_STATUSES = ["available", "low", "unavailable"] as const

export type InventoryStatus = (typeof INVENTORY_STATUSES)[number]

export const POLICY_OUTCOMES = ["satisfied", "trade-off", "needs-clarification"] as const

export type PolicyOutcomeValue = (typeof POLICY_OUTCOMES)[number]

export const REQUEST_KINDS = ["initial_plan", "revision"] as const

export type RequestKind = (typeof REQUEST_KINDS)[number]

export interface MealSlot {
  id: string
  name: string
  packed: boolean
  dry: boolean
  maxCookMinutes: number | null
}

export interface MealSchedule {
  days: string[]
  slots: MealSlot[]
}

export interface FoodPreferences {
  favourites: string[]
  avoid: string[]
}

export type PriorNightPrepRequirement = "none" | "optional" | "required"

/** A practical, household-owned meal option. It intentionally is not a recipe. */
export interface MealDefinition {
  /** Opaque, server-generated identifier. */
  id: string
  name: string
  aliases?: string[]
  principalIngredients: string[]
  vegetarian: true
  suitableSlots: string[]
  packedFood?: { suitable: boolean; dry: boolean }
  typicalCookMinutes: number
  priorNightPrep: PriorNightPrepRequirement
  requiredIngredients: string[]
  optionalIngredients: string[]
  allowedIngredientChoices?: string[]
  status: "established" | "provisional"
}

/** Model-authored fields used only while expanding a parent-supplied dish name. */
export interface MealDefinitionProposal {
  /** Exact parent-supplied name this proposal expands; it is retained as an alias by the server. */
  sourceDishName: string
  /** The model may improve this display name. */
  name: string
  principalIngredients: string[]
  vegetarian: true
  suitableSlots: string[]
  /** Parent-supplied repertoire meals are always packing-suitable; the model classifies only dryness. */
  packedFood: { dry: boolean }
  typicalCookMinutes: number
  priorNightPrep: PriorNightPrepRequirement
  requiredIngredients: string[]
  optionalIngredients: string[]
  allowedIngredientChoices?: string[]
}

export interface MealDefinitionValidationFailure {
  dishName: string
  code: string
  detail: string
}

export interface MealCatalogExpansionInput {
  parentDishNames: string[]
  schedule: MealSchedule
}

/** An all-or-nothing catalog-expansion result. Definitions are present only when every supplied dish passed validation. */
export interface MealCatalogExpansionResult {
  definitions?: MealDefinition[]
  failures: MealDefinitionValidationFailure[]
}

export interface MealProfile {
  /** Clear-cut exclusions only. Ambiguous household phrases are resolved by the planner (e.g. by clarifying) before they reach the evaluator. */
  dietaryExclusions: string[]
  /** Deprecated setup compatibility data. Planning must use mealDefinitions. */
  dishRepertoire: string[]
  mealDefinitions?: MealDefinition[]
  foodPreferences: FoodPreferences
  allowNewFoods: boolean
  sensoryGuidelines: string[]
  morningCookingBudgetMinutes: number
  priorNightPrepAllowed: boolean
  pantryBaseline: string[]
}

export interface CustomPolicy {
  id: string
  label: string
  scope: "persistent" | "current_week"
  value: string
}

export interface InventoryItem {
  name: string
  status: InventoryStatus
  quantityNote?: string
  useNote?: string
}

export interface WeeklyInventory {
  items: InventoryItem[]
  notes: string[]
}

export interface ExceptionAppliesTo {
  day?: string
  mealSlots?: string[]
}

export interface WeeklyException {
  kind: ExceptionKind
  appliesTo?: ExceptionAppliesTo
  instruction: string
}

export interface WeeklyExceptions {
  items: WeeklyException[]
}

/**
 * The resolved week-scoped state produced by a typed post-plan context update.
 * It is deliberately separate from a meal-plan version: a parent can report
 * inventory or calendar facts without implicitly requesting a new plan.
 */
export interface ResolvedWeekContextUpdate {
  weeklyInventory: WeeklyInventory
  weeklyExceptions: WeeklyExceptions
  replan: boolean
}

export interface PlanRequest {
  kind: RequestKind
  text: string
}

export interface FeedbackItem {
  id: string
  text: string
  /** The Mini App's explicit review target; Telegram text feedback remains unbound. */
  target?: FeedbackTarget
  scope?: { day?: string; slot?: string }
}

/** A whole-plan instruction or an exact persisted day/meal cell request. */
export type FeedbackTarget = { kind: "plan" } | { kind: "cell"; day: string; slot: string }

/** Optional per-cell recipe-video result (lunch slots only). A missing video never gates or alters a plan. */
export interface RecipeVideo {
  status: "found" | "no_suitable_video" | "not_attempted"
  url?: string
  title?: string
  channel?: string
}

export interface MealCell {
  dish: string
  /** School meals are vegetarian by workflow constant; the evaluator rejects a non-vegetarian cell. */
  vegetarian: boolean
  /** Everything the meal draws on: components and pantry/inventory consumption alike (they coincide in this domain). */
  items: string[]
  cookMinutes: number
  priorNightPrep: boolean
  recipeVideo?: RecipeVideo
}

export type MealGrid = Record<string, Record<string, MealCell>>

export interface MealPlanContext {
  schedule: MealSchedule
  profile: MealProfile
  customPolicies: CustomPolicy[]
  weeklyInventory: WeeklyInventory
  weeklyExceptions: WeeklyExceptions
  recentPlan?: MealGrid | null
  request: PlanRequest
  feedbackItems?: FeedbackItem[]
  urgentUseByDay?: string
  requireUrgentUseEarly?: boolean
  requestedRepeats?: string[]
  /** Plan-local definitions inherited from the version being revised. */
  provisionalMealDefinitions?: MealDefinition[]
}

export interface PolicyOutcome {
  outcome: PolicyOutcomeValue
  rationale: string
}

export interface MealPlanCandidate {
  grid: MealGrid
  easyBuys: string[]
  policyOutcomes: Record<string, PolicyOutcome>
}

export interface KnownMealSelection {
  mealDefinitionId: string
  ingredientChoices?: string[]
  /** Maps an available inventory spelling to the selected definition's ingredient spelling. */
  ingredientAliasesUsed?: Record<string, string>
  usesPriorNightPrep?: boolean
}

export interface NewMealProposal {
  name: string
  principalIngredients: string[]
  vegetarian: true
  suitableSlots: string[]
  packedFood?: { suitable: boolean; dry: boolean }
  cookMinutes: number
  priorNightPrep: PriorNightPrepRequirement
  ingredients: string[]
}

export interface NewMealSelection {
  proposedMeal: NewMealProposal
  ingredientAliasesUsed?: Record<string, string>
  usesPriorNightPrep?: boolean
}

/** Exact reuse of a provisional definition already snapshotted on a plan version. */
export interface ProvisionalMealSelection {
  provisionalMealId: string
  ingredientChoices?: string[]
  ingredientAliasesUsed?: Record<string, string>
  usesPriorNightPrep?: boolean
}

export type MealSelection = KnownMealSelection | NewMealSelection | ProvisionalMealSelection
export type MealSelectionGrid = Record<string, Record<string, MealSelection>>

/** The LLM-facing plan contract. It is hydrated before evaluation or persistence. */
export interface MealPlanSelectionCandidate {
  grid: MealSelectionGrid
  easyBuys: string[]
  policyOutcomes: Record<string, PolicyOutcome>
}

/**
 * LLM-facing revision input. Its grid contains only cells the model intends to
 * change; deterministic code retains every omitted cell from the active plan.
 */
export interface MealPlanSelectionPatch {
  grid: MealSelectionGrid
  /** Omit to retain the active plan's shopping list. */
  easyBuys?: string[]
  /** Omit to retain the active plan's recorded policy outcomes. */
  policyOutcomes?: Record<string, PolicyOutcome>
}

export interface MealPlanHydrationResult {
  candidate?: MealPlanCandidate
  provisionalMealDefinitions: MealDefinition[]
  failures: MealPlanFailure[]
}

/** The selection-facing evaluation result: hydration failures or evaluator results, plus its durable candidate. */
export interface MealPlanSelectionEvaluation extends MealPlanHydrationResult {
  evaluation: MealPlanEvaluation
}

export interface MealPlanMeasurements {
  morningCookByDay: Record<string, number>
  morningCookMax: number
  priorNightPrepByDay: Record<string, number>
  priorNightPrepMax: number
  dishRepeatCount: number
  dishRepeats: string[]
  inventoryUsed: string[]
  urgentUseByDay?: string
  easyBuyCount: number
}

export interface MealPlanFailure {
  code: FailureCode
  day?: string
  slot?: string
  detail: string
}

export interface MealPlanEvaluation {
  pass: boolean
  failures: MealPlanFailure[]
  measurements: MealPlanMeasurements
}

export interface MealPlanFailureExpectation {
  code: FailureCode
  day?: string
  slot?: string
}

export interface MealPlanExpectation {
  pass: boolean
  failures?: MealPlanFailureExpectation[]
  noFailuresOf?: FailureCode[]
  measurements?: Partial<MealPlanMeasurements>
}

export interface ScenarioCandidate {
  label: string
  plan: MealPlanCandidate
  expect: MealPlanExpectation
}

export interface ScenarioBehavior {
  expectsClarification: boolean
  clarificationSubject?: string
  expectedPolicyOutcomes?: Record<string, PolicyOutcomeValue>
}

export interface MealPlanScenario {
  id: string
  name: string
  summary: string
  context: MealPlanContext
  candidates: ScenarioCandidate[]
  behavior?: ScenarioBehavior
}
