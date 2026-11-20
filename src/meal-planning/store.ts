import type { CompletionCounts } from "./completion"
import { completionAdditions, decodeCompletionRejectedIds, decodeCompletionWeeklyExceptions } from "./completion"
import type {
  CustomPolicy,
  FeedbackItem,
  FeedbackTarget,
  MealDefinition,
  MealPlanCandidate,
  MealPlanEvaluation,
  MealProfile,
  MealSchedule,
  RecipeVideo,
  RequestKind,
  WeeklyExceptions,
  WeeklyInventory,
} from "./types"

/** The empty per-cell video record written when enrichment is absent. */
const NO_VIDEOS: Record<string, RecipeVideo> = {}
/** Maximum number of current/replaced plans exposed by one history read. */
export const MAX_MEAL_PLAN_HISTORY = 12
const MAX_MEAL_REJECTION_MERGE_ATTEMPTS = 4
const MAX_MEAL_COMPLETION_ATTEMPTS = 3

/** `{ country, city }` location snapshot stored on the household profile row. */
export interface StoredLocation {
  country: string
  city: string
}

/** A hydrated `meal_profile` row. */
export interface StoredMealProfile {
  chatId: string
  profile: MealProfile
  customPolicies: CustomPolicy[]
  schedule: MealSchedule
  location: StoredLocation | null
  /** Chat-scoped plan-message generation (§6): bumped exactly once per persisted plan message. */
  interactionGeneration: number
  createdAt: string
  updatedAt: string
}

export type MealPlanStatus = "active" | "replaced"

export type MealPlanGenerationStatus = "generating" | "failed"

/** A chat-scoped lease covering initial-plan generation. */
export interface MealPlanGenerationRecord {
  chatId: string
  generationId: string
  status: MealPlanGenerationStatus
  startedAt: string
  expiresAt: string
  updatedAt: string
}

/** LLM token usage and any reported cost recorded for one generated plan version. */
export interface VersionUsage {
  inputTokens: number
  outputTokens: number
  /** Model label retained for diagnostics and historical token pricing. */
  model: string
  /** Complete planner plus classifier USD cost; null means a requested cost was unavailable. */
  costUsd?: number | null
  /** Legacy rows store only their classifier cost in costUsd; reported rows store the full cost. */
  costStatus?: VersionCostStatus
}

export type VersionCostStatus = "legacy" | "reported" | "unavailable"

/** Reject missing reported charges and invalid supplied amounts before any persistence side effect. */
function assertVersionCostIsValid(usage: VersionUsage | null | undefined): void {
  if (!usage) return
  const status = usage.costStatus ?? versionCostStatus(usage.costUsd)
  if (status === "unavailable" && usage.costUsd != null)
    throw new Error("unavailable usage cost requires a null or omitted costUsd")
  if (
    (status === "reported" || usage.costUsd != null) &&
    (typeof usage.costUsd !== "number" || !Number.isFinite(usage.costUsd) || usage.costUsd < 0)
  ) {
    throw new Error(`${status} usage cost requires a finite non-negative numeric costUsd`)
  }
}

/** Derives the persistence state for omitted, missing, or reported cost. */
function versionCostStatus(cost: number | null | undefined): VersionCostStatus {
  return cost === undefined ? "legacy" : cost === null ? "unavailable" : "reported"
}

/** Cumulative usage summed across plan versions, grouped by model and reported-cost status. */
export interface PlanUsageTotal {
  inputTokens: number
  outputTokens: number
  byModel: VersionUsage[]
}

/** A hydrated `meal_plan` header row (plan identity, week bounds, live instance, week-scoped state). */
export interface MealPlanRecord {
  planId: string
  chatId: string
  weekStart: string
  weekEnd: string
  timezone: string
  instanceId: string
  status: MealPlanStatus
  currentVersion: number
  weeklyInventory: WeeklyInventory
  weeklyExceptions: WeeklyExceptions
  createdAt: string
  updatedAt: string
  replacedAt: string | null
  approvedVersion: number | null
  rejectedVersion: number | null
  rejectedMealIds: string[]
}

/** A hydrated, immutable `meal_plan_version` row. */
export interface MealPlanVersionRecord {
  planId: string
  version: number
  candidate: MealPlanCandidate
  evaluation: MealPlanEvaluation
  requestKind: RequestKind
  baseVersion: number | null
  feedbackBatchId: string | null
  /** Per-cell video results (lunch slots), as stored; keyed by `${dish}:${slotId}`. */
  video: Record<string, RecipeVideo>
  /** Full plan-local snapshot, including inherited unchanged provisional meals. */
  provisionalMealDefinitions: MealDefinition[]
  /** Token usage that produced this version; null for rows persisted before cost tracking. */
  usage: VersionUsage | null
  createdAt: string
  /** Historical profile policy captured when this immutable version was evaluated. */
  allowNewFoodsSnapshot: boolean | null
}

/** The active plan plus its current version — the read shape for the live loop and the iteration-2 mini-app. */
export interface ActivePlanRecord {
  plan: MealPlanRecord
  version: MealPlanVersionRecord
}

/** A hydrated `feedback_batch` row. */
export interface FeedbackBatchRecord {
  batchId: string
  planId: string
  baseVersion: number
  items: FeedbackItem[]
  /** Derived from meal_plan for dispatch; not persisted on feedback_batch. */
  chatId?: string | null
  workflowInstanceId?: string | null
  weekEnd?: string | null
  idempotencyKey: string | null
  status: FeedbackBatchStatus
  failureCategory: FeedbackBatchFailureCategory | null
  failureNotifiedAt: string | null
  createdAt: string
  updatedAt?: string
  /** Transitional in-memory test projections; no longer persisted by D1. */
  acceptedAt?: string | null
  deliveredAt?: string | null
  processingAt?: string | null
  consumedAt?: string | null
  staleAt?: string | null
  failedAt?: string | null
}

export type FeedbackBatchStatus = "accepted" | "delivered" | "processing" | "consumed" | "stale" | "failed"
export type FeedbackBatchFailureCategory = "dispatch" | "workflow" | "unknown"

/** Durable private-chat scope written when a persisted plan gets a Mini App button. */
export interface MiniAppReviewContext {
  telegramUserId: string
  chatId: string
  planId: string
  weekEnd: string
  createdAt: string
  updatedAt: string
}

/** A stored opaque-session digest; raw browser bearers are never persisted. */
export interface MiniAppSessionRecord {
  sessionId: string
  tokenHash: string
  telegramUserId: string
  chatId: string
  planId: string
  expiresAt: string
  createdAt: string
}

export interface CreateMiniAppSessionInput extends Omit<MiniAppSessionRecord, "createdAt"> {
  createdAt?: string
}

export interface AcceptFeedbackBatchInput {
  batchId: string
  planId: string
  chatId: string
  baseVersion: number
  workflowInstanceId: string
  idempotencyKey: string
  /** Untrusted JSON at the HTTP boundary; this store normalizes it before persistence. */
  items: unknown
}

export type AcceptFeedbackBatchResult =
  | { ok: true; batch: FeedbackBatchRecord; duplicate: boolean }
  | { ok: false; reason: "stale" | "generating" | "idempotency_mismatch" | "invalid_items" }

export interface StartPlanGenerationInput {
  chatId: string
  generationId: string
  expiresAt: string
  startedAt?: string
}

/** Input to `createActivePlan`: everything the atomic initial-plan batch needs. */
export interface CreateActivePlanInput {
  planId: string
  chatId: string
  weekStart: string
  weekEnd: string
  timezone: string
  /** The live Workflow instance id — the webhook's fallthrough pointer (§6). */
  instanceId: string
  /** Generation lease token; plan creation is rejected when it is absent, expired, or superseded. */
  generationId: string
  candidate: MealPlanCandidate
  evaluation: MealPlanEvaluation
  weeklyInventory: WeeklyInventory
  weeklyExceptions: WeeklyExceptions
  video?: Record<string, RecipeVideo>
  provisionalMealDefinitions?: MealDefinition[]
  /** Token usage of the generation session(s); omitted when unavailable. */
  usage?: VersionUsage
  /** Profile policy snapshot used to evaluate this version. */
  allowNewFoodsSnapshot?: boolean
}

/** Result of a committed initial-plan batch. */
export interface CreateActivePlanResult {
  plan: MealPlanRecord
  version: MealPlanVersionRecord
  generation: number
  /** True when a previous active plan was superseded by this create (the parent gets a "previous plan replaced" notice). */
  previousReplaced: boolean
}

/** The target week closed before the initial plan could be persisted. */
export class PlanWeekClosedError extends Error {
  constructor() {
    super("target meal plan week has closed")
  }
}

/** One immutable submission batch written atomically with the revision it drives. */
export interface FeedbackBatchInput {
  batchId: string
  items: FeedbackItem[]
  /** The Mini App path can consume only the batch the workflow claimed. */
  consumeExisting?: boolean
}

/** Input to `promotePlanVersion`: `baseVersion` is the CAS base; the new version is always `baseVersion + 1`. */
export interface PromotePlanVersionInput {
  planId: string
  chatId: string
  baseVersion: number
  candidate: MealPlanCandidate
  evaluation: MealPlanEvaluation
  video?: Record<string, RecipeVideo>
  provisionalMealDefinitions?: MealDefinition[]
  /** Week-scoped state captured by the revision session; omit (or null) to skip the refresh. */
  inventory?: { weeklyInventory: WeeklyInventory; weeklyExceptions: WeeklyExceptions } | null
  /** Week context read by the planner, which can change without a new plan version. */
  expectedWeekContext?: Pick<MealPlanRecord, "weeklyInventory" | "weeklyExceptions">
  /** The submission that drove this revision; omit (or null) only defensively — every revision is submission-driven. */
  feedbackBatch?: FeedbackBatchInput | null
  /** Token usage of the revision's generation session(s); omitted when unavailable. */
  usage?: VersionUsage
  /** Profile policy snapshot used to evaluate this version. */
  allowNewFoodsSnapshot?: boolean
}

export interface UpdateWeeklyContextInput {
  planId: string
  chatId: string
  baseVersion: number
  weeklyInventory: WeeklyInventory
  weeklyExceptions: WeeklyExceptions
  expectedWeekContext?: PromotePlanVersionInput["expectedWeekContext"]
}

export type UpdateWeeklyContextResult = { ok: true } | { ok: false; reason: "stale" }

/** A stale call changes nothing; the only defined failure reason is `stale`. */
export type PromotePlanVersionResult =
  | { ok: true; version: MealPlanVersionRecord; generation: number }
  | { ok: false; reason: "stale" }

/** The active plan's identity plus live instance — the webhook's level-3 fallthrough pointer (§6). */
export interface ActivePlanPointer {
  instanceId: string
  weekEnd: string
}

export interface MealCompletionTarget {
  planId: string
  chatId: string
  weekEnd: string
}

