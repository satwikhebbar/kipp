import type {
  CustomPolicy,
  FeedbackItem,
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
  createdAt: string
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
  createdAt: string
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
  candidate: MealPlanCandidate
  evaluation: MealPlanEvaluation
  weeklyInventory: WeeklyInventory
  weeklyExceptions: WeeklyExceptions
  video?: Record<string, RecipeVideo>
  provisionalMealDefinitions?: MealDefinition[]
}

/** Result of a committed initial-plan batch. */
export interface CreateActivePlanResult {
  plan: MealPlanRecord
  version: MealPlanVersionRecord
  generation: number
  /** True when a previous active plan was superseded by this create (the parent gets a "previous plan replaced" notice). */
  previousReplaced: boolean
}

/** One immutable submission batch written atomically with the revision it drives. */
export interface FeedbackBatchInput {
  batchId: string
  items: FeedbackItem[]
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
  /** The submission that drove this revision; omit (or null) only defensively — every revision is submission-driven. */
  feedbackBatch?: FeedbackBatchInput | null
}

export interface UpdateWeeklyContextInput {
  planId: string
  chatId: string
  baseVersion: number
  weeklyInventory: WeeklyInventory
  weeklyExceptions: WeeklyExceptions
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

/** The typed meal-planning store surface. The D1 and in-memory implementations share the same invariants. */
export interface MealPlanningStore {
  loadOrCreateProfile(chatId: string): Promise<StoredMealProfile>
  createActivePlan(input: CreateActivePlanInput): Promise<CreateActivePlanResult>
  promotePlanVersion(input: PromotePlanVersionInput): Promise<PromotePlanVersionResult>
  /** Updates only week-scoped inventory/calendar facts; it never creates a plan version. */
  updateWeeklyContext(input: UpdateWeeklyContextInput): Promise<UpdateWeeklyContextResult>
  activePlan(chatId: string): Promise<ActivePlanRecord | null>
  /** Reads the active plan's live instance pointer (whether or not its week has ended). */
  activePlanPointer(chatId: string): Promise<ActivePlanPointer | null>
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
}

/** Options for the in-memory store; `failNextOn` is a single-shot test hook that simulates a mid-batch statement failure. */
export interface InMemoryMealPlanningStoreOptions {
  backing?: InMemoryMealPlanningBacking
  failNextOn?: "createActivePlan" | "promotePlanVersion"
}

export const SEED_SCHEDULE: MealSchedule = {
  days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  slots: [
    { id: "breakfast", name: "Breakfast", packed: false, dry: false, maxCookMinutes: null },
    { id: "snack1", name: "Snack 1", packed: true, dry: true, maxCookMinutes: 0 },
    { id: "snack2", name: "Snack 2", packed: true, dry: true, maxCookMinutes: 0 },
    { id: "school-lunch", name: "School lunch", packed: true, dry: false, maxCookMinutes: null },
    { id: "home-lunch", name: "Home lunch", packed: false, dry: false, maxCookMinutes: null },
  ],
}

const SEED_MEAL_INGREDIENTS: Record<string, string[]> = {
  paratha: ["wheat flour"],
  banana: ["banana"],
  "roasted chana": ["chana"],
  "bottle gourd dal": ["bottle gourd", "moong dal"],
  "rice and beans": ["rice", "beans"],
  poha: ["poha"],
  apple: ["apple"],
  dates: ["dates"],
  rajma: ["kidney beans"],
  "quinoa bowl": ["quinoa"],
  idli: ["idli batter"],
  orange: ["orange"],
  "mixed seeds": ["mixed seeds"],
  khichdi: ["rice", "moong dal"],
  "sweet potato curry": ["sweet potato"],
  upma: ["upma rava"],
  pear: ["pear"],
  "dry coconut": ["dry coconut"],
  chole: ["chickpeas"],
  "ghee rice": ["rice", "ghee"],
  dosa: ["dosa batter"],
  pomegranate: ["pomegranate"],
  "jaggery cubes": ["jaggery"],
  "paneer paratha": ["wheat flour", "paneer"],
  "masala oats": ["oats"],
}

const SEED_DRY_SNACKS = new Set([
  "banana",
  "roasted chana",
  "apple",
  "dates",
  "orange",
  "mixed seeds",
  "pear",
  "dry coconut",
  "pomegranate",
  "jaggery cubes",
])
const SEED_COOKED_MEAL_MINUTES = 20

const SEED_MEAL_SLOTS: Record<string, string[]> = {
  paratha: ["breakfast", "school-lunch", "home-lunch"],
  banana: ["snack1", "snack2"],
  "roasted chana": ["snack1", "snack2"],
  "bottle gourd dal": ["school-lunch", "home-lunch"],
  "rice and beans": ["school-lunch", "home-lunch"],
  poha: ["breakfast", "school-lunch", "home-lunch"],
  apple: ["snack1", "snack2"],
  dates: ["snack1", "snack2"],
  rajma: ["school-lunch", "home-lunch"],
  "quinoa bowl": ["school-lunch", "home-lunch"],
  idli: ["breakfast", "school-lunch", "home-lunch"],
  orange: ["snack1", "snack2"],
  "mixed seeds": ["snack1", "snack2"],
  khichdi: ["school-lunch", "home-lunch"],
  "sweet potato curry": ["school-lunch", "home-lunch"],
  upma: ["breakfast", "school-lunch", "home-lunch"],
  pear: ["snack1", "snack2"],
  "dry coconut": ["snack1", "snack2"],
  chole: ["school-lunch", "home-lunch"],
  "ghee rice": ["school-lunch", "home-lunch"],
  dosa: ["breakfast", "school-lunch", "home-lunch"],
  pomegranate: ["snack1", "snack2"],
  "jaggery cubes": ["snack1", "snack2"],
  "paneer paratha": ["breakfast", "school-lunch", "home-lunch"],
  "masala oats": ["breakfast", "home-lunch"],
}

/** Fixed opaque ids for the development catalog; names are deliberately not encoded in ids. */
export const SEED_MEAL_IDS: Record<string, string> = {
  paratha: "meal_01j1f0a7q2e6m3z8",
  banana: "meal_01j1f0b4w9k2r6x5",
  "roasted chana": "meal_01j1f0c8n4v7p2s6",
  "bottle gourd dal": "meal_01j1f0d3h8t5y9a1",
  "rice and beans": "meal_01j1f0e6c2m8q4w7",
  poha: "meal_01j1f0f9r5x3k7n2",
  apple: "meal_01j1f0g2v8p4s6h9",
  dates: "meal_01j1f0h7m3z9e5q1",
  rajma: "meal_01j1f0j4k8n2w6x3",
  "quinoa bowl": "meal_01j1f0k9p5s7h3v8",
  idli: "meal_01j1f0m2q6w4y8r5",
  orange: "meal_01j1f0n8x3c7m9z2",
  "mixed seeds": "meal_01j1f0p5h9v2k6n4",
  khichdi: "meal_01j1f0q1s7e3x8w6",
  "sweet potato curry": "meal_01j1f0r6m2z5p9h3",
  upma: "meal_01j1f0s4k8n6v2q7",
  pear: "meal_01j1f0t9w3x7m5z1",
  "dry coconut": "meal_01j1f0v2h6p4s8k9",
  chole: "meal_01j1f0w7n3q9x5m2",
  "ghee rice": "meal_01j1f0x5p8v2h6s4",
  dosa: "meal_01j1f0y1k7m4z9q3",
  pomegranate: "meal_01j1f0z8x2w6n5v7",
  "jaggery cubes": "meal_01j1f101h9s3p8k5",
  "paneer paratha": "meal_01j1f102m6q4x7z2",
  "masala oats": "meal_01j1f103v5n8h2s6",
}

export const SEED_PROFILE: MealProfile = {
  dietaryExclusions: ["peanut", "egg"],
  dishRepertoire: [
    "paratha",
    "banana",
    "roasted chana",
    "bottle gourd dal",
    "rice and beans",
    "poha",
    "apple",
    "dates",
    "rajma",
    "quinoa bowl",
    "idli",
    "orange",
    "mixed seeds",
    "khichdi",
    "sweet potato curry",
    "upma",
    "pear",
    "dry coconut",
    "chole",
    "ghee rice",
    "dosa",
    "pomegranate",
    "jaggery cubes",
    "paneer paratha",
    "masala oats",
  ],
  mealDefinitions: [
    "paratha",
    "banana",
    "roasted chana",
    "bottle gourd dal",
    "rice and beans",
    "poha",
    "apple",
    "dates",
    "rajma",
    "quinoa bowl",
    "idli",
    "orange",
    "mixed seeds",
    "khichdi",
    "sweet potato curry",
    "upma",
    "pear",
    "dry coconut",
    "chole",
    "ghee rice",
    "dosa",
    "pomegranate",
    "jaggery cubes",
    "paneer paratha",
    "masala oats",
  ].map(
    (name): MealDefinition => ({
      id: SEED_MEAL_IDS[name]!,
      name,
      aliases: [name],
      principalIngredients: SEED_MEAL_INGREDIENTS[name] ?? [name],
      vegetarian: true,
      suitableSlots: SEED_MEAL_SLOTS[name] ?? ["home-lunch"],
      // Parent-provided repertoire meals are trusted as packable. Dry classification is deliberately conservative.
      packedFood: { suitable: true, dry: SEED_DRY_SNACKS.has(name) },
      typicalCookMinutes: SEED_DRY_SNACKS.has(name) ? 0 : SEED_COOKED_MEAL_MINUTES,
      priorNightPrep: name === "rajma" ? "required" : "none",
      requiredIngredients: SEED_MEAL_INGREDIENTS[name] ?? [name],
      optionalIngredients: [],
      status: "established",
    }),
  ),
  foodPreferences: { favourites: ["paratha"], avoid: [] },
  allowNewFoods: false,
  sensoryGuidelines: [],
  morningCookingBudgetMinutes: 35,
  priorNightPrepAllowed: false,
  pantryBaseline: ["rice", "wheat flour", "oil", "spices", "moong dal", "ghee"],
}

/** The initial household configuration per spec §5.11 (Snack policy, Equipment gap, Packing capacity, two Nutrition targets). */
const SEED_CUSTOM_POLICIES: CustomPolicy[] = [
  {
    id: "snack-policy",
    label: "Snack policy",
    scope: "persistent",
    value: "School snacks should usually be dry, quick to pack, and not cooked that morning.",
  },
  { id: "equipment-gap", label: "Equipment gap", scope: "persistent", value: '["microwave oven"]' },
  {
    id: "packing-capacity",
    label: "Packing capacity",
    scope: "persistent",
    value: "Use at most two lunchbox compartments; avoid leak-prone items.",
  },
  {
    id: "nutrition-target-fruit",
    label: "Nutrition target",
    scope: "persistent",
    value: "Pack fruit in a snack at least three to four times each week.",
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

/** Stable map key for a (plan, version) pair. */
function versionKey(planId: string, version: number): string {
  return `${planId}:${version}`
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
  now: string,
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
    createdAt: now,
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
      return {
        chatId: String(row?.chat_id),
        profile: parseJson<MealProfile>(String(row?.profile_json), SEED_PROFILE),
        customPolicies: parseJson<CustomPolicy[]>(String(row?.custom_policies_json), []),
        schedule: parseJson<MealSchedule>(String(row?.schedule_json), SEED_SCHEDULE),
        location: parseJson<StoredLocation | null>(String(row?.location_json), null),
        interactionGeneration: Number(row?.interaction_generation),
        createdAt: String(row?.created_at),
        updatedAt: String(row?.updated_at),
      }
    },

    async createActivePlan(input) {
      const now = nowIso()
      // Every mutating statement is guarded on the profile row existing, so a
      // missing profile (a programming error — the workflow always calls
      // loadOrCreateProfile first) makes the whole batch write nothing: the
      // supersede no-ops (a prior active plan stays active), the plan/version
      // inserts no-op, and the zero-row generation bump turns the batch into
      // an atomic failure instead of a committed plan with `generation: NaN`.
      const results = await db.batch([
        db
          .prepare(
            `UPDATE meal_plan SET status = 'replaced', updated_at = ?
             WHERE chat_id = ? AND status = 'active'
               AND EXISTS (SELECT 1 FROM meal_profile WHERE chat_id = ?)`,
          )
          .bind(now, input.chatId, input.chatId),
        db
          .prepare(
            `INSERT INTO meal_plan (plan_id, chat_id, week_start, week_end, timezone, instance_id, status,
                                    current_version, weekly_inventory_json, weekly_exceptions_json,
                                    created_at, updated_at)
             SELECT ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM meal_profile WHERE chat_id = ?)`,
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
            now,
            now,
            input.chatId,
          ),
        db
          .prepare(
            `INSERT INTO meal_plan_version (plan_id, version, candidate_json, evaluation_json, request_kind,
                                            base_version, feedback_batch_id, video_json, provisional_meals_json, created_at)
             SELECT ?, 1, ?, ?, 'initial_plan', NULL, NULL, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM meal_profile WHERE chat_id = ?)`,
          )
          .bind(
            input.planId,
            JSON.stringify(input.candidate),
            JSON.stringify(input.evaluation),
            JSON.stringify(input.video ?? NO_VIDEOS),
            JSON.stringify(input.provisionalMealDefinitions ?? []),
            now,
            input.chatId,
          ),
        db
          .prepare(
            "UPDATE meal_profile SET interaction_generation = interaction_generation + 1, updated_at = ? WHERE chat_id = ?",
          )
          .bind(now, input.chatId),
        db.prepare("SELECT interaction_generation FROM meal_profile WHERE chat_id = ?").bind(input.chatId),
      ])
      const generationChanged = Number((results[3] as { meta: { changes?: number } }).meta.changes) === 1
      if (!generationChanged) {
        throw new Error(`meal_profile row missing for chat ${input.chatId}`)
      }
      const previousReplaced = Number((results[0] as { meta: { changes?: number } }).meta.changes) >= 1
      const generation = Number(
        (results[4] as { results?: Array<{ interaction_generation?: number }> }).results?.[0]?.interaction_generation,
      )
      return {
        plan: makePlanRecord(input, now),
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
          now,
        ),
        generation,
        previousReplaced,
      }
    },

    async promotePlanVersion(input) {
      const now = nowIso()
      const newVersion = input.baseVersion + 1
      const batchId = input.feedbackBatch?.batchId ?? null
      // The missing-profile precondition is checked before the batch commits:
      // a missing profile throws with nothing written rather than surfacing as
      // a misleading "stale" (the profile row is never deleted, so the check
      // cannot race the batch; every mutating statement below is additionally
      // guarded on the profile existing, so even a hypothetical mid-batch
      // absence no-ops the whole transaction).
      const profilePresent = await db.prepare("SELECT 1 FROM meal_profile WHERE chat_id = ?").bind(input.chatId).first()
      if (!profilePresent) {
        throw new Error(`meal_profile row missing for chat ${input.chatId}`)
      }
      const statements = [
        db
          .prepare(
            `INSERT INTO meal_plan_version (plan_id, version, candidate_json, evaluation_json, request_kind,
                                            base_version, feedback_batch_id, video_json, provisional_meals_json, created_at)
             SELECT ?, ?, ?, ?, 'revision', ?, ?, ?, ?, ? FROM meal_plan
             WHERE plan_id = ? AND chat_id = ? AND current_version = ? AND status = 'active'
               AND EXISTS (SELECT 1 FROM meal_profile WHERE chat_id = ?)`,
          )
          .bind(
            input.planId,
            newVersion,
            JSON.stringify(input.candidate),
            JSON.stringify(input.evaluation),
            input.baseVersion,
            batchId,
            JSON.stringify(input.video ?? NO_VIDEOS),
            JSON.stringify(input.provisionalMealDefinitions ?? []),
            now,
            input.planId,
            input.chatId,
            input.baseVersion,
            input.chatId,
          ),
        db
          .prepare(
            `UPDATE meal_profile SET interaction_generation = interaction_generation + 1, updated_at = ?
             WHERE chat_id = ? AND EXISTS (SELECT 1 FROM meal_plan
                                           WHERE plan_id = ? AND chat_id = ? AND current_version = ? AND status = 'active')`,
          )
          .bind(now, input.chatId, input.planId, input.chatId, input.baseVersion),
        db.prepare("SELECT interaction_generation FROM meal_profile WHERE chat_id = ?").bind(input.chatId),
      ]
      if (input.inventory) {
        statements.push(
          db
            .prepare(
              `UPDATE meal_plan SET weekly_inventory_json = ?, weekly_exceptions_json = ?, updated_at = ?
               WHERE plan_id = ? AND chat_id = ? AND current_version = ? AND status = 'active'
                 AND EXISTS (SELECT 1 FROM meal_profile WHERE chat_id = ?)`,
            )
            .bind(
              JSON.stringify(input.inventory.weeklyInventory),
              JSON.stringify(input.inventory.weeklyExceptions),
              now,
              input.planId,
              input.chatId,
              input.baseVersion,
              input.chatId,
            ),
        )
      }
      statements.push(
        db
          .prepare(
            `UPDATE meal_plan SET current_version = ?, updated_at = ?
             WHERE plan_id = ? AND chat_id = ? AND current_version = ? AND status = 'active'
               AND EXISTS (SELECT 1 FROM meal_profile WHERE chat_id = ?)`,
          )
          .bind(newVersion, now, input.planId, input.chatId, input.baseVersion, input.chatId),
        db
          .prepare(
            `INSERT OR IGNORE INTO feedback_batch (batch_id, plan_id, base_version, items_json, created_at)
             SELECT ?, plan_id, ?, ?, ? FROM meal_plan
             WHERE plan_id = ? AND chat_id = ? AND current_version = ? AND status = 'active' AND ? IS NOT NULL
               AND EXISTS (SELECT 1 FROM meal_profile WHERE chat_id = ?)`,
          )
          .bind(
            batchId,
            input.baseVersion,
            JSON.stringify(input.feedbackBatch?.items ?? []),
            now,
            input.planId,
            input.chatId,
            newVersion,
            batchId,
            input.chatId,
          ),
      )
      const results = await db.batch(statements)
      const promoted = Number((results[0] as { meta: { changes?: number } }).meta.changes) === 1
      if (!promoted) return { ok: false as const, reason: "stale" as const }
      const generation = Number(
        (results[2] as { results?: Array<{ interaction_generation?: number }> }).results?.[0]?.interaction_generation,
      )
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
          now,
        ),
        generation,
      }
    },

    async updateWeeklyContext(input) {
      const now = nowIso()
      const result = await db
        .prepare(
          `UPDATE meal_plan SET weekly_inventory_json = ?, weekly_exceptions_json = ?, updated_at = ?
           WHERE plan_id = ? AND chat_id = ? AND current_version = ? AND status = 'active'`,
        )
        .bind(
          JSON.stringify(input.weeklyInventory),
          JSON.stringify(input.weeklyExceptions),
          now,
          input.planId,
          input.chatId,
          input.baseVersion,
        )
        .run()
      return Number(result.meta.changes) === 1
        ? { ok: true as const }
        : { ok: false as const, reason: "stale" as const }
    },

    async activePlan(chatId) {
      const row = await db
        .prepare(
          `SELECT p.plan_id, p.chat_id, p.week_start, p.week_end, p.timezone, p.instance_id, p.status,
                  p.current_version, p.weekly_inventory_json, p.weekly_exceptions_json, p.created_at, p.updated_at,
                  v.version, v.candidate_json, v.evaluation_json, v.request_kind, v.base_version,
                  v.feedback_batch_id, v.video_json, v.provisional_meals_json, v.created_at AS version_created_at
           FROM meal_plan p
           JOIN meal_plan_version v ON v.plan_id = p.plan_id AND v.version = p.current_version
           WHERE p.chat_id = ? AND p.status = 'active'`,
        )
        .bind(chatId)
        .first()
      if (!row) return null
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
          createdAt: String(row.version_created_at),
        },
      }
    },
    async activePlanPointer(chatId) {
      const row = await db
        .prepare("SELECT instance_id, week_end FROM meal_plan WHERE chat_id = ? AND status = 'active' LIMIT 1")
        .bind(chatId)
        .first()
      if (!row) return null
      return { instanceId: String(row.instance_id), weekEnd: String(row.week_end) }
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
  }

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

  return {
    async loadOrCreateProfile(chatId) {
      const existing = backing.profiles.get(chatId)
      if (existing) return existing
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
      throwIfFailing("createActivePlan")
      const profile = backing.profiles.get(input.chatId)
      if (!profile) throw new Error(`meal_profile row missing for chat ${input.chatId}`)
      const now = nowIso()
      const previous = activePlanForChat(input.chatId)
      if (previous) {
        previous.status = "replaced"
        previous.updatedAt = now
      }
      const plan = makePlanRecord(input, now)
      backing.plans.set(input.planId, plan)
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
        now,
      )
      backing.versions.set(versionKey(input.planId, 1), version)
      profile.interactionGeneration += 1
      profile.updatedAt = now
      return { plan, version, generation: profile.interactionGeneration, previousReplaced: previous !== undefined }
    },

    async promotePlanVersion(input) {
      throwIfFailing("promotePlanVersion")
      const plan = backing.plans.get(input.planId)
      const stale =
        plan?.status !== "active" || plan.chatId !== input.chatId || plan.currentVersion !== input.baseVersion
      if (stale) return { ok: false as const, reason: "stale" as const }
      const profile = backing.profiles.get(input.chatId)
      if (!profile) throw new Error(`meal_profile row missing for chat ${input.chatId}`)
      const now = nowIso()
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
        now,
      )
      backing.versions.set(versionKey(input.planId, newVersion), version)
      if (input.inventory) {
        plan.weeklyInventory = input.inventory.weeklyInventory
        plan.weeklyExceptions = input.inventory.weeklyExceptions
        plan.updatedAt = now
      }
      plan.currentVersion = newVersion
      plan.updatedAt = now
      if (input.feedbackBatch) {
        const batchId = input.feedbackBatch.batchId
        if (!backing.batches.has(batchId)) {
          backing.batches.set(batchId, {
            batchId,
            planId: input.planId,
            baseVersion: input.baseVersion,
            items: input.feedbackBatch.items,
            createdAt: now,
          })
        }
      }
      profile.interactionGeneration += 1
      profile.updatedAt = now
      return { ok: true as const, version, generation: profile.interactionGeneration }
    },

    async updateWeeklyContext(input) {
      const plan = backing.plans.get(input.planId)
      const stale =
        plan?.status !== "active" || plan.chatId !== input.chatId || plan.currentVersion !== input.baseVersion
      if (stale) return { ok: false as const, reason: "stale" as const }
      plan.weeklyInventory = input.weeklyInventory
      plan.weeklyExceptions = input.weeklyExceptions
      plan.updatedAt = nowIso()
      return { ok: true as const }
    },

    async activePlan(chatId) {
      const plan = activePlanForChat(chatId)
      if (!plan) return null
      const version = backing.versions.get(versionKey(plan.planId, plan.currentVersion))
      if (!version) return null
      return { plan, version }
    },

    async activePlanPointer(chatId) {
      const plan = activePlanForChat(chatId)
      if (!plan) return null
      return { instanceId: plan.instanceId, weekEnd: plan.weekEnd }
    },
  }
}
