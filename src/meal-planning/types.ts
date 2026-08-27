export const FAILURE_CODES = [
  "hard_exclusion",
  "non_vegetarian_school_meal",
  "missing_slot",
  "extra_slot_for_closed_day",
  "morning_capacity_exceeded",
  "prior_night_prep_not_allowed",
  "prior_night_prep_limit",
  "slot_unsuitable",
  "inventory_item_unknown",
  "inventory_item_unavailable",
  "use_early_ignored",
  "dish_repeated",
  "unfamiliar_dish_not_allowed",
  "unpaired_new_dish",
  "missing_policy_outcome",
  "unscoped_cell_changed",
  "unaddressed_feedback",
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

export interface MealProfile {
  /** Clear-cut exclusions only. Ambiguous household phrases are resolved by the planner (e.g. by clarifying) before they reach the evaluator. */
  dietaryExclusions: string[]
  dishRepertoire: string[]
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

export interface PlanRequest {
  kind: RequestKind
  text: string
}

export interface FeedbackItem {
  id: string
  text: string
  scope?: { day?: string; slot?: string }
}

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