/** The typed meal-planning store surface. The D1 and in-memory implementations share the same invariants. */
export interface MealPlanningStore {
  loadOrCreateProfile(chatId: string): Promise<StoredMealProfile>
  claimDueMealCompletion(seen: ReadonlySet<string>): Promise<MealCompletionTarget | null>
  completeEligibleMealPlan(target: MealCompletionTarget): Promise<CompletionCounts | null>
  createActivePlan(input: CreateActivePlanInput): Promise<CreateActivePlanResult>
  promotePlanVersion(input: PromotePlanVersionInput): Promise<PromotePlanVersionResult>
  decidePlanVersion(input: {
    chatId: string
    planId: string
    version: number
    action: "accept" | "reject"
  }): Promise<boolean>
  rejectPlanDishes(input: { chatId: string; planId: string; version: number; mealIds: string[] }): Promise<boolean>
  /** Sums token usage across a plan's versions that recorded it; null when none did. */
  sumPlanUsage(planId: string): Promise<PlanUsageTotal | null>
  /** Updates only week-scoped inventory/calendar facts; it never creates a plan version. */
  updateWeeklyContext(input: UpdateWeeklyContextInput): Promise<UpdateWeeklyContextResult>
  startPlanGeneration(input: StartPlanGenerationInput): Promise<MealPlanGenerationRecord>
  finishPlanGeneration(chatId: string, generationId: string, failed?: boolean): Promise<boolean>
  activePlanGeneration(chatId: string, now?: string): Promise<MealPlanGenerationRecord | null>
  activePlan(chatId: string): Promise<ActivePlanRecord | null>
  /** Latest plan for this chat and exact school week, including replaced plans. */
  latestPlanForWeek(chatId: string, weekStart: string): Promise<ActivePlanRecord | null>
  listPlanHistory(chatId: string): Promise<ActivePlanRecord[]>
  planById(chatId: string, planId: string): Promise<ActivePlanRecord | null>
  /** Reads the active plan's live instance pointer (whether or not its week has ended). */
  activePlanPointer(chatId: string): Promise<ActivePlanPointer | null>
  upsertMiniAppReviewContext(
    input: Omit<MiniAppReviewContext, "createdAt" | "updatedAt">,
  ): Promise<MiniAppReviewContext>
  resolveMiniAppReviewContext(telegramUserId: string): Promise<MiniAppReviewContext | null>
  createMiniAppSession(input: CreateMiniAppSessionInput): Promise<MiniAppSessionRecord>
  readMiniAppSession(tokenHash: string, now: string): Promise<MiniAppSessionRecord | null>
  /** Atomically consumes a replay fingerprint until its supplied expiry. */
  consumeMiniAppInitDataFingerprint(fingerprintHash: string, expiresAt: string, now: string): Promise<boolean>
  acceptFeedbackBatch(input: AcceptFeedbackBatchInput): Promise<AcceptFeedbackBatchResult>
  feedbackBatch(batchId: string): Promise<FeedbackBatchRecord | null>
  markFeedbackBatchDelivered(batchId: string): Promise<boolean>
  claimFeedbackBatchForWorkflow(batchId: string, instanceId: string, now: string): Promise<FeedbackBatchRecord | null>
  markFeedbackBatchStale(batchId: string, now: string): Promise<boolean>
  markFeedbackBatchConsumed(batchId: string, now: string): Promise<boolean>
  markFeedbackBatchFailed(batchId: string, category: FeedbackBatchFailureCategory, now: string): Promise<boolean>
  /** Claims the one safe Telegram failure notification for a terminal batch. */
  claimFeedbackBatchFailureNotification(batchId: string, now: string): Promise<boolean>
}

/**
 * Backing state shared across in-memory store instances. Passing the same
 * backing to a fresh `createInMemoryMealPlanningStore` call simulates process
 * restart survival (a new store reads the same committed state).
 */
export interface InMemoryMealPlanningBacking {
  profiles: Map<string, StoredMealProfile>
  plans: Map<string, MealPlanRecord>
  versions: Map<string, MealPlanVersionRecord>
  batches: Map<string, FeedbackBatchRecord>
  reviewContexts?: Map<string, MiniAppReviewContext>
  sessions?: Map<string, MiniAppSessionRecord>
  initDataFingerprints?: Map<string, string>
  generations?: Map<string, MealPlanGenerationRecord>
  completedPlans?: Set<string>
  completionCursor?: MealCompletionTarget
}

/** Options for the in-memory store; `failNextOn` is a single-shot test hook that simulates a mid-batch statement failure. */
export interface InMemoryMealPlanningStoreOptions {
  backing?: InMemoryMealPlanningBacking
  failNextOn?: "createActivePlan" | "promotePlanVersion"
}

export const SEED_SCHEDULE: MealSchedule = {
  days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  halfDays: ["Sat"],
  slots: [
    { id: "breakfast", name: "Breakfast", packed: false, dry: false, maxCookMinutes: null },
    { id: "snack1", name: "Snack 1", packed: true, dry: true, maxCookMinutes: 0 },
    { id: "snack2", name: "Snack 2", packed: true, dry: true, maxCookMinutes: 0 },
    { id: "school-lunch", name: "School lunch", packed: true, dry: false, maxCookMinutes: null },
    { id: "home-lunch", name: "Home lunch", packed: false, dry: false, maxCookMinutes: null },
  ],
}

/** Add the starter household's recurring Saturday rule to profiles created before it was stored. */
export function upgradeLegacyMealSchedule(schedule: MealSchedule): MealSchedule {
  return schedule.halfDays === undefined && schedule.days.includes("Sat")
    ? { ...schedule, halfDays: ["Sat"] }
    : schedule
}

const SEED_MEAL_INGREDIENTS: Record<string, string[]> = {
  paratha: ["wheat flour"],
  banana: ["banana"],
  "roasted chana": ["chana"],
  "bottle gourd dal": ["bottle gourd", "moong dal"],
  poha: ["poha"],
  apple: ["apple"],
  dates: ["dates"],
  rajma: ["kidney beans"],
  idli: ["idli batter"],
  khichdi: ["rice", "moong dal"],
  upma: ["upma rava"],
  pear: ["pear"],
  chole: ["chickpeas"],
  dosa: ["dosa batter"],
  pomegranate: ["pomegranate"],
  "paneer paratha": ["wheat flour", "paneer"],
  "masala oats": ["oats"],
  "aloo paratha": ["wheat flour", "potato"],
  "mooli paratha": ["wheat flour", "radish"],
  "gobi paratha": ["wheat flour", "cauliflower"],
  puri: ["wheat flour", "oil"],
  "aloo subzi": ["potato"],
  "mixed nuts": ["mixed nuts"],
  "roasted makhana": ["makhana"],
  "milk + chocos": ["milk", "cocoa cereal"],
  quesadilla: ["wheat flour", "sliced cheese"],
  papaya: ["papaya"],
  "roasted pistachios": ["pistachios"],
  pancakes: ["wheat flour", "milk"],
  "tomato rice": ["rice", "tomato"],
  "broad beans subzi": ["broad beans"],
  "french beans subzi": ["french beans"],
  "ridge gourd curry": ["ridge gourd"],
  paniyaram: ["idli batter"],
  uttappam: ["idli batter"],
  "sabudana khichdi": ["sabudana"],
  "vegetable cutlet": ["potato", "carrot", "peas"],
  "sabudana cutlet": ["sabudana", "potato"],
}

const SEED_DRY_SNACKS = new Set([
  "banana",
  "roasted chana",
  "apple",
  "dates",
  "pear",
  "pomegranate",
  "mixed nuts",
  "roasted makhana",
  "roasted pistachios",
])
const SEED_HALF_DAY_SNACKS = new Set(["dosa", "pancakes", "paniyaram", "vegetable cutlet", "sabudana cutlet"])
const SEED_COOKED_MEAL_MINUTES = 20

const SEED_MEAL_SLOTS: Record<string, string[]> = {
  paratha: ["breakfast", "school-lunch", "home-lunch"],
  banana: ["snack1", "snack2"],
  "roasted chana": ["snack1", "snack2"],
  "bottle gourd dal": ["school-lunch", "home-lunch"],
  poha: ["breakfast", "school-lunch", "home-lunch"],
  apple: ["snack1", "snack2"],
  dates: ["snack1", "snack2"],
  rajma: ["school-lunch", "home-lunch"],
  idli: ["breakfast", "school-lunch", "home-lunch"],
  khichdi: ["school-lunch", "home-lunch"],
  upma: ["breakfast", "school-lunch", "home-lunch"],
  pear: ["snack1", "snack2"],
  chole: ["school-lunch", "home-lunch"],
  dosa: ["breakfast", "school-lunch", "home-lunch"],
  pomegranate: ["snack1", "snack2"],
  "paneer paratha": ["breakfast", "school-lunch", "home-lunch"],
  "masala oats": ["breakfast", "home-lunch"],
  "aloo paratha": ["breakfast", "school-lunch", "home-lunch"],
  "mooli paratha": ["breakfast", "school-lunch", "home-lunch"],
  "gobi paratha": ["breakfast", "school-lunch", "home-lunch"],
  puri: ["breakfast", "school-lunch", "home-lunch"],
  "aloo subzi": ["school-lunch", "home-lunch"],
  "mixed nuts": ["snack1", "snack2"],
  "roasted makhana": ["snack1", "snack2"],
  "milk + chocos": ["breakfast"],
  quesadilla: ["breakfast", "school-lunch", "home-lunch"],
  papaya: ["snack1", "snack2"],
  "roasted pistachios": ["snack1", "snack2"],
  pancakes: ["breakfast", "school-lunch", "home-lunch"],
  "tomato rice": ["school-lunch", "home-lunch"],
  "broad beans subzi": ["school-lunch", "home-lunch"],
  "french beans subzi": ["school-lunch", "home-lunch"],
  "ridge gourd curry": ["school-lunch", "home-lunch"],
  paniyaram: ["breakfast", "school-lunch", "home-lunch"],
  uttappam: ["breakfast", "school-lunch", "home-lunch"],
  "sabudana khichdi": ["breakfast", "school-lunch", "home-lunch"],
  "vegetable cutlet": ["breakfast", "school-lunch"],
  "sabudana cutlet": ["school-lunch", "home-lunch"],
}

/** Fixed opaque ids for the development catalog; names are deliberately not encoded in ids. */
export const SEED_MEAL_IDS: Record<string, string> = {
  paratha: "meal_01j1f0a7q2e6m3z8",
  banana: "meal_01j1f0b4w9k2r6x5",
  "roasted chana": "meal_01j1f0c8n4v7p2s6",
  "bottle gourd dal": "meal_01j1f0d3h8t5y9a1",
  poha: "meal_01j1f0f9r5x3k7n2",
  apple: "meal_01j1f0g2v8p4s6h9",
  dates: "meal_01j1f0h7m3z9e5q1",
  rajma: "meal_01j1f0j4k8n2w6x3",
  idli: "meal_01j1f0m2q6w4y8r5",
  khichdi: "meal_01j1f0q1s7e3x8w6",
  upma: "meal_01j1f0s4k8n6v2q7",
  pear: "meal_01j1f0t9w3x7m5z1",
  chole: "meal_01j1f0w7n3q9x5m2",
  dosa: "meal_01j1f0y1k7m4z9q3",
  pomegranate: "meal_01j1f0z8x2w6n5v7",
  "paneer paratha": "meal_01j1f102m6q4x7z2",
  "masala oats": "meal_01j1f103v5n8h2s6",
  "aloo paratha": "meal_01j1f104b7k3m9q2",
  "mooli paratha": "meal_01j1f105c8n4p6r3",
  "gobi paratha": "meal_01j1f106d9q5s7t4",
  puri: "meal_01j1f107e2w6u8v5",
  "aloo subzi": "meal_01j1f108f3x7y9z6",
  "mixed nuts": "meal_01j1f109g4a8b2c7",
  "roasted makhana": "meal_01j1f10ah5d9e3f8",
  "milk + chocos": "meal_01j1f10bj6g2h4k9",
  quesadilla: "meal_01j1f10ck7m3n5p2",
  papaya: "meal_01j1f10dl8q4r6s3",
  "roasted pistachios": "meal_01j1f10em9t5u7v4",
  pancakes: "meal_01j1f10fn2w6x8y5",
  "tomato rice": "meal_01j1f10gp3z7a9b6",
  "broad beans subzi": "meal_01j1f10hq4c8d2e7",
  "french beans subzi": "meal_01j1f10jr5f9g3h8",
  "ridge gourd curry": "meal_01j1f10ks6i2j4m9",
  paniyaram: "meal_01j1f10lt7n3p5q2",
  uttappam: "meal_01j1f10mu8r4s6t3",
  "sabudana khichdi": "meal_01j1f10nv9v5w7x4",
  "vegetable cutlet": "meal_01j1f10pw2y6z8a5",
  "sabudana cutlet": "meal_01j1f10qx3b7c9d6",
}

export const SEED_PROFILE: MealProfile = {
  dietaryExclusions: ["egg"],
  dishRepertoire: [
    "paratha",
    "banana",
    "roasted chana",
    "bottle gourd dal",
    "poha",
    "apple",
    "dates",
    "rajma",
    "idli",
    "khichdi",
    "upma",
    "pear",
    "chole",
    "dosa",
    "pomegranate",
    "paneer paratha",
    "masala oats",
    "aloo paratha",
    "mooli paratha",
    "gobi paratha",
    "puri",
    "aloo subzi",
    "mixed nuts",
    "roasted makhana",
    "milk + chocos",
    "quesadilla",
    "papaya",
    "roasted pistachios",
    "pancakes",
    "tomato rice",
    "broad beans subzi",
    "french beans subzi",
    "ridge gourd curry",
    "paniyaram",
    "uttappam",
    "sabudana khichdi",
    "vegetable cutlet",
    "sabudana cutlet",
  ],
  mealDefinitions: [
    "paratha",
    "banana",
    "roasted chana",
    "bottle gourd dal",
    "poha",
    "apple",
    "dates",
    "rajma",
    "idli",
    "khichdi",
    "upma",
    "pear",
    "chole",
    "dosa",
    "pomegranate",
    "paneer paratha",
    "masala oats",
    "aloo paratha",
    "mooli paratha",
    "gobi paratha",
    "puri",
    "aloo subzi",
    "mixed nuts",
    "roasted makhana",
    "milk + chocos",
    "quesadilla",
    "papaya",
    "roasted pistachios",
    "pancakes",
    "tomato rice",
    "broad beans subzi",
    "french beans subzi",
    "ridge gourd curry",
    "paniyaram",
    "uttappam",
    "sabudana khichdi",
    "vegetable cutlet",
    "sabudana cutlet",
  ].map((name): MealDefinition => {
    const id = SEED_MEAL_IDS[name]
    if (!id) throw new Error(`missing seed meal id for ${name}`)
    return {
      id,
      name,
      aliases: [name],
      principalIngredients: SEED_MEAL_INGREDIENTS[name] ?? [name],
      vegetarian: true,
      suitableSlots: SEED_MEAL_SLOTS[name] ?? ["home-lunch"],
      ...(SEED_HALF_DAY_SNACKS.has(name) ? { halfDaySnack: true as const } : {}),
      // Parent-provided repertoire meals are trusted as packable. Dry classification is deliberately conservative.
      packedFood: { suitable: true, dry: SEED_DRY_SNACKS.has(name) || SEED_HALF_DAY_SNACKS.has(name) },
      typicalCookMinutes: SEED_DRY_SNACKS.has(name) ? 0 : SEED_COOKED_MEAL_MINUTES,
      priorNightPrep: name === "rajma" ? "required" : "none",
      requiredIngredients: SEED_MEAL_INGREDIENTS[name] ?? [name],
      optionalIngredients: [],
      status: "established",
    }
  }),
  foodPreferences: { favourites: ["paratha"], avoid: [] },
  allowNewFoods: true,
  sensoryGuidelines: [],
  morningCookingBudgetMinutes: 40,
  priorNightPrepAllowed: false,
  pantryBaseline: [
    "rice",
    "wheat flour",
    "oil",
    "spices",
    "moong dal",
    "ghee",
    "toor dal",
    "urad dal",
    "flattened rice (poha)",
    "rava",
    "maida",
    "sliced cheese",
    "rajma beans",
    "white chickpeas",
    "sabudana",
    "peanuts",
  ],
}

/** Adds the new half-day capability to legacy copies of the built-in household catalog. */
export function upgradeLegacyHalfDaySnackDefinitions(profile: MealProfile): MealProfile {
  const definitions = profile.mealDefinitions
  if (!definitions) return profile
  let changed = false
  const upgraded = definitions.map((definition) => {
    if (!SEED_HALF_DAY_SNACKS.has(definition.name)) return definition
    if (definition.halfDaySnack && definition.packedFood?.suitable && definition.packedFood.dry) return definition
    changed = true
    return {
      ...definition,
      halfDaySnack: true,
      packedFood: { suitable: true, dry: true },
    }
  })
  return changed ? { ...profile, mealDefinitions: upgraded } : profile
}

/** The initial household configuration per spec §5.11 (planning policies for snacks, ingredients, variety, nutrition, and school rules). */
const SEED_CUSTOM_POLICIES: CustomPolicy[] = [
  {
    id: "snack-policy",
    label: "Snack policy",
    scope: "persistent",
    value: "School snacks should usually be dry, quick to pack, and not cooked that morning.",
  },
  {
    id: "ingredient-naming",
    label: "Ingredient naming",
    scope: "persistent",
    value: "Use ingredient names localized to India and always write them in singular form.",
  },
  {
    id: "relevant-variety",
    label: "Relevant variety",
    scope: "persistent",
    value: "Repeat a dish at most twice in the plan, and only when it is marked as a favourite.",
  },
  {
    id: "nutrition-target-fruit",
    label: "Nutrition target",
    scope: "persistent",
    value: "Pack fruit in exactly three snacks each week.",
  },
  {
    id: "nutrition-target-nuts",
    label: "Nutrition target",
    scope: "persistent",
    value: "Include nuts or dry fruits regularly.",
  },
  {
    id: "school-rule",
    label: "School rule",
    scope: "persistent",
    value: "Avoid biscuits, chips, and junk food in packed meals.",
  },
  {
    id: "cheat-day",
    label: "Friday cheat day",
    scope: "persistent",
    value:
      "School-day meals are planned healthy and nutritious by default. Friday is the single scheduled exception: one indulgent treat (e.g., a sweeter breakfast, a richer dish, or a dessert) may appear that day. The treat never relaxes hard dietary exclusions, vegetarian school meals, the dry/packable snack rule, the school rule against biscuits/chips/junk in packed meals, the morning cook budget, or the prior-night-prep rules.",
  },
]

const D1_NOW_ISO = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

/** ISO-8601 UTC at fixed millisecond precision — the only timestamp format D1 rows may carry. */
function nowIso(): string {
  return new Date().toISOString()
}

/** Parses a stored JSON column; malformed or missing JSON falls back to `fallback`. */
function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** Hydrates a feedback row while retaining the null scope of legacy Telegram revisions. */
function feedbackBatchFromRow(row: Record<string, unknown>): FeedbackBatchRecord {
  return {
    batchId: String(row.batch_id),
    planId: String(row.plan_id),
    baseVersion: Number(row.base_version),
    items: parseJson<FeedbackItem[]>(String(row.items_json), []),
    chatId: row.chat_id === null || row.chat_id === undefined ? null : String(row.chat_id),
    workflowInstanceId:
      row.workflow_instance_id === null || row.workflow_instance_id === undefined
        ? null
        : String(row.workflow_instance_id),
    weekEnd: row.week_end === null || row.week_end === undefined ? null : String(row.week_end),
    idempotencyKey: row.idempotency_key === null ? null : String(row.idempotency_key),
    status: String(row.status) as FeedbackBatchStatus,
    failureCategory:
      row.failure_category === null ? null : (String(row.failure_category) as FeedbackBatchFailureCategory),
    failureNotifiedAt: row.failure_notified_at === null ? null : String(row.failure_notified_at),
    createdAt: String(row.created_at),
    updatedAt: row.updated_at === null ? undefined : String(row.updated_at),
  }
}

const MAX_MINI_APP_FEEDBACK_ITEMS = 20
const MAX_MINI_APP_FEEDBACK_TEXT_LENGTH = 1_000

/**
 * Converts untrusted Mini App JSON to the sole persisted feedback shape. Cell
 * targets must name both a configured schedule slot and an actual current-plan
 * cell; closed holidays therefore cannot receive feedback.
 */
function normalizeMiniAppFeedbackItems(
  rawItems: unknown,
  candidate: MealPlanCandidate,
  schedule: MealSchedule,
): Array<FeedbackItem & { target: FeedbackTarget }> | null {
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > MAX_MINI_APP_FEEDBACK_ITEMS) return null
  const normalized: Array<FeedbackItem & { target: FeedbackTarget }> = []
  for (const [index, rawItem] of rawItems.entries()) {
    if (!rawItem || typeof rawItem !== "object") return null
    const item = rawItem as Record<string, unknown>
    if (typeof item.text !== "string") return null
    const text = item.text.trim()
    if (!text || text.length > MAX_MINI_APP_FEEDBACK_TEXT_LENGTH) return null
    if (!item.target || typeof item.target !== "object") return null
    const target = item.target as Record<string, unknown>
    if (target.kind === "plan") {
      normalized.push({ id: `mini-${index + 1}`, text, target: { kind: "plan" } })
      continue
    }
    if (target.kind !== "cell" || typeof target.day !== "string" || typeof target.slot !== "string") return null
    const day = target.day.trim()
    const slot = target.slot.trim()
    if (!schedule.days.includes(day) || !schedule.slots.some((scheduleSlot) => scheduleSlot.id === slot)) return null
    if (!candidate.grid[day]?.[slot]) return null
    normalized.push({
      id: `mini-${index + 1}`,
      text,
      target: { kind: "cell", day, slot },
      // Existing planning/evaluation contracts use scope. Preserve it as the
      // internal projection of the Mini App's explicit cell target.
      scope: { day, slot },
    })
  }
  return normalized
}

/** Stable map key for a (plan, version) pair. */
function versionKey(planId: string, version: number): string {
  return `${planId}:${version}`
}

/** Mirrors the D1 snapshot comparison for in-memory writes. */
function matchesWeekContext(plan: MealPlanRecord, expected: PromotePlanVersionInput["expectedWeekContext"]): boolean {
  return (
    !expected ||
    (JSON.stringify(plan.weeklyInventory) === JSON.stringify(expected.weeklyInventory) &&
      JSON.stringify(plan.weeklyExceptions) === JSON.stringify(expected.weeklyExceptions))
  )
}

/** Constructs the hydrated `MealPlanRecord` a create batch just wrote (always the fresh active plan at version 1). */
function makePlanRecord(input: CreateActivePlanInput, now: string): MealPlanRecord {
  return {
    planId: input.planId,
    chatId: input.chatId,
    weekStart: input.weekStart,
    weekEnd: input.weekEnd,
    timezone: input.timezone,
    instanceId: input.instanceId,
    status: "active",
    currentVersion: 1,
    weeklyInventory: input.weeklyInventory,
    weeklyExceptions: input.weeklyExceptions,
    createdAt: now,
    updatedAt: now,
    replacedAt: null,
    approvedVersion: 1,
    rejectedVersion: null,
    rejectedMealIds: [],
  }
}

/** Constructs the hydrated `MealPlanVersionRecord` a batch just wrote. */
function makeVersionRecord(
  planId: string,
  version: number,
  candidate: MealPlanCandidate,
  evaluation: MealPlanEvaluation,
  requestKind: RequestKind,
  baseVersion: number | null,
  feedbackBatchId: string | null,
  video: Record<string, RecipeVideo>,
  provisionalMealDefinitions: MealDefinition[],
  usage: VersionUsage | null,
  now: string,
  allowNewFoodsSnapshot: boolean | null = null,
): MealPlanVersionRecord {
  return {
    planId,
    version,
    candidate,
    evaluation,
    requestKind,
    baseVersion,
    feedbackBatchId,
    video,
    provisionalMealDefinitions,
    usage: usage ? { ...usage } : null,
    createdAt: now,
    allowNewFoodsSnapshot,
  }
}

const PLAN_WITH_VERSION_COLUMNS = `
  SELECT p.plan_id, p.chat_id, p.week_start, p.week_end, p.timezone, p.instance_id, p.status,
         p.current_version, p.weekly_inventory_json, p.weekly_exceptions_json, p.created_at, p.updated_at,
         p.replaced_at, p.approved_version, p.rejected_version, p.rejected_meal_ids_json,
         v.version, v.candidate_json, v.evaluation_json, v.request_kind, v.base_version,
         v.feedback_batch_id, v.video_json, v.provisional_meals_json,
         v.usage_input_tokens, v.usage_output_tokens, v.usage_model,
         v.cost_usd, v.cost_status, v.allow_new_foods_snapshot,
         v.created_at AS version_created_at`
const PLAN_WITH_VERSION_FROM = `
  FROM meal_plan p
  JOIN meal_plan_version v ON v.plan_id = p.plan_id AND v.version = p.current_version`

// Keep due selection and the SQL write authorization on the same eligibility predicate.
const ELIGIBLE_FOR_COMPLETION = `
  p.week_end <= ${D1_NOW_ISO}
  AND p.created_at < p.week_end AND v.created_at < p.week_end
  AND (p.status = 'active' OR p.replaced_at > p.week_end)
  AND p.approved_version = p.current_version
  AND (p.rejected_version IS NULL OR p.rejected_version != p.current_version)
  AND v.allow_new_foods_snapshot = 1
  AND NOT EXISTS (SELECT 1 FROM meal_plan_completion c WHERE c.plan_id = p.plan_id)
  AND NOT EXISTS (
    SELECT 1 FROM meal_plan newer WHERE newer.chat_id = p.chat_id AND newer.week_start = p.week_start
      AND (newer.created_at, newer.rowid) > (p.created_at, p.rowid)
  )
`

const PLAN_WITH_VERSION_SELECT = `${PLAN_WITH_VERSION_COLUMNS} ${PLAN_WITH_VERSION_FROM}`

/** Hydrates a plan header and its immutable current version from a joined row. */
function mealPlanFromRow(row: Record<string, unknown>): ActivePlanRecord {
  return {
    plan: {
      planId: String(row.plan_id),
      chatId: String(row.chat_id),
      weekStart: String(row.week_start),
      weekEnd: String(row.week_end),
      timezone: String(row.timezone),
      instanceId: String(row.instance_id),
      status: String(row.status) as MealPlanStatus,
      currentVersion: Number(row.current_version),
      weeklyInventory: parseJson<WeeklyInventory>(String(row.weekly_inventory_json), { items: [], notes: [] }),
      weeklyExceptions: parseJson<WeeklyExceptions>(String(row.weekly_exceptions_json), { items: [] }),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      replacedAt: row.replaced_at == null ? null : String(row.replaced_at),
      approvedVersion: row.approved_version == null ? null : Number(row.approved_version),
      rejectedVersion: row.rejected_version == null ? null : Number(row.rejected_version),
      rejectedMealIds: parseJson<string[]>(String(row.rejected_meal_ids_json), []),
    },
    version: {
      planId: String(row.plan_id),
      version: Number(row.version),
      candidate: parseJson<MealPlanCandidate>(String(row.candidate_json), {
        grid: {},
        easyBuys: [],
        policyOutcomes: {},
      }),
      evaluation: parseJson<MealPlanEvaluation>(String(row.evaluation_json), {
        pass: false,
        failures: [],
        measurements: {
          morningCookByDay: {},
          morningCookMax: 0,
          priorNightPrepByDay: {},
          priorNightPrepMax: 0,
          dishRepeatCount: 0,
          dishRepeats: [],
          inventoryUsed: [],
          easyBuyCount: 0,
        },
      }),
      requestKind: String(row.request_kind) as RequestKind,
      baseVersion: row.base_version === null ? null : Number(row.base_version),
      feedbackBatchId: row.feedback_batch_id === null ? null : String(row.feedback_batch_id),
      video: parseJson<Record<string, RecipeVideo>>(String(row.video_json), {}),
      provisionalMealDefinitions: parseJson<MealDefinition[]>(String(row.provisional_meals_json), []),
      usage:
        row.usage_input_tokens === null || row.usage_input_tokens === undefined
          ? null
          : {
              inputTokens: Number(row.usage_input_tokens),
              outputTokens: Number(row.usage_output_tokens ?? 0),
              model: String(row.usage_model ?? ""),
              ...(row.cost_status === "legacy"
                ? row.cost_usd
                  ? { costUsd: Number(row.cost_usd), costStatus: "legacy" as const }
                  : {}
                : { costUsd: row.cost_status === "reported" ? Number(row.cost_usd) : null }),
            },
      createdAt: String(row.version_created_at),
      allowNewFoodsSnapshot:
        row.allow_new_foods_snapshot === null || row.allow_new_foods_snapshot === undefined
          ? null
          : Number(row.allow_new_foods_snapshot) === 1,
    },
  }
}

/**
 * Production store over a Cloudflare D1 binding. Every operation is one atomic
 * `db.batch`; the partial unique index `idx_meal_plan_one_active` and the CAS
 * guards in the promotion SQL enforce the invariants described in the
 * iteration-1 plan §4.
 */
export function createMealPlanningStore(db: D1Database): MealPlanningStore {
  return {
    async claimDueMealCompletion(seen) {
      const cursor = await db
        .prepare("SELECT week_end, plan_id, revision FROM meal_plan_completion_cursor WHERE singleton = ?")
        .bind(1)
        .first<{ week_end: string; plan_id: string; revision: string }>()
      const excluded = [...seen]
      const exclude = excluded.length ? `AND p.plan_id NOT IN (${excluded.map(() => "?").join(",")})` : ""
      const select = `SELECT p.plan_id AS planId, p.chat_id AS chatId, p.week_end AS weekEnd
        FROM meal_plan p JOIN meal_plan_version v ON v.plan_id = p.plan_id AND v.version = p.current_version
        WHERE ${ELIGIBLE_FOR_COMPLETION} ${exclude}`
      const order = "ORDER BY p.week_end, p.plan_id LIMIT 1"
      const after = cursor
        ? await db
            .prepare(`${select} AND (p.week_end, p.plan_id) > (?, ?) ${order}`)
            .bind(...excluded, cursor.week_end, cursor.plan_id)
            .first<MealCompletionTarget>()
        : null
      const target =
        after ??
        (await db
          .prepare(`${select} ${order}`)
          .bind(...excluded)
          .first<MealCompletionTarget>())
      if (!target) return null
      const revision = crypto.randomUUID()
      const claim = cursor
        ? db
            .prepare(`UPDATE meal_plan_completion_cursor SET week_end = ?, plan_id = ?, revision = ?
                      WHERE singleton = 1 AND revision = ?`)
            .bind(target.weekEnd, target.planId, revision, cursor.revision)
        : db
            .prepare(`INSERT OR IGNORE INTO meal_plan_completion_cursor
                      (singleton, week_end, plan_id, revision) VALUES (1, ?, ?, ?)`)
            .bind(target.weekEnd, target.planId, revision)
      return (await claim.run()).meta.changes === 1 ? target : null
    },

    async completeEligibleMealPlan(target) {
      for (let retry = 0; retry < MAX_MEAL_COMPLETION_ATTEMPTS; retry++) {
        const row = await db
          .prepare(`${PLAN_WITH_VERSION_COLUMNS}, profile.profile_json ${PLAN_WITH_VERSION_FROM}
          JOIN meal_profile profile ON profile.chat_id = p.chat_id
          WHERE p.plan_id = ? AND p.chat_id = ? AND p.week_end = ? AND ${ELIGIBLE_FOR_COMPLETION}`)
          .bind(target.planId, target.chatId, target.weekEnd)
          .first()
        if (!row) return null
        const prior = String(row.profile_json)
        const profile = JSON.parse(prior) as MealProfile
        const record = mealPlanFromRow(row)
        // Completion must fail closed if evidence that excludes a dish is unreadable.
        record.plan.weeklyExceptions = decodeCompletionWeeklyExceptions(String(row.weekly_exceptions_json))
        record.plan.rejectedMealIds = decodeCompletionRejectedIds(String(row.rejected_meal_ids_json))
        const { additions, counts } = completionAdditions(record, profile)
        const attempt = crypto.randomUUID()
        const ledger = db
          .prepare(`
          INSERT INTO meal_plan_completion (plan_id, version, attempt_id, added_count, skipped_count, invalid_count, processed_at)
          SELECT p.plan_id, p.current_version, ?, ?, ?, ?, ${D1_NOW_ISO}
          FROM meal_plan p JOIN meal_plan_version v ON v.plan_id = p.plan_id AND v.version = p.current_version
          JOIN meal_profile profile ON profile.chat_id = p.chat_id
          WHERE p.plan_id = ? AND p.chat_id = ? AND p.week_end = ? AND p.current_version = ?
            AND p.weekly_exceptions_json = ? AND p.rejected_meal_ids_json = ?
            AND profile.profile_json = ? AND ${ELIGIBLE_FOR_COMPLETION}`)
          .bind(
            attempt,
            counts.added,
            counts.skipped,
            counts.invalid,
            target.planId,
            target.chatId,
            target.weekEnd,
            record.plan.currentVersion,
            row.weekly_exceptions_json,
            row.rejected_meal_ids_json,
            prior,
          )
        const statements = [ledger]
        if (additions.length) {
          const merged = { ...profile, mealDefinitions: [...(profile.mealDefinitions ?? []), ...additions] }
          statements.push(
            db
              .prepare(`
            UPDATE meal_profile SET profile_json = ?, updated_at = ${D1_NOW_ISO}, version = version + 1
            WHERE chat_id = ? AND EXISTS (SELECT 1 FROM meal_plan_completion WHERE plan_id = ? AND attempt_id = ?)`)
              .bind(JSON.stringify(merged), target.chatId, target.planId, attempt),
          )
        }
        const [result] = await db.batch(statements)
        if (result.meta.changes === 1) return counts
      }
      return null
    },

    async loadOrCreateProfile(chatId) {
      const now = nowIso()
      // Atomic insert-if-absent: `INSERT OR IGNORE` is one statement, so two
      // concurrent first requests for the same chat cannot both INSERT (one
      // no-ops); the row is always created exactly once, then read back.
      await db
        .prepare(
          `INSERT OR IGNORE INTO meal_profile (chat_id, profile_json, custom_policies_json, schedule_json,
                                               location_json, interaction_generation, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, 0, 1, ?, ?)`,
        )
        .bind(
          chatId,
          JSON.stringify(SEED_PROFILE),
          JSON.stringify(SEED_CUSTOM_POLICIES),
          JSON.stringify(SEED_SCHEDULE),
          now,
          now,
        )
        .run()
      const row = await db
        .prepare(
          `SELECT chat_id, profile_json, custom_policies_json, schedule_json, location_json,
                  interaction_generation, created_at, updated_at
           FROM meal_profile WHERE chat_id = ?`,
        )
        .bind(chatId)
        .first()
      const profile = parseJson<MealProfile>(String(row?.profile_json), SEED_PROFILE)
      const upgradedProfile = upgradeLegacyHalfDaySnackDefinitions(profile)
      const schedule = parseJson<MealSchedule>(String(row?.schedule_json), SEED_SCHEDULE)
      const upgradedSchedule = upgradeLegacyMealSchedule(schedule)
      if (upgradedProfile !== profile) {
        const normalized = await db
          .prepare(
            "UPDATE meal_profile SET profile_json = ?, updated_at = ?, version = version + 1 WHERE chat_id = ? AND profile_json = ?",
          )
          .bind(JSON.stringify(upgradedProfile), now, chatId, row?.profile_json)
          .run()
        if (normalized.meta.changes !== 1) return this.loadOrCreateProfile(chatId)
      }
      if (upgradedSchedule !== schedule) {
        await db
          .prepare("UPDATE meal_profile SET schedule_json = ?, updated_at = ? WHERE chat_id = ?")
          .bind(JSON.stringify(upgradedSchedule), now, chatId)
          .run()
      }
      return {
        chatId: String(row?.chat_id),
        profile: upgradedProfile,
        customPolicies: parseJson<CustomPolicy[]>(String(row?.custom_policies_json), []),
        schedule: upgradedSchedule,
        location: parseJson<StoredLocation | null>(String(row?.location_json), null),
        interactionGeneration: Number(row?.interaction_generation),
        createdAt: String(row?.created_at),
        updatedAt: String(row?.updated_at),
      }
    },

    async createActivePlan(input) {
      assertVersionCostIsValid(input.usage)
      const attemptId = crypto.randomUUID()
      const createdPlan =
        "SELECT plan_id, chat_id, created_at FROM meal_plan WHERE plan_id = ? AND write_attempt_id = ?"
      const proof = [input.planId, attemptId] as const
      const results = await db.batch<{
        created_at: string | null
        interaction_generation: number | null
        week_closed: number
        lease_valid: number
      }>([
        db
          .prepare(
            `INSERT INTO meal_plan (plan_id, chat_id, week_start, week_end, timezone, instance_id, status,
                                    current_version, weekly_inventory_json, weekly_exceptions_json,
                                    created_at, updated_at, write_attempt_id)
             SELECT ?, ?, ?, ?, ?, ?, 'replaced', 0, ?, ?, ${D1_NOW_ISO}, ${D1_NOW_ISO}, ?
             WHERE ? > ${D1_NOW_ISO}
               AND EXISTS (SELECT 1 FROM meal_profile WHERE chat_id = ?)
               AND EXISTS (SELECT 1 FROM meal_plan_generation
                           WHERE chat_id = ? AND generation_id = ? AND status = 'generating'
                             AND expires_at > ${D1_NOW_ISO})`,
          )
          .bind(
            input.planId,
            input.chatId,
            input.weekStart,
            input.weekEnd,
            input.timezone,
            input.instanceId,
            JSON.stringify(input.weeklyInventory),
            JSON.stringify(input.weeklyExceptions),
            attemptId,
            input.weekEnd,
            input.chatId,
            input.chatId,
            input.generationId,
          ),
        db
          .prepare(
            `INSERT INTO meal_plan_version (plan_id, version, candidate_json, evaluation_json, request_kind,
                                            base_version, feedback_batch_id, video_json, provisional_meals_json,
                                            usage_input_tokens, usage_output_tokens, usage_model,
                                            cost_usd, cost_status, allow_new_foods_snapshot, created_at)
             SELECT plan_id, 1, ?, ?, 'initial_plan', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, created_at
             FROM (${createdPlan})`,
          )
          .bind(
            JSON.stringify(input.candidate),
            JSON.stringify(input.evaluation),
            JSON.stringify(input.video ?? NO_VIDEOS),
            JSON.stringify(input.provisionalMealDefinitions ?? []),
            input.usage?.inputTokens ?? null,
            input.usage?.outputTokens ?? null,
            input.usage?.model ?? null,
            typeof input.usage?.costUsd === "number" ? input.usage.costUsd : null,
            input.usage?.costStatus ?? versionCostStatus(input.usage?.costUsd),
            input.allowNewFoodsSnapshot == null ? null : input.allowNewFoodsSnapshot ? 1 : 0,
            ...proof,
          ),
        // The staged row is private to this batch. Replace the prior active row before activating it.
        db
          .prepare(
            `UPDATE meal_plan SET status = 'replaced', replaced_at = created.created_at, updated_at = created.created_at
             FROM (${createdPlan}) AS created WHERE meal_plan.chat_id = created.chat_id AND meal_plan.status = 'active'`,
          )
          .bind(...proof),
        db
          .prepare(
            `UPDATE meal_plan SET status = 'active', current_version = 1, approved_version = 1
             WHERE plan_id = ? AND write_attempt_id = ?`,
          )
          .bind(...proof),
        db
          .prepare(
            `UPDATE meal_profile SET interaction_generation = interaction_generation + 1, updated_at = created.created_at
             FROM (${createdPlan}) AS created WHERE meal_profile.chat_id = created.chat_id`,
          )
          .bind(...proof),
        db
          .prepare(
            `DELETE FROM meal_plan_generation WHERE chat_id = ? AND generation_id = ?
               AND EXISTS (${createdPlan})`,
          )
          .bind(input.chatId, input.generationId, ...proof),
        db
          .prepare(
            `SELECT (SELECT created_at FROM (${createdPlan})) AS created_at,
                    (SELECT interaction_generation FROM meal_profile WHERE chat_id = ?) AS interaction_generation,
                    ? <= ${D1_NOW_ISO} AS week_closed,
                    EXISTS (SELECT 1 FROM meal_plan_generation
                            WHERE chat_id = ? AND generation_id = ? AND status = 'generating'
                              AND expires_at > ${D1_NOW_ISO}) AS lease_valid`,
          )
          .bind(...proof, input.chatId, input.weekEnd, input.chatId, input.generationId),
      ])
      const result = results[6].results[0]
      if (!result.created_at) {
        if (result.week_closed) throw new PlanWeekClosedError()
        if (!result.lease_valid) throw new Error(`generation lease missing or expired for chat ${input.chatId}`)
        throw new Error(`meal_profile row missing for chat ${input.chatId}`)
      }
      const createdAt = String(result.created_at)
      return {
        plan: makePlanRecord(input, createdAt),
        version: makeVersionRecord(
          input.planId,
          1,
          input.candidate,
          input.evaluation,
          "initial_plan",
          null,
          null,
          input.video ?? NO_VIDEOS,
          input.provisionalMealDefinitions ?? [],
          input.usage ?? null,
          createdAt,
          input.allowNewFoodsSnapshot ?? null,
        ),
        generation: Number(result.interaction_generation),
        previousReplaced: Number(results[2].meta.changes) >= 1,
      }
    },

    async promotePlanVersion(input) {
      assertVersionCostIsValid(input.usage)
      const newVersion = input.baseVersion + 1
      const batchId = input.feedbackBatch?.batchId ?? null
      const consumeExistingBatch = input.feedbackBatch?.consumeExisting === true
      const attemptId = crypto.randomUUID()
      const insertedVersion =
        "SELECT plan_id, version, created_at FROM meal_plan_version WHERE plan_id = ? AND version = ? AND write_attempt_id = ?"
      const proof = [input.planId, newVersion, attemptId] as const
      const profilePresent = await db.prepare("SELECT 1 FROM meal_profile WHERE chat_id = ?").bind(input.chatId).first()
      if (!profilePresent) throw new Error(`meal_profile row missing for chat ${input.chatId}`)

      // All effects use the successor from this attempt and its cutoff timestamp.
      // Checking the deadline again could split a successful insert from its dependent writes.
      const statements = [
        db
          .prepare(
            `INSERT INTO meal_plan_version (plan_id, version, candidate_json, evaluation_json, request_kind,
                                            base_version, feedback_batch_id, video_json, provisional_meals_json,
                                            usage_input_tokens, usage_output_tokens, usage_model,
                                            cost_usd, cost_status, allow_new_foods_snapshot, created_at, write_attempt_id)
             SELECT plan_id, ?, ?, ?, 'revision', current_version, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${D1_NOW_ISO}, ?
             FROM meal_plan
             WHERE plan_id = ? AND chat_id = ? AND current_version = ? AND status = 'active' AND week_end > ${D1_NOW_ISO}
               AND weekly_inventory_json = COALESCE(?, weekly_inventory_json)
               AND weekly_exceptions_json = COALESCE(?, weekly_exceptions_json)
               AND EXISTS (SELECT 1 FROM meal_profile WHERE chat_id = ?)
               AND (? = 0 OR EXISTS (SELECT 1 FROM feedback_batch
                                     WHERE batch_id = ? AND plan_id = meal_plan.plan_id
                                       AND chat_id = meal_plan.chat_id AND base_version = meal_plan.current_version
                                       AND status = 'processing'))`,
          )
          .bind(
            newVersion,
            JSON.stringify(input.candidate),
            JSON.stringify(input.evaluation),
            batchId,
            JSON.stringify(input.video ?? NO_VIDEOS),
            JSON.stringify(input.provisionalMealDefinitions ?? []),
            input.usage?.inputTokens ?? null,
            input.usage?.outputTokens ?? null,
            input.usage?.model ?? null,
            typeof input.usage?.costUsd === "number" ? input.usage.costUsd : null,
            input.usage?.costStatus ?? versionCostStatus(input.usage?.costUsd),
            input.allowNewFoodsSnapshot == null ? null : input.allowNewFoodsSnapshot ? 1 : 0,
            attemptId,
            input.planId,
            input.chatId,
            input.baseVersion,
            input.expectedWeekContext ? JSON.stringify(input.expectedWeekContext.weeklyInventory) : null,
            input.expectedWeekContext ? JSON.stringify(input.expectedWeekContext.weeklyExceptions) : null,
            input.chatId,
            consumeExistingBatch ? 1 : 0,
            batchId,
          ),
        db
          .prepare(
            `UPDATE meal_plan SET current_version = successor.version, approved_version = NULL, rejected_version = NULL,
                                  weekly_inventory_json = COALESCE(?, weekly_inventory_json),
                                  weekly_exceptions_json = COALESCE(?, weekly_exceptions_json),
                                  updated_at = successor.created_at
             FROM (${insertedVersion}) AS successor WHERE meal_plan.plan_id = successor.plan_id`,
          )
          .bind(
            input.inventory ? JSON.stringify(input.inventory.weeklyInventory) : null,
            input.inventory ? JSON.stringify(input.inventory.weeklyExceptions) : null,
            ...proof,
          ),
        db
          .prepare(
            `UPDATE meal_profile SET interaction_generation = interaction_generation + 1, updated_at = successor.created_at
             FROM (${insertedVersion}) AS successor WHERE chat_id = ?`,
          )
          .bind(...proof, input.chatId),
        db
          .prepare(
            `SELECT interaction_generation, (SELECT created_at FROM (${insertedVersion})) AS created_at
             FROM meal_profile WHERE chat_id = ?`,
          )
          .bind(...proof, input.chatId),
      ]
      if (input.feedbackBatch && consumeExistingBatch) {
        statements.push(
          db
            .prepare(
              `UPDATE feedback_batch SET status = 'consumed', updated_at = successor.created_at
               FROM (${insertedVersion}) AS successor WHERE batch_id = ?`,
            )
            .bind(...proof, batchId),
        )
      } else if (input.feedbackBatch) {
        statements.push(
          db
            .prepare(
              `INSERT OR IGNORE INTO feedback_batch (batch_id, plan_id, base_version, items_json, status, created_at, updated_at)
               SELECT ?, plan_id, ?, ?, 'consumed', created_at, created_at FROM (${insertedVersion})`,
            )
            .bind(batchId, input.baseVersion, JSON.stringify(input.feedbackBatch.items), ...proof),
        )
      }
      const results = await db.batch<{ created_at: string; interaction_generation: number }>(statements)
      if (Number(results[0].meta.changes) !== 1) return { ok: false as const, reason: "stale" as const }
      const result = results[3].results[0]
      return {
        ok: true as const,
        version: makeVersionRecord(
          input.planId,
          newVersion,
          input.candidate,
          input.evaluation,
          "revision",
          input.baseVersion,
          batchId,
          input.video ?? NO_VIDEOS,
          input.provisionalMealDefinitions ?? [],
          input.usage ?? null,
          String(result.created_at),
          input.allowNewFoodsSnapshot ?? null,
        ),
        generation: Number(result.interaction_generation),
      }
    },

    async decidePlanVersion(input) {
      const result = await db
        .prepare(
          `UPDATE meal_plan
         SET approved_version = ?, rejected_version = ?, updated_at = ${D1_NOW_ISO}
         WHERE plan_id = ? AND chat_id = ? AND status = 'active'
           AND current_version = ? AND week_end > ${D1_NOW_ISO}
           AND (? = 'reject' OR rejected_version IS NULL OR rejected_version != ?)`,
        )
        .bind(
          input.action === "accept" ? input.version : null,
          input.action === "reject" ? input.version : null,
          input.planId,
          input.chatId,
          input.version,
          input.action,
          input.version,
        )
        .run()
      return Number(result.meta.changes) === 1
    },

    async rejectPlanDishes(input) {
      const mealIds = [...new Set(input.mealIds.filter((id) => typeof id === "string" && id.length > 0))]
      if (!mealIds.length) return true
      for (let attempt = 0; attempt < MAX_MEAL_REJECTION_MERGE_ATTEMPTS; attempt++) {
        const row = await db
          .prepare(
            `SELECT p.rejected_meal_ids_json, v.provisional_meals_json FROM meal_plan p
           JOIN meal_plan_version v ON v.plan_id = p.plan_id AND v.version = p.current_version
           WHERE p.plan_id = ? AND p.chat_id = ? AND p.status = 'active'
             AND p.current_version = ? AND p.week_end > ${D1_NOW_ISO}`,
          )
          .bind(input.planId, input.chatId, input.version)
          .first()
        if (!row) return false
        const provisionalIds = new Set(
          parseJson<MealDefinition[]>(String(row.provisional_meals_json), [])
            .filter((definition) => definition.status === "provisional")
            .map((definition) => definition.id),
        )
        if (mealIds.some((id) => !provisionalIds.has(id))) return false
        const priorRaw = String(row.rejected_meal_ids_json)
        const prior = decodeCompletionRejectedIds(priorRaw)
        const next = JSON.stringify([...new Set([...prior, ...mealIds])])
        if (next === priorRaw) return true
        const result = await db
          .prepare(
            `UPDATE meal_plan SET rejected_meal_ids_json = ?, updated_at = ${D1_NOW_ISO}
           WHERE plan_id = ? AND chat_id = ? AND status = 'active' AND current_version = ?
             AND week_end > ${D1_NOW_ISO} AND rejected_meal_ids_json = ?`,
          )
          .bind(next, input.planId, input.chatId, input.version, priorRaw)
          .run()
        if (Number(result.meta.changes) === 1) return true
      }
      return false
    },

    async updateWeeklyContext(input) {
      const next = [JSON.stringify(input.weeklyInventory), JSON.stringify(input.weeklyExceptions)]
      const scope = [input.planId, input.chatId, input.baseVersion]
      const activeVersion = `plan_id = ? AND chat_id = ? AND current_version = ?
                             AND status = 'active' AND week_end > ${D1_NOW_ISO}`
      // A step may retry after its write commits. Confirm the intended state
      // without rewriting it, and require the same active version and cutoff.
      const [write, current] = await db.batch([
        db
          .prepare(
            `UPDATE meal_plan SET weekly_inventory_json = ?, weekly_exceptions_json = ?, updated_at = ${D1_NOW_ISO}
             WHERE ${activeVersion}
               AND weekly_inventory_json = COALESCE(?, weekly_inventory_json)
               AND weekly_exceptions_json = COALESCE(?, weekly_exceptions_json)
               AND (weekly_inventory_json != ? OR weekly_exceptions_json != ?)`,
          )
          .bind(
            ...next,
            ...scope,
            input.expectedWeekContext ? JSON.stringify(input.expectedWeekContext.weeklyInventory) : null,
            input.expectedWeekContext ? JSON.stringify(input.expectedWeekContext.weeklyExceptions) : null,
            ...next,
          ),
        db
          .prepare(
            `SELECT 1 FROM meal_plan WHERE ${activeVersion} AND weekly_inventory_json = ? AND weekly_exceptions_json = ?`,
          )
          .bind(...scope, ...next),
      ])
      return Number(write.meta.changes) === 1 || current.results.length === 1
        ? { ok: true as const }
        : { ok: false as const, reason: "stale" as const }
    },

    async startPlanGeneration(input) {
      const startedAt = input.startedAt ?? nowIso()
      await db
        .prepare(
          `INSERT INTO meal_plan_generation (chat_id, generation_id, status, started_at, expires_at, updated_at)
           VALUES (?, ?, 'generating', ?, ?, ?)
           ON CONFLICT(chat_id) DO UPDATE SET generation_id = excluded.generation_id,
             status = 'generating', started_at = excluded.started_at,
             expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
        )
        .bind(input.chatId, input.generationId, startedAt, input.expiresAt, startedAt)
        .run()
      return {
        chatId: input.chatId,
        generationId: input.generationId,
        status: "generating",
        startedAt,
        expiresAt: input.expiresAt,
        updatedAt: startedAt,
      }
    },

    async finishPlanGeneration(chatId, generationId, failed = false) {
      const now = nowIso()
      if (failed) {
        const result = await db
          .prepare(
            `UPDATE meal_plan_generation SET status = 'failed', expires_at = ?, updated_at = ?
             WHERE chat_id = ? AND generation_id = ?`,
          )
          .bind(now, now, chatId, generationId)
          .run()
        return Number(result.meta.changes) === 1
      }
      const result = await db
        .prepare("DELETE FROM meal_plan_generation WHERE chat_id = ? AND generation_id = ?")
        .bind(chatId, generationId)
        .run()
      return Number(result.meta.changes) === 1
    },

    async activePlanGeneration(chatId, now = nowIso()) {
      await db.prepare("DELETE FROM meal_plan_generation WHERE expires_at <= ?").bind(now).run()
      const row = await db
        .prepare(
          `SELECT chat_id, generation_id, status, started_at, expires_at, updated_at
           FROM meal_plan_generation
           WHERE chat_id = ? AND status = 'generating' AND expires_at > ?`,
        )
        .bind(chatId, now)
        .first()
      if (!row) return null
      return {
        chatId: String(row.chat_id),
        generationId: String(row.generation_id),
        status: String(row.status) as MealPlanGenerationStatus,
        startedAt: String(row.started_at),
        expiresAt: String(row.expires_at),
        updatedAt: String(row.updated_at),
      }
    },

    async activePlan(chatId) {
      const row = await db
        .prepare(
          `${PLAN_WITH_VERSION_SELECT}
           WHERE p.chat_id = ? AND p.status = 'active'`,
        )
        .bind(chatId)
        .first()
      if (!row) return null
      return mealPlanFromRow(row)
    },

    async latestPlanForWeek(chatId, weekStart) {
      const row = await db
        .prepare(
          `${PLAN_WITH_VERSION_SELECT}
           WHERE p.chat_id = ? AND p.week_start = ?
           ORDER BY p.created_at DESC, p.rowid DESC
           LIMIT 1`,
        )
        .bind(chatId, weekStart)
        .first()
      return row ? mealPlanFromRow(row) : null
    },

    async listPlanHistory(chatId) {
      const result = await db
        .prepare(
          `${PLAN_WITH_VERSION_SELECT}
           WHERE p.chat_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM meal_plan newer
               WHERE newer.chat_id = p.chat_id AND newer.week_start = p.week_start
                 AND (newer.created_at > p.created_at
                      OR (newer.created_at = p.created_at AND newer.rowid > p.rowid))
             )
           ORDER BY CASE WHEN p.status = 'active' THEN 0 ELSE 1 END,
                    p.updated_at DESC, p.created_at DESC, p.plan_id DESC
           LIMIT ?`,
        )
        .bind(chatId, MAX_MEAL_PLAN_HISTORY)
        .all()
      return (result.results ?? []).map((row) => mealPlanFromRow(row))
    },

    async planById(chatId, planId) {
      const row = await db
        .prepare(
          `${PLAN_WITH_VERSION_SELECT}
           WHERE p.chat_id = ? AND p.plan_id = ?`,
        )
        .bind(chatId, planId)
        .first()
      return row ? mealPlanFromRow(row) : null
    },
    async activePlanPointer(chatId) {
      const row = await db
        .prepare("SELECT instance_id, week_end FROM meal_plan WHERE chat_id = ? AND status = 'active' LIMIT 1")
        .bind(chatId)
        .first()
      if (!row) return null
      return { instanceId: String(row.instance_id), weekEnd: String(row.week_end) }
    },

    async sumPlanUsage(planId) {
      // Group by model so each version's tokens are priced at the rate of the
      // model that actually produced them; a plan revised after a model change
      // would otherwise price all history at the current version's rate.
      const result = await db
        .prepare(
          `SELECT usage_model AS model,
                  cost_status AS cost_status,
                  SUM(cost_usd) AS cost_usd,
                  COALESCE(SUM(usage_input_tokens), 0) AS input_tokens,
                  COALESCE(SUM(usage_output_tokens), 0) AS output_tokens
           FROM meal_plan_version
           WHERE plan_id = ? AND usage_input_tokens IS NOT NULL
           GROUP BY usage_model, cost_status
           ORDER BY usage_model, cost_status`,
        )
        .bind(planId)
        .all()
      const rows = result.results ?? []
      if (rows.length === 0) return null
      const byModel: VersionUsage[] = rows.map((row) => ({
        model: String(row.model ?? ""),
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
        ...(row.cost_status === "legacy"
          ? row.cost_usd
            ? { costUsd: Number(row.cost_usd), costStatus: "legacy" as const }
            : {}
          : { costUsd: row.cost_status === "reported" ? Number(row.cost_usd) : null }),
      }))
      return {
        inputTokens: byModel.reduce((sum, group) => sum + group.inputTokens, 0),
        outputTokens: byModel.reduce((sum, group) => sum + group.outputTokens, 0),
        byModel,
      }
    },

    async upsertMiniAppReviewContext(input) {
      const now = nowIso()
      const result = await db
        .prepare(
          `UPDATE meal_plan SET telegram_user_id = ?, updated_at = ?
           WHERE plan_id = ? AND chat_id = ? AND week_end = ?`,
        )
        .bind(input.telegramUserId, now, input.planId, input.chatId, input.weekEnd)
        .run()
      if (Number(result.meta.changes) !== 1) throw new Error("Mini App review context plan not found")
      return { ...input, createdAt: now, updatedAt: now }
    },

    async resolveMiniAppReviewContext(telegramUserId) {
      const row = await db
        .prepare(
          `SELECT telegram_user_id, chat_id, plan_id, week_end, created_at, updated_at
           FROM meal_plan WHERE telegram_user_id = ?
           ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END,
                    updated_at DESC LIMIT 1`,
        )
        .bind(telegramUserId)
        .first()
      if (!row) return null
      return {
        telegramUserId: String(row.telegram_user_id),
        chatId: String(row.chat_id),
        planId: String(row.plan_id),
        weekEnd: String(row.week_end),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      }
    },

    async createMiniAppSession(input) {
      const createdAt = input.createdAt ?? nowIso()
      await db
        .prepare(
          `INSERT INTO mini_app_session (session_id, token_hash, telegram_user_id, chat_id, plan_id, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.sessionId,
          input.tokenHash,
          input.telegramUserId,
          input.chatId,
          input.planId,
          input.expiresAt,
          createdAt,
        )
        .run()
      return { ...input, createdAt }
    },

    async readMiniAppSession(tokenHash, now) {
      await db.prepare("DELETE FROM mini_app_session WHERE expires_at <= ?").bind(now).run()
      const row = await db
        .prepare(
          `SELECT session_id, token_hash, telegram_user_id, chat_id, plan_id, expires_at, created_at
           FROM mini_app_session WHERE token_hash = ? AND expires_at > ?`,
        )
        .bind(tokenHash, now)
        .first()
      if (!row) return null
      return {
        sessionId: String(row.session_id),
        tokenHash: String(row.token_hash),
        telegramUserId: String(row.telegram_user_id),
        chatId: String(row.chat_id),
        planId: String(row.plan_id),
        expiresAt: String(row.expires_at),
        createdAt: String(row.created_at),
      }
    },

    async consumeMiniAppInitDataFingerprint(fingerprintHash, expiresAt, now) {
      const results = await db.batch([
        db.prepare("DELETE FROM mini_app_init_data_replay WHERE expires_at <= ?").bind(now),
        db
          .prepare(
            "INSERT OR IGNORE INTO mini_app_init_data_replay (fingerprint_hash, expires_at, created_at) VALUES (?, ?, ?)",
          )
          .bind(fingerprintHash, expiresAt, now),
      ])
      return Number((results[1] as { meta: { changes?: number } }).meta.changes) === 1
    },

    async acceptFeedbackBatch(input) {
      const now = nowIso()
      const planRow = await db
        .prepare(
          `SELECT v.candidate_json, profile.schedule_json
           FROM meal_plan p
           JOIN meal_plan_version v ON v.plan_id = p.plan_id AND v.version = p.current_version
           JOIN meal_profile profile ON profile.chat_id = p.chat_id
           WHERE p.plan_id = ? AND p.chat_id = ? AND p.instance_id = ? AND p.current_version = ? AND p.status = 'active'
             AND NOT EXISTS (SELECT 1 FROM meal_plan_generation g
                             WHERE g.chat_id = p.chat_id AND g.status = 'generating' AND g.expires_at > ?)`,
        )
        .bind(input.planId, input.chatId, input.workflowInstanceId, input.baseVersion, now)
        .first()
      if (!planRow) {
        if (await this.activePlanGeneration(input.chatId, now))
          return { ok: false as const, reason: "generating" as const }
        return { ok: false as const, reason: "stale" as const }
      }
      const items = normalizeMiniAppFeedbackItems(
        input.items,
        parseJson<MealPlanCandidate>(String(planRow.candidate_json), { grid: {}, easyBuys: [], policyOutcomes: {} }),
        parseJson<MealSchedule>(String(planRow.schedule_json), SEED_SCHEDULE),
      )
      if (!items) return { ok: false as const, reason: "invalid_items" as const }
      const itemsJson = JSON.stringify(items)
      await db
        .prepare(
          `INSERT OR IGNORE INTO feedback_batch
             (batch_id, plan_id, base_version, items_json, idempotency_key, status, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, 'accepted', ?, ? FROM meal_plan
           WHERE plan_id = ? AND chat_id = ? AND instance_id = ? AND current_version = ? AND status = 'active'
             AND NOT EXISTS (SELECT 1 FROM meal_plan_generation
                             WHERE chat_id = ? AND status = 'generating' AND expires_at > ?)`,
        )
        .bind(
          input.batchId,
          input.planId,
          input.baseVersion,
          itemsJson,
          input.idempotencyKey,
          now,
          now,
          input.planId,
          input.chatId,
          input.workflowInstanceId,
          input.baseVersion,
          input.chatId,
          now,
        )
        .run()
      const row = await db
        .prepare(
          `SELECT feedback_batch.*, meal_plan.chat_id, meal_plan.instance_id AS workflow_instance_id, meal_plan.week_end
           FROM feedback_batch
           LEFT JOIN meal_plan ON meal_plan.plan_id = feedback_batch.plan_id
           WHERE feedback_batch.plan_id = ? AND feedback_batch.idempotency_key = ?`,
        )
        .bind(input.planId, input.idempotencyKey)
        .first()
      if (!row) {
        if (await this.activePlanGeneration(input.chatId, now))
          return { ok: false as const, reason: "generating" as const }
        return { ok: false as const, reason: "stale" as const }
      }
      const batch = feedbackBatchFromRow(row)
      if (batch.baseVersion !== input.baseVersion || JSON.stringify(batch.items) !== itemsJson) {
        return { ok: false as const, reason: "idempotency_mismatch" as const }
      }
      return { ok: true as const, batch, duplicate: batch.batchId !== input.batchId }
    },

    async feedbackBatch(batchId) {
      const row = await db
        .prepare(
          `SELECT feedback_batch.*, meal_plan.chat_id, meal_plan.instance_id AS workflow_instance_id, meal_plan.week_end
           FROM feedback_batch
           LEFT JOIN meal_plan ON meal_plan.plan_id = feedback_batch.plan_id
           WHERE feedback_batch.batch_id = ?`,
        )
        .bind(batchId)
        .first()
      return row ? feedbackBatchFromRow(row) : null
    },

    async markFeedbackBatchDelivered(batchId) {
      const result = await db
        .prepare(
          "UPDATE feedback_batch SET status = 'delivered', updated_at = ? WHERE batch_id = ? AND status = 'accepted'",
        )
        .bind(nowIso(), batchId)
        .run()
      return Number(result.meta.changes) === 1
    },

    async claimFeedbackBatchForWorkflow(batchId, instanceId, now) {
      const results = await db.batch([
        db
          .prepare(
            `UPDATE feedback_batch SET status = 'processing', updated_at = ?
             WHERE batch_id = ? AND status = 'delivered'
               AND EXISTS (SELECT 1 FROM meal_plan WHERE plan_id = feedback_batch.plan_id
                           AND instance_id = ?
                           AND current_version = feedback_batch.base_version AND status = 'active')`,
          )
          .bind(now, batchId, instanceId),
        db
          .prepare(
            `UPDATE feedback_batch SET status = 'stale', updated_at = ?
             WHERE batch_id = ? AND status = 'delivered'
               AND EXISTS (SELECT 1 FROM meal_plan WHERE plan_id = feedback_batch.plan_id AND instance_id = ?)
               AND NOT EXISTS (SELECT 1 FROM meal_plan WHERE plan_id = feedback_batch.plan_id
                               AND instance_id = ? AND current_version = feedback_batch.base_version AND status = 'active')`,
          )
          .bind(now, batchId, instanceId, instanceId),
      ])
      if (Number(results[0]?.meta.changes) !== 1) return null
      const row = await db
        .prepare(
          `SELECT feedback_batch.*, meal_plan.chat_id, meal_plan.instance_id AS workflow_instance_id, meal_plan.week_end
           FROM feedback_batch
           LEFT JOIN meal_plan ON meal_plan.plan_id = feedback_batch.plan_id
           WHERE feedback_batch.batch_id = ? AND feedback_batch.status = 'processing'`,
        )
        .bind(batchId)
        .first()
      return row ? feedbackBatchFromRow(row) : null
    },

    async markFeedbackBatchStale(batchId, now) {
      const result = await db
        .prepare(
          "UPDATE feedback_batch SET status = 'stale', updated_at = ? WHERE batch_id = ? AND status = 'processing'",
        )
        .bind(now, batchId)
        .run()
      return Number(result.meta.changes) === 1
    },

    async markFeedbackBatchConsumed(batchId, now) {
      const result = await db
        .prepare(
          "UPDATE feedback_batch SET status = 'consumed', updated_at = ? WHERE batch_id = ? AND status = 'processing'",
        )
        .bind(now, batchId)
        .run()
      return Number(result.meta.changes) === 1
    },

    async markFeedbackBatchFailed(batchId, category, now) {
      const result = await db
        .prepare(
          `UPDATE feedback_batch SET status = 'failed', failure_category = ?, updated_at = ?
           WHERE batch_id = ? AND status IN ('accepted', 'delivered', 'processing')`,
        )
        .bind(category, now, batchId)
        .run()
      return Number(result.meta.changes) === 1
    },

    async claimFeedbackBatchFailureNotification(batchId, now) {
      const result = await db
        .prepare(
          "UPDATE feedback_batch SET failure_notified_at = ? WHERE batch_id = ? AND status IN ('failed', 'stale') AND failure_notified_at IS NULL",
        )
        .bind(now, batchId)
        .run()
      return Number(result.meta.changes) === 1
    },
  }
}

/**
 * In-memory store for unit/integration tests. Enforces the same invariants as
 * the D1 implementation (one active plan per chat, insert-only versions,
 * CAS-guarded promotion that changes nothing on stale, immutable submission
 * batches linked to versions) without SQL. `backing` is shared across
 * instances; `failNextOn` injects a single-shot mid-batch failure.
 */
export function createInMemoryMealPlanningStore(options: InMemoryMealPlanningStoreOptions = {}): MealPlanningStore {
  const backing: InMemoryMealPlanningBacking = options.backing ?? {
    profiles: new Map(),
    plans: new Map(),
    versions: new Map(),
    batches: new Map(),
    reviewContexts: new Map(),
    sessions: new Map(),
    initDataFingerprints: new Map(),
    generations: new Map(),
  }
  // Older test backings predate Mini App state. Initializing their absent maps
  // here preserves the restart-simulation contract without weakening it.
  if (!backing.reviewContexts) backing.reviewContexts = new Map()
  if (!backing.sessions) backing.sessions = new Map()
  if (!backing.initDataFingerprints) backing.initDataFingerprints = new Map()
  if (!backing.generations) backing.generations = new Map()
  const reviewContexts = backing.reviewContexts
  const sessions = backing.sessions
  const initDataFingerprints = backing.initDataFingerprints
  const generations = backing.generations as Map<string, MealPlanGenerationRecord>

  function throwIfFailing(operation: "createActivePlan" | "promotePlanVersion"): void {
    if (options.failNextOn === operation) {
      options.failNextOn = undefined
      throw new Error(`injected batch failure: ${operation}`)
    }
  }

  function activePlanForChat(chatId: string): MealPlanRecord | undefined {
    for (const plan of backing.plans.values()) {
      if (plan.chatId === chatId && plan.status === "active") return plan
    }
    return undefined
  }

  backing.completedPlans ??= new Set()
  const completed = backing.completedPlans

  /** Checks latest-plan ordering and the same historical evidence as the D1 authorizing write. */
  function eligiblePlan(plan: MealPlanRecord): ActivePlanRecord | null {
    const version = backing.versions.get(versionKey(plan.planId, plan.currentVersion))
    if (
      !version ||
      completed.has(plan.planId) ||
      plan.weekEnd > nowIso() ||
      plan.createdAt >= plan.weekEnd ||
      version.createdAt >= plan.weekEnd ||
      (plan.status !== "active" && !(plan.replacedAt && plan.replacedAt > plan.weekEnd)) ||
      plan.approvedVersion !== plan.currentVersion ||
      plan.rejectedVersion === plan.currentVersion ||
      version.allowNewFoodsSnapshot !== true
    )
      return null

    let latest: MealPlanRecord | undefined
    for (const entry of backing.plans.values()) {
      if (entry.chatId !== plan.chatId || entry.weekStart !== plan.weekStart) continue
      if (!latest || entry.createdAt >= latest.createdAt) latest = entry
    }
    return latest === plan ? { plan, version } : null
  }

  return {
    async claimDueMealCompletion(seen) {
      const due = [...backing.plans.values()]
        .filter((plan) => !seen.has(plan.planId) && eligiblePlan(plan))
        .sort((a, b) => (a.weekEnd === b.weekEnd ? (a.planId < b.planId ? -1 : 1) : a.weekEnd < b.weekEnd ? -1 : 1))
      const cursor = backing.completionCursor
      const plan =
        (cursor &&
          due.find(
            (row) => row.weekEnd > cursor.weekEnd || (row.weekEnd === cursor.weekEnd && row.planId > cursor.planId),
          )) ??
        due[0]
      if (!plan) return null
      const { planId, chatId, weekEnd } = plan
      const target = { planId, chatId, weekEnd }
      backing.completionCursor = target
      return target
    },

    async completeEligibleMealPlan(target) {
      const plan = backing.plans.get(target.planId)
      if (!plan || plan.chatId !== target.chatId || plan.weekEnd !== target.weekEnd) return null
      const record = eligiblePlan(plan)
      const profile = backing.profiles.get(target.chatId)
      if (!record || !profile) return null
      const weeklyExceptions = decodeCompletionWeeklyExceptions(JSON.stringify(plan.weeklyExceptions))
      const { additions, counts } = completionAdditions(
        { ...record, plan: { ...plan, weeklyExceptions } },
        profile.profile,
      )
      if (additions.length) {
        profile.profile = {
          ...profile.profile,
          mealDefinitions: [...(profile.profile.mealDefinitions ?? []), ...structuredClone(additions)],
        }
        profile.updatedAt = nowIso()
      }
      completed.add(target.planId)
      return counts
    },

    async loadOrCreateProfile(chatId) {
      const existing = backing.profiles.get(chatId)
      if (existing) {
        const upgradedProfile = upgradeLegacyHalfDaySnackDefinitions(existing.profile)
        const upgradedSchedule = upgradeLegacyMealSchedule(existing.schedule)
        if (upgradedProfile !== existing.profile) {
          existing.profile = upgradedProfile
          existing.updatedAt = nowIso()
        }
        if (upgradedSchedule !== existing.schedule) {
          existing.schedule = upgradedSchedule
          existing.updatedAt = nowIso()
        }
        return existing
      }
      const now = nowIso()
      const profile: StoredMealProfile = {
        chatId,
        profile: SEED_PROFILE,
        customPolicies: SEED_CUSTOM_POLICIES,
        schedule: SEED_SCHEDULE,
        location: null,
        interactionGeneration: 0,
        createdAt: now,
        updatedAt: now,
      }
      backing.profiles.set(chatId, profile)
      return profile
    },

    async createActivePlan(input) {
      assertVersionCostIsValid(input.usage)
      throwIfFailing("createActivePlan")
      const now = nowIso()
      if (input.weekEnd <= now) throw new PlanWeekClosedError()
      const profile = backing.profiles.get(input.chatId)
      if (!profile) throw new Error(`meal_profile row missing for chat ${input.chatId}`)
      const generation = generations.get(input.chatId)
      if (
        !generation ||
        generation.generationId !== input.generationId ||
        generation.status !== "generating" ||
        generation.expiresAt <= now
      ) {
        if (generation && generation.expiresAt <= now) generations.delete(input.chatId)
        throw new Error(`generation lease missing or expired for chat ${input.chatId}`)
      }
      const previous = activePlanForChat(input.chatId)
      if (previous) {
        previous.status = "replaced"
        previous.replacedAt = now
        previous.updatedAt = now
      }
      const plan = makePlanRecord(input, now)
      backing.plans.set(input.planId, structuredClone(plan))
      const version = makeVersionRecord(
        input.planId,
        1,
        input.candidate,
        input.evaluation,
        "initial_plan",
        null,
        null,
        input.video ?? NO_VIDEOS,
        input.provisionalMealDefinitions ?? [],
        input.usage ?? null,
        now,
        input.allowNewFoodsSnapshot ?? null,
      )
      backing.versions.set(versionKey(input.planId, 1), structuredClone(version))
      profile.interactionGeneration += 1
      profile.updatedAt = now
      generations.delete(input.chatId)
      return { plan, version, generation: profile.interactionGeneration, previousReplaced: previous !== undefined }
    },

    async promotePlanVersion(input) {
      assertVersionCostIsValid(input.usage)
      throwIfFailing("promotePlanVersion")
      const plan = backing.plans.get(input.planId)
      const now = nowIso()
      const stale =
        plan?.status !== "active" ||
        plan.chatId !== input.chatId ||
        plan.currentVersion !== input.baseVersion ||
        !matchesWeekContext(plan, input.expectedWeekContext) ||
        plan.weekEnd <= now
      if (stale) return { ok: false as const, reason: "stale" as const }
      const profile = backing.profiles.get(input.chatId)
      if (!profile) throw new Error(`meal_profile row missing for chat ${input.chatId}`)
      const existingBatch = input.feedbackBatch?.consumeExisting
        ? backing.batches.get(input.feedbackBatch.batchId)
        : undefined
      if (
        input.feedbackBatch?.consumeExisting &&
        (existingBatch?.status !== "processing" ||
          existingBatch.planId !== input.planId ||
          existingBatch.baseVersion !== input.baseVersion ||
          existingBatch.chatId !== input.chatId)
      ) {
        return { ok: false as const, reason: "stale" as const }
      }
      const newVersion = input.baseVersion + 1
      const version = makeVersionRecord(
        input.planId,
        newVersion,
        input.candidate,
        input.evaluation,
        "revision",
        input.baseVersion,
        input.feedbackBatch?.batchId ?? null,
        input.video ?? NO_VIDEOS,
        input.provisionalMealDefinitions ?? [],
        input.usage ?? null,
        now,
        input.allowNewFoodsSnapshot ?? null,
      )
      backing.versions.set(versionKey(input.planId, newVersion), structuredClone(version))
      if (input.inventory) {
        plan.weeklyInventory = structuredClone(input.inventory.weeklyInventory)
        plan.weeklyExceptions = structuredClone(input.inventory.weeklyExceptions)
        plan.updatedAt = now
      }
      plan.currentVersion = newVersion
      plan.approvedVersion = null
      plan.rejectedVersion = null
      plan.updatedAt = now
      if (input.feedbackBatch) {
        const batchId = input.feedbackBatch.batchId
        if (!backing.batches.has(batchId)) {
          backing.batches.set(batchId, {
            batchId,
            planId: input.planId,
            baseVersion: input.baseVersion,
            items: input.feedbackBatch.items,
            chatId: null,
            workflowInstanceId: null,
            weekEnd: null,
            idempotencyKey: null,
            status: "consumed",
            failureCategory: null,
            failureNotifiedAt: null,
            acceptedAt: null,
            deliveredAt: null,
            processingAt: null,
            consumedAt: now,
            staleAt: null,
            failedAt: null,
            createdAt: now,
          })
        }
        if (existingBatch) {
          existingBatch.status = "consumed"
          existingBatch.consumedAt = now
        }
      }
      profile.interactionGeneration += 1
      profile.updatedAt = now
      return { ok: true as const, version, generation: profile.interactionGeneration }
    },

    async decidePlanVersion(input) {
      const now = nowIso()
      const plan = backing.plans.get(input.planId)
      if (
        !plan ||
        plan.chatId !== input.chatId ||
        plan.status !== "active" ||
        plan.currentVersion !== input.version ||
        plan.weekEnd <= now
      )
        return false
      if (input.action === "accept") {
        if (plan.rejectedVersion === input.version) return false
        plan.approvedVersion = input.version
        plan.updatedAt = now
      } else {
        plan.approvedVersion = null
        plan.rejectedVersion = input.version
        plan.updatedAt = now
      }
      return true
    },

    async rejectPlanDishes(input) {
      const now = nowIso()
      const plan = backing.plans.get(input.planId)
      const version = backing.versions.get(versionKey(input.planId, input.version))
      if (
        !plan ||
        !version ||
        plan.chatId !== input.chatId ||
        plan.status !== "active" ||
        plan.currentVersion !== input.version ||
        plan.weekEnd <= now
      )
        return false
      const provisionalIds = new Set(
        version.provisionalMealDefinitions
          .filter((definition) => definition.status === "provisional")
          .map((definition) => definition.id),
      )
      if (input.mealIds.some((id) => !provisionalIds.has(id))) return false
      plan.rejectedMealIds = [...new Set([...plan.rejectedMealIds, ...input.mealIds.filter(Boolean)])]
      plan.updatedAt = now
      return true
    },

    async updateWeeklyContext(input) {
      const plan = backing.plans.get(input.planId)
      const stale =
        plan?.status !== "active" ||
        plan.chatId !== input.chatId ||
        plan.currentVersion !== input.baseVersion ||
        plan.weekEnd <= nowIso()
      if (stale) return { ok: false as const, reason: "stale" as const }
      if (matchesWeekContext(plan, input)) return { ok: true as const }
      if (!matchesWeekContext(plan, input.expectedWeekContext)) return { ok: false as const, reason: "stale" as const }
      plan.weeklyInventory = structuredClone(input.weeklyInventory)
      plan.weeklyExceptions = structuredClone(input.weeklyExceptions)
      plan.updatedAt = nowIso()
      return { ok: true as const }
    },

    async startPlanGeneration(input) {
      const startedAt = input.startedAt ?? nowIso()
      const record: MealPlanGenerationRecord = {
        chatId: input.chatId,
        generationId: input.generationId,
        status: "generating",
        startedAt,
        expiresAt: input.expiresAt,
        updatedAt: startedAt,
      }
      generations.set(input.chatId, record)
      return record
    },

    async finishPlanGeneration(chatId, generationId, failed = false) {
      const record = generations.get(chatId)
      if (!record || record.generationId !== generationId) return false
      if (failed) {
        const now = nowIso()
        record.status = "failed"
        record.expiresAt = now
        record.updatedAt = now
      } else {
        generations.delete(chatId)
      }
      return true
    },

    async activePlanGeneration(chatId, now = nowIso()) {
      const record = generations.get(chatId)
      if (!record) return null
      if (record.expiresAt <= now || record.status !== "generating") {
        generations.delete(chatId)
        return null
      }
      return record
    },

    async activePlan(chatId) {
      const plan = activePlanForChat(chatId)
      if (!plan) return null
      const version = backing.versions.get(versionKey(plan.planId, plan.currentVersion))
      if (!version) return null
      return structuredClone({ plan, version })
    },

    async latestPlanForWeek(chatId, weekStart) {
      let plan: MealPlanRecord | undefined
      for (const candidate of backing.plans.values()) {
        if (candidate.chatId !== chatId || candidate.weekStart !== weekStart) continue
        if (!plan || candidate.createdAt >= plan.createdAt) plan = candidate
      }
      if (!plan) return null
      const version = backing.versions.get(versionKey(plan.planId, plan.currentVersion))
      return version ? structuredClone({ plan, version }) : null
    },

    async listPlanHistory(chatId) {
      const latestByWeek = new Map<string, MealPlanRecord>()
      for (const plan of backing.plans.values()) {
        if (plan.chatId !== chatId) continue
        const current = latestByWeek.get(plan.weekStart)
        if (!current || plan.createdAt >= current.createdAt) {
          latestByWeek.set(plan.weekStart, plan)
        }
      }
      return [...latestByWeek.values()]
        .sort(
          (left, right) =>
            Number(left.status !== "active") - Number(right.status !== "active") ||
            right.updatedAt.localeCompare(left.updatedAt) ||
            right.createdAt.localeCompare(left.createdAt) ||
            right.planId.localeCompare(left.planId),
        )
        .slice(0, MAX_MEAL_PLAN_HISTORY)
        .flatMap((plan) => {
          const version = backing.versions.get(versionKey(plan.planId, plan.currentVersion))
          return version ? [structuredClone({ plan, version })] : []
        })
    },

    async planById(chatId, planId) {
      const plan = backing.plans.get(planId)
      if (!plan || plan.chatId !== chatId) return null
      const version = backing.versions.get(versionKey(plan.planId, plan.currentVersion))
      return version ? structuredClone({ plan, version }) : null
    },

    async activePlanPointer(chatId) {
      const plan = activePlanForChat(chatId)
      if (!plan) return null
      return { instanceId: plan.instanceId, weekEnd: plan.weekEnd }
    },

    async sumPlanUsage(planId) {
      const records = [...backing.versions.values()].filter(
        (record) => record.planId === planId && record.usage !== null,
      )
      if (records.length === 0) return null
      const byModel = new Map<string, VersionUsage>()
      for (const record of records) {
        const usage = record.usage as VersionUsage
        const status = usage.costStatus ?? versionCostStatus(usage.costUsd)
        const key = `${usage.model}\u0000${status}`
        const existing = byModel.get(key)
        if (existing) {
          existing.inputTokens += usage.inputTokens
          existing.outputTokens += usage.outputTokens
          if (status !== "unavailable" && usage.costUsd !== undefined) {
            existing.costUsd = Number(existing.costUsd ?? 0) + Number(usage.costUsd)
            if (status === "legacy") existing.costStatus = "legacy"
          }
        } else {
          byModel.set(key, {
            model: usage.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
            ...(status === "legacy" && usage.costUsd !== undefined ? { costStatus: "legacy" as const } : {}),
          })
        }
      }
      const groups = [...byModel.values()].sort((a, b) =>
        a.model === b.model ? String(a.costUsd).localeCompare(String(b.costUsd)) : a.model.localeCompare(b.model),
      )
      return {
        inputTokens: groups.reduce((sum, group) => sum + group.inputTokens, 0),
        outputTokens: groups.reduce((sum, group) => sum + group.outputTokens, 0),
        byModel: groups,
      }
    },

    async upsertMiniAppReviewContext(input) {
      const now = nowIso()
      const key = `${input.telegramUserId}:${input.chatId}`
      const existing = reviewContexts.get(key)
      const context: MiniAppReviewContext = { ...input, createdAt: existing?.createdAt ?? now, updatedAt: now }
      reviewContexts.set(key, context)
      return context
    },

    async resolveMiniAppReviewContext(telegramUserId) {
      const matches = [...reviewContexts.values()]
        .filter((context) => context.telegramUserId === telegramUserId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      return matches[0] ?? null
    },

    async createMiniAppSession(input) {
      const session: MiniAppSessionRecord = { ...input, createdAt: input.createdAt ?? nowIso() }
      sessions.set(session.tokenHash, session)
      return session
    },

    async readMiniAppSession(tokenHash, now) {
      for (const [key, session] of sessions) if (session.expiresAt <= now) sessions.delete(key)
      return sessions.get(tokenHash) ?? null
    },

    async consumeMiniAppInitDataFingerprint(fingerprintHash, expiresAt, now) {
      for (const [key, expiry] of initDataFingerprints) if (expiry <= now) initDataFingerprints.delete(key)
      if (initDataFingerprints.has(fingerprintHash)) return false
      initDataFingerprints.set(fingerprintHash, expiresAt)
      return true
    },

    async acceptFeedbackBatch(input) {
      if (await this.activePlanGeneration(input.chatId)) return { ok: false as const, reason: "generating" as const }
      const plan = backing.plans.get(input.planId)
      if (
        plan?.status !== "active" ||
        plan.chatId !== input.chatId ||
        plan.instanceId !== input.workflowInstanceId ||
        plan.currentVersion !== input.baseVersion
      ) {
        return { ok: false as const, reason: "stale" as const }
      }
      const version = backing.versions.get(versionKey(plan.planId, plan.currentVersion))
      const profile = backing.profiles.get(plan.chatId)
      if (!version || !profile) return { ok: false as const, reason: "stale" as const }
      const items = normalizeMiniAppFeedbackItems(input.items, version.candidate, profile.schedule)
      if (!items) return { ok: false as const, reason: "invalid_items" as const }
      const existing = [...backing.batches.values()].find(
        (batch) => batch.planId === input.planId && batch.idempotencyKey === input.idempotencyKey,
      )
      if (existing) {
        if (existing.baseVersion !== input.baseVersion || JSON.stringify(existing.items) !== JSON.stringify(items)) {
          return { ok: false as const, reason: "idempotency_mismatch" as const }
        }
        return { ok: true as const, batch: existing, duplicate: true }
      }
      const existingBatchId = backing.batches.get(input.batchId)
      if (existingBatchId) return { ok: false as const, reason: "stale" as const }
      const now = nowIso()
      const batch: FeedbackBatchRecord = {
        batchId: input.batchId,
        planId: input.planId,
        baseVersion: input.baseVersion,
        items,
        chatId: input.chatId,
        workflowInstanceId: input.workflowInstanceId,
        weekEnd: plan.weekEnd,
        idempotencyKey: input.idempotencyKey,
        status: "accepted",
        failureCategory: null,
        failureNotifiedAt: null,
        acceptedAt: now,
        deliveredAt: null,
        processingAt: null,
        consumedAt: null,
        staleAt: null,
        failedAt: null,
        createdAt: now,
      }
      backing.batches.set(batch.batchId, batch)
      return { ok: true as const, batch, duplicate: false }
    },

    async feedbackBatch(batchId) {
      return backing.batches.get(batchId) ?? null
    },

    async markFeedbackBatchDelivered(batchId) {
      const batch = backing.batches.get(batchId)
      if (batch?.status !== "accepted") return false
      batch.status = "delivered"
      batch.deliveredAt = nowIso()
      return true
    },

    async claimFeedbackBatchForWorkflow(batchId, instanceId, now) {
      const batch = backing.batches.get(batchId)
      if (!batch || batch.workflowInstanceId !== instanceId || batch.status !== "delivered") return null
      const plan = backing.plans.get(batch.planId)
      if (
        plan?.status !== "active" ||
        plan.chatId !== batch.chatId ||
        plan.instanceId !== instanceId ||
        plan.currentVersion !== batch.baseVersion
      ) {
        batch.status = "stale"
        batch.staleAt = now
        return null
      }
      batch.status = "processing"
      batch.processingAt = now
      return batch
    },

    async markFeedbackBatchStale(batchId, now) {
      const batch = backing.batches.get(batchId)
      if (batch?.status !== "processing") return false
      batch.status = "stale"
      batch.staleAt = now
      return true
    },

    async markFeedbackBatchConsumed(batchId, now) {
      const batch = backing.batches.get(batchId)
      if (batch?.status !== "processing") return false
      batch.status = "consumed"
      batch.consumedAt = now
      return true
    },

    async markFeedbackBatchFailed(batchId, category, now) {
      const batch = backing.batches.get(batchId)
      if (!batch || !["accepted", "delivered", "processing"].includes(batch.status)) return false
      batch.status = "failed"
      batch.failureCategory = category
      batch.failedAt = now
      return true
    },

    async claimFeedbackBatchFailureNotification(batchId, now) {
      const batch = backing.batches.get(batchId)
      if (!batch || !["failed", "stale"].includes(batch.status) || batch.failureNotifiedAt) return false
      batch.failureNotifiedAt = now
      return true
    },
  }
}
