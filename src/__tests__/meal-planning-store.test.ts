import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  type CreateActivePlanInput,
  createInMemoryMealPlanningStore,
  createMealPlanningStore,
  type InMemoryMealPlanningBacking,
  MAX_MEAL_PLAN_HISTORY,
  type MealPlanningStore,
  type PromotePlanVersionInput,
  SEED_PROFILE,
  upgradeLegacyHalfDaySnackDefinitions,
} from "../meal-planning/store"
import type { MealPlanCandidate, MealPlanEvaluation } from "../meal-planning/types"
import { createD1TestDb, d1Count, d1Scalar } from "./d1-test-db"

const CHAT = "chat-1"
const WEEKS = { weekStart: "2026-09-07T00:00:00.000Z", weekEnd: "2026-09-12T23:59:59.000Z" }

function candidate(grid = {}): MealPlanCandidate {
  return { grid, easyBuys: [], policyOutcomes: { "snack-policy": { outcome: "satisfied", rationale: "dry snacks" } } }
}

function evaluation(): MealPlanEvaluation {
  return {
    pass: true,
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
  }
}

function createInput(overrides: Partial<CreateActivePlanInput> = {}): CreateActivePlanInput {
  return {
    planId: "plan-1",
    chatId: CHAT,
    ...WEEKS,
    timezone: "Asia/Kolkata",
    instanceId: "instance-1",
    generationId: "generation-1",
    candidate: candidate(),
    evaluation: evaluation(),
    weeklyInventory: { items: [], notes: [] },
    weeklyExceptions: { items: [] },
    ...overrides,
  }
}

function promoteInput(overrides: Partial<PromotePlanVersionInput> = {}): PromotePlanVersionInput {
  return {
    planId: "plan-1",
    chatId: CHAT,
    baseVersion: 1,
    candidate: candidate({
      Mon: { breakfast: { dish: "poha", vegetarian: true, items: ["poha"], cookMinutes: 10, priorNightPrep: false } },
    }),
    evaluation: evaluation(),
    ...overrides,
  }
}

/** Creates a store with the chat's profile row present, matching the workflow's load-before-plan ordering (§6 step 1). */
async function newStore(backing?: InMemoryMealPlanningBacking): Promise<MealPlanningStore> {
  const store = createInMemoryMealPlanningStore(backing ? { backing } : {})
  await store.loadOrCreateProfile(CHAT)
  return store
}

async function createPlan(store: MealPlanningStore, input: CreateActivePlanInput) {
  await store.startPlanGeneration({
    chatId: input.chatId,
    generationId: input.generationId,
    expiresAt: "2999-01-01T00:00:00.000Z",
  })
  return store.createActivePlan(input)
}

describe("createInMemoryMealPlanningStore", () => {
  it("upgrades legacy built-in cooked snacks to the explicit half-day capability", () => {
    const legacy = {
      ...SEED_PROFILE,
      mealDefinitions: (SEED_PROFILE.mealDefinitions ?? []).map((definition) =>
        definition.name === "dosa"
          ? { ...definition, halfDaySnack: undefined, packedFood: { suitable: true, dry: false } }
          : definition,
      ),
    }
    const upgraded = upgradeLegacyHalfDaySnackDefinitions(legacy)
    expect(upgraded).not.toBe(legacy)
    expect(upgraded.mealDefinitions?.find((definition) => definition.name === "dosa")).toMatchObject({
      halfDaySnack: true,
      packedFood: { suitable: true, dry: true },
    })
  })

  it("seeds the initial household profile on first use and never reseeds", async () => {
    const store = createInMemoryMealPlanningStore()
    const profile = await store.loadOrCreateProfile(CHAT)
    expect(profile.chatId).toBe(CHAT)
    expect(profile.interactionGeneration).toBe(0)
    expect(profile.profile.dishRepertoire.length).toBeGreaterThan(0)
    expect(profile.customPolicies.map((policy) => policy.id)).toEqual([
      "snack-policy",
      "ingredient-naming",
      "relevant-variety",
      "nutrition-target-fruit",
      "nutrition-target-nuts",
      "school-rule",
      "cheat-day",
    ])
    expect(profile.schedule.days).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"])
    expect(profile.schedule.slots).toHaveLength(5)
    expect(profile.location).toBeNull()

    const again = await store.loadOrCreateProfile(CHAT)
    expect(again.profile).toBe(profile.profile)
    expect(again.interactionGeneration).toBe(0)
  })

  it("createActivePlan writes the plan, version 1, and generation 1; previousReplaced is false for the first plan", async () => {
    const store = await newStore()
    const result = await createPlan(store, createInput())
    expect(result.previousReplaced).toBe(false)
    expect(result.generation).toBe(1)
    expect(result.plan.planId).toBe("plan-1")
    expect(result.plan.status).toBe("active")
    expect(result.plan.currentVersion).toBe(1)
    expect(result.plan.instanceId).toBe("instance-1")
    expect(result.plan.weekEnd).toBe(WEEKS.weekEnd)
    expect(result.version.version).toBe(1)
    expect(result.version.requestKind).toBe("initial_plan")
    expect(result.version.baseVersion).toBeNull()
    expect(result.version.feedbackBatchId).toBeNull()

    const active = await store.activePlan(CHAT)
    expect(active?.plan.planId).toBe("plan-1")
    expect(active?.version.version).toBe(1)
  })

  it("a second create supersedes the first (serialize-and-supersede), bumping the generation exactly once per plan message", async () => {
    const store = await newStore()
    await createPlan(store, createInput())
    const second = await createPlan(store, createInput({ planId: "plan-2", instanceId: "instance-2" }))
    expect(second.previousReplaced).toBe(true)
    expect(second.generation).toBe(2)

    const active = await store.activePlan(CHAT)
    expect(active?.plan.planId).toBe("plan-2")
    expect(active?.plan.instanceId).toBe("instance-2")

    // The superseded plan is no longer promotable (feedback about it is discarded with it).
    const stale = await store.promotePlanVersion(promoteInput({ planId: "plan-1", baseVersion: 1 }))
    expect(stale).toEqual({ ok: false, reason: "stale" })

    // A different chat's first plan starts its own generation at 1.
    await store.loadOrCreateProfile("chat-2")
    const other = await createPlan(store, createInput({ planId: "plan-3", chatId: "chat-2" }))
    expect(other.generation).toBe(1)
  })

  it("a next-week create replaces the prior week's inventory and exceptions (weekly state does not leak)", async () => {
    const store = await newStore()
    await createPlan(
      store,
      createInput({ weeklyInventory: { items: [{ name: "poha", status: "available" as const }], notes: [] } }),
    )
    const next = await createPlan(
      store,
      createInput({
        planId: "plan-2",
        weekStart: "2026-09-14T00:00:00.000Z",
        weekEnd: "2026-09-19T23:59:59.000Z",
        weeklyInventory: { items: [], notes: [] },
      }),
    )
    expect(next.previousReplaced).toBe(true)
    const active = await store.activePlan(CHAT)
    expect(active?.plan.planId).toBe("plan-2")
    expect(active?.plan.weeklyInventory.items).toEqual([])
  })

  it("promotePlanVersion commits a revision: version N+1, current_version advance, generation bump, and the immutable submission batch linked from the new version", async () => {
    const store = await newStore()
    await createPlan(store, createInput())

    const inventory = {
      weeklyInventory: { items: [{ name: "poha", status: "available" as const }], notes: ["picked up poha"] },
      weeklyExceptions: { items: [] },
    }
    const batch = { batchId: "plan-1:v2", items: [{ id: "tg-42", text: "Tue lunch: less oily" }] }
    const result = await store.promotePlanVersion(promoteInput({ inventory, feedbackBatch: batch }))
    expect(result).toMatchObject({ ok: true, generation: 2 })
    if (!result.ok) return
    expect(result.version.version).toBe(2)
    expect(result.version.requestKind).toBe("revision")
    expect(result.version.baseVersion).toBe(1)
    expect(result.version.feedbackBatchId).toBe("plan-1:v2")

    const active = await store.activePlan(CHAT)
    expect(active?.plan.currentVersion).toBe(2)
    expect(active?.version.feedbackBatchId).toBe("plan-1:v2")
    expect(active?.plan.weeklyInventory.notes).toEqual(["picked up poha"])
  })

  it("persists per-version usage and sums it across the plan (cost tracking)", async () => {
    const store = await newStore()
    await createPlan(
      store,
      createInput({ usage: { inputTokens: 100, outputTokens: 20, model: "openai/gpt-5.6-luna" } }),
    )
    expect(await store.sumPlanUsage("plan-1")).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      byModel: [{ inputTokens: 100, outputTokens: 20, model: "openai/gpt-5.6-luna" }],
    })

    const promoted = await store.promotePlanVersion(
      promoteInput({ usage: { inputTokens: 40, outputTokens: 5, model: "openai/gpt-5.6-luna" } }),
    )
    expect(promoted.ok).toBe(true)
    expect(await store.sumPlanUsage("plan-1")).toEqual({
      inputTokens: 140,
      outputTokens: 25,
      byModel: [{ inputTokens: 140, outputTokens: 25, model: "openai/gpt-5.6-luna" }],
    })
    const active = await store.activePlan(CHAT)
    expect(active?.version.usage).toEqual({ inputTokens: 40, outputTokens: 5, model: "openai/gpt-5.6-luna" })
  })

  it("sumPlanUsage groups tokens by model so each version is priced at its own rate", async () => {
    const store = await newStore()
    await createPlan(
      store,
      createInput({ usage: { inputTokens: 100, outputTokens: 20, model: "openai/gpt-5.6-luna" } }),
    )
    await store.promotePlanVersion(
      promoteInput({ usage: { inputTokens: 40, outputTokens: 5, model: "deepseek-v4-flash" } }),
    )
    expect(await store.sumPlanUsage("plan-1")).toEqual({
      inputTokens: 140,
      outputTokens: 25,
      byModel: [
        { inputTokens: 40, outputTokens: 5, model: "deepseek-v4-flash" },
        { inputTokens: 100, outputTokens: 20, model: "openai/gpt-5.6-luna" },
      ],
    })
  })

  it("sumPlanUsage returns null and versions hydrate null usage when none recorded it (legacy rows)", async () => {
    const store = await newStore()
    await createPlan(store, createInput())
    await store.promotePlanVersion(promoteInput())
    expect(await store.sumPlanUsage("plan-1")).toBeNull()
    expect((await store.activePlan(CHAT))?.version.usage).toBeNull()
  })

  it("a stale promote changes nothing: no version row, generation unmoved, current_version unmoved, inventory unmoved, no feedback batch row", async () => {
    const store = await newStore()
    await createPlan(store, createInput({ weeklyInventory: { items: [], notes: ["original"] } }))
    const first = await store.promotePlanVersion(promoteInput())
    expect(first.ok).toBe(true)

    // Second call bases on version 1 again — the current version is already 2.
    const stale = await store.promotePlanVersion(
      promoteInput({
        baseVersion: 1,
        candidate: candidate({
          Tue: {
            breakfast: {
              dish: "dosa",
              vegetarian: true,
              items: ["rice", "urad dal"],
              cookMinutes: 15,
              priorNightPrep: false,
            },
          },
        }),
        inventory: {
          weeklyInventory: { items: [{ name: "dosa", status: "available" as const }], notes: ["stale write"] },
          weeklyExceptions: { items: [] },
        },
        feedbackBatch: { batchId: "plan-1:v2", items: [{ id: "tg-99", text: "should not land" }] },
      }),
    )
    expect(stale).toEqual({ ok: false, reason: "stale" })

    const active = await store.activePlan(CHAT)
    expect(active?.plan.currentVersion).toBe(2)
    expect(active?.plan.weeklyInventory.notes).toEqual(["original"])
    expect(active?.plan.weeklyExceptions.items).toEqual([])
    expect(active?.version.version).toBe(2)
    // Generation was bumped only by the successful promotion (create → 1, first promote → 2).
    const profile = await store.loadOrCreateProfile(CHAT)
    expect(profile.interactionGeneration).toBe(2)
  })

  it("a stale-base race (the winner already committed a newer version) resolves stale and leaves no extra version", async () => {
    const store = await newStore()
    await createPlan(store, createInput())
    const winner = await store.promotePlanVersion(
      promoteInput({ feedbackBatch: { batchId: "plan-1:v2", items: [{ id: "tg-1", text: "ok" }] } }),
    )
    expect(winner.ok).toBe(true)

    // Loser runs after the winner with the same base and the same computed newVersion.
    const loser = await store.promotePlanVersion(
      promoteInput({ feedbackBatch: { batchId: "plan-1:v2", items: [{ id: "tg-2", text: "late" }] } }),
    )
    expect(loser).toEqual({ ok: false, reason: "stale" })

    const active = await store.activePlan(CHAT)
    expect(active?.plan.currentVersion).toBe(2)
    expect(active?.version.version).toBe(2)
    const profile = await store.loadOrCreateProfile(CHAT)
    expect(profile.interactionGeneration).toBe(2)
  })

  it("a cross-chat promotion (plan A id + chat B) is stale and changes neither plan nor either generation", async () => {
    const store = createInMemoryMealPlanningStore()
    await store.loadOrCreateProfile(CHAT)
    await store.loadOrCreateProfile("chat-2")
    await createPlan(store, createInput())

    const cross = await store.promotePlanVersion(promoteInput({ chatId: "chat-2" }))
    expect(cross).toEqual({ ok: false, reason: "stale" })

    const active = await store.activePlan(CHAT)
    expect(active?.plan.currentVersion).toBe(1)
    expect(active?.version.version).toBe(1)
    expect((await store.loadOrCreateProfile(CHAT)).interactionGeneration).toBe(1)
    expect((await store.loadOrCreateProfile("chat-2")).interactionGeneration).toBe(0)
  })

  it("an injected batch failure rolls back the whole create: no new plan, previous active stays, generation unmoved", async () => {
    const backing: InMemoryMealPlanningBacking = {
      profiles: new Map(),
      plans: new Map(),
      versions: new Map(),
      batches: new Map(),
    }
    const store = await newStore(backing)
    await createPlan(store, createInput())

    const failing = createInMemoryMealPlanningStore({ backing, failNextOn: "createActivePlan" })
    await expect(createPlan(failing, createInput({ planId: "plan-2", instanceId: "instance-2" }))).rejects.toThrow(
      "injected batch failure",
    )

    const active = await failing.activePlan(CHAT)
    expect(active?.plan.planId).toBe("plan-1")
    expect(active?.version.version).toBe(1)
    const profile = await failing.loadOrCreateProfile(CHAT)
    expect(profile.interactionGeneration).toBe(1)
  })

  it("an injected batch failure rolls back the whole promote: no version row, current_version and generation unmoved", async () => {
    const backing: InMemoryMealPlanningBacking = {
      profiles: new Map(),
      plans: new Map(),
      versions: new Map(),
      batches: new Map(),
    }
    const store = await newStore(backing)
    await createPlan(store, createInput())

    const failing = createInMemoryMealPlanningStore({ backing, failNextOn: "promotePlanVersion" })
    await expect(
      failing.promotePlanVersion(
        promoteInput({ feedbackBatch: { batchId: "plan-1:v2", items: [{ id: "tg-1", text: "x" }] } }),
      ),
    ).rejects.toThrow("injected batch failure")

    const active = await failing.activePlan(CHAT)
    expect(active?.plan.currentVersion).toBe(1)
    expect(active?.version.version).toBe(1)
    const profile = await failing.loadOrCreateProfile(CHAT)
    expect(profile.interactionGeneration).toBe(1)
  })

  it("versions are insert-only: a later promotion never mutates an earlier version record", async () => {
    const store = await newStore()
    const created = await createPlan(store, createInput())
    const v1 = { ...created.version }
    await store.promotePlanVersion(promoteInput())
    expect(created.version.version).toBe(1)
    expect(created.version.candidate).toEqual(v1.candidate)
  })

  it("a fresh store instance over the same backing reads the active plan (restart survival)", async () => {
    const backing: InMemoryMealPlanningBacking = {
      profiles: new Map(),
      plans: new Map(),
      versions: new Map(),
      batches: new Map(),
    }
    const first = await newStore(backing)
    await createPlan(first, createInput())

    const restarted = createInMemoryMealPlanningStore({ backing })
    const active = await restarted.activePlan(CHAT)
    expect(active?.plan.planId).toBe("plan-1")
    expect(active?.plan.currentVersion).toBe(1)
    const profile = await restarted.loadOrCreateProfile(CHAT)
    expect(profile.interactionGeneration).toBe(1)
  })

  it("activePlan returns null when no plan exists for the chat", async () => {
    const store = createInMemoryMealPlanningStore()
    expect(await store.activePlan("chat-nowhere")).toBeNull()
  })

  it("createActivePlan fails when the profile row is missing, never returning a NaN generation", async () => {
    const store = createInMemoryMealPlanningStore()
    await expect(createPlan(store, createInput())).rejects.toThrow("meal_profile row missing for chat chat-1")
    expect(await store.activePlan(CHAT)).toBeNull()
  })
})

describe("meal-planning store type exports", () => {
  it("exposes a MealPlanningStore-typed factory", () => {
    const store: MealPlanningStore = createInMemoryMealPlanningStore()
    expect(typeof store.createActivePlan).toBe("function")
    expect(typeof store.promotePlanVersion).toBe("function")
    expect(typeof store.activePlan).toBe("function")
  })
})

// Production-D1-level tests: run the store's real SQL against an in-memory
// SQLite database (node:sqlite) with the migration applied, via the shared
// D1Database-shaped adapter (see ./d1-test-db.ts). This exercises the exact
// statements the D1 implementation binds, including the atomic
// missing-profile paths.

function createD1Store(): { store: MealPlanningStore; db: DatabaseSync } {
  const { db, d1 } = createD1TestDb()
  return { store: createMealPlanningStore(d1), db }
}

describe("createMealPlanningStore (D1, real SQL)", () => {
  it("runs the migration and the happy path: seed → create v1 → promote v2 with batch → activePlan", async () => {
    const { store, db } = createD1Store()
    const profile = await store.loadOrCreateProfile(CHAT)
    expect(profile.interactionGeneration).toBe(0)
    expect(profile.customPolicies).toHaveLength(7)

    const created = await createPlan(store, createInput())
    expect(created.generation).toBe(1)
    expect(created.previousReplaced).toBe(false)

    const promoted = await store.promotePlanVersion(
      promoteInput({ feedbackBatch: { batchId: "plan-1:v2", items: [{ id: "tg-42", text: "Tue lunch: less oily" }] } }),
    )
    expect(promoted).toMatchObject({ ok: true, generation: 2 })
    if (!promoted.ok) return

    const active = await store.activePlan(CHAT)
    expect(active?.plan.currentVersion).toBe(2)
    expect(active?.version.version).toBe(2)
    expect(active?.version.feedbackBatchId).toBe("plan-1:v2")
    expect(d1Count(db, "SELECT count(*) AS count FROM meal_plan_version")).toBe(2)
    expect(d1Count(db, "SELECT count(*) AS count FROM feedback_batch")).toBe(1)
  })

  it("persists usage columns through D1, sums them, and reads a null usage row back as null", async () => {
    const { store, db } = createD1Store()
    await store.loadOrCreateProfile(CHAT)
    const created = await createPlan(
      store,
      createInput({ usage: { inputTokens: 200, outputTokens: 30, model: "openai/gpt-5.6-luna" } }),
    )
    expect(created.version.usage).toEqual({ inputTokens: 200, outputTokens: 30, model: "openai/gpt-5.6-luna" })
    expect(await store.sumPlanUsage("plan-1")).toEqual({
      inputTokens: 200,
      outputTokens: 30,
      byModel: [{ inputTokens: 200, outputTokens: 30, model: "openai/gpt-5.6-luna" }],
    })
    expect(d1Scalar(db, "SELECT usage_model FROM meal_plan_version WHERE plan_id = ? AND version = 1", "plan-1")).toBe(
      "openai/gpt-5.6-luna",
    )

    const promoted = await store.promotePlanVersion(
      promoteInput({ usage: { inputTokens: 50, outputTokens: 10, model: "openai/gpt-5.6-luna" } }),
    )
    expect(promoted.ok).toBe(true)
    expect(await store.sumPlanUsage("plan-1")).toEqual({
      inputTokens: 250,
      outputTokens: 40,
      byModel: [{ inputTokens: 250, outputTokens: 40, model: "openai/gpt-5.6-luna" }],
    })
    const active = await store.activePlan(CHAT)
    expect(active?.version.usage).toEqual({ inputTokens: 50, outputTokens: 10, model: "openai/gpt-5.6-luna" })
  })

  it("a legacy version persisted without usage hydrates null and does not skew the sum", async () => {
    const { store, db } = createD1Store()
    await store.loadOrCreateProfile(CHAT)
    const created = await createPlan(store, createInput())
    expect(created.version.usage).toBeNull()
    expect(await store.sumPlanUsage("plan-1")).toBeNull()

    // A later revision records usage; the null-usage v1 row is skipped by the sum.
    const promoted = await store.promotePlanVersion(
      promoteInput({ usage: { inputTokens: 50, outputTokens: 10, model: "openai/gpt-5.6-luna" } }),
    )
    expect(promoted.ok).toBe(true)
    expect(d1Count(db, "SELECT count(*) AS count FROM meal_plan_version WHERE usage_input_tokens IS NULL")).toBe(1)
    expect(await store.sumPlanUsage("plan-1")).toEqual({
      inputTokens: 50,
      outputTokens: 10,
      byModel: [{ inputTokens: 50, outputTokens: 10, model: "openai/gpt-5.6-luna" }],
    })
  })

  it("createActivePlan with a missing profile throws atomically: no plan, no version, no profile row", async () => {
    const { store, db } = createD1Store()
    await expect(createPlan(store, createInput())).rejects.toThrow("meal_profile row missing for chat chat-1")
    expect(d1Count(db, "SELECT count(*) AS count FROM meal_plan")).toBe(0)
    expect(d1Count(db, "SELECT count(*) AS count FROM meal_plan_version")).toBe(0)
    expect(d1Count(db, "SELECT count(*) AS count FROM meal_profile")).toBe(0)
  })

  it("createActivePlan with a missing profile does not replace a prior active plan (supersede guarded)", async () => {
    const { store, db } = createD1Store()
    await store.loadOrCreateProfile(CHAT)
    await createPlan(store, createInput())
    expect(d1Count(db, "SELECT count(*) AS count FROM meal_plan WHERE status = 'active'")).toBe(1)

    // Simulate the programming-error precondition (profile row deleted).
    db.prepare("DELETE FROM meal_profile WHERE chat_id = ?").run(CHAT)
    await expect(createPlan(store, createInput({ planId: "plan-2" }))).rejects.toThrow(
      "meal_profile row missing for chat chat-1",
    )

    // The prior plan is still active, no successor, no orphan version.
    expect(d1Count(db, "SELECT count(*) AS count FROM meal_plan WHERE status = 'active'")).toBe(1)
    expect(d1Count(db, "SELECT count(*) AS count FROM meal_plan WHERE status = 'replaced'")).toBe(0)
    expect(d1Count(db, "SELECT count(*) AS count FROM meal_plan_version")).toBe(1)
  })

  it("promotePlanVersion with a missing profile throws atomically: no version, no advance, no batch, inventory unmoved", async () => {
    const { store, db } = createD1Store()
    await store.loadOrCreateProfile(CHAT)
    await createPlan(store, createInput({ weeklyInventory: { items: [], notes: ["original"] } }))

    db.prepare("DELETE FROM meal_profile WHERE chat_id = ?").run(CHAT)
    await expect(
      store.promotePlanVersion(
        promoteInput({
          inventory: {
            weeklyInventory: { items: [{ name: "dosa", status: "available" as const }], notes: ["stale write"] },
            weeklyExceptions: { items: [] },
          },
          feedbackBatch: { batchId: "plan-1:v2", items: [{ id: "tg-9", text: "x" }] },
        }),
      ),
    ).rejects.toThrow("meal_profile row missing for chat chat-1")

    const active = await store.activePlan(CHAT)
    expect(active?.plan.currentVersion).toBe(1)
    expect(active?.plan.weeklyInventory.notes).toEqual(["original"])
    expect(d1Count(db, "SELECT count(*) AS count FROM meal_plan_version")).toBe(1)
    expect(d1Count(db, "SELECT count(*) AS count FROM feedback_batch")).toBe(0)
    expect(d1Count(db, "SELECT count(*) AS count FROM meal_plan WHERE status = 'active'")).toBe(1)
  })

  it("a stale promote returns stale with no state changes", async () => {
    const { store, db } = createD1Store()
    await store.loadOrCreateProfile(CHAT)
    await createPlan(store, createInput())
    const first = await store.promotePlanVersion(promoteInput())
    expect(first.ok).toBe(true)

    const stale = await store.promotePlanVersion(
      promoteInput({ baseVersion: 1, feedbackBatch: { batchId: "plan-1:v2", items: [{ id: "tg-5", text: "late" }] } }),
    )
    expect(stale).toEqual({ ok: false, reason: "stale" })

    expect(await store.activePlan(CHAT)).toMatchObject({
      plan: { currentVersion: 2 },
      version: { version: 2 },
    })
    expect(d1Count(db, "SELECT count(*) AS count FROM meal_plan_version")).toBe(2)
    expect(d1Count(db, "SELECT count(*) AS count FROM feedback_batch")).toBe(1)
  })

  it("a cross-chat promotion (plan A id + chat B) is stale and changes neither plan nor either generation", async () => {
    const { store, db } = createD1Store()
    await store.loadOrCreateProfile(CHAT)
    await store.loadOrCreateProfile("chat-2")
    await createPlan(store, createInput())
    expect(d1Scalar(db, "SELECT interaction_generation FROM meal_profile WHERE chat_id = ?", "chat-2")).toBe(0)

    const cross = await store.promotePlanVersion(promoteInput({ chatId: "chat-2" }))
    expect(cross).toEqual({ ok: false, reason: "stale" })

    expect(await store.activePlan(CHAT)).toMatchObject({ plan: { currentVersion: 1 }, version: { version: 1 } })
    expect(d1Count(db, "SELECT count(*) AS count FROM meal_plan_version")).toBe(1)
    expect(d1Count(db, "SELECT count(*) AS count FROM feedback_batch")).toBe(0)
    expect(d1Scalar(db, "SELECT interaction_generation FROM meal_profile WHERE chat_id = ?", CHAT)).toBe(1)
    expect(d1Scalar(db, "SELECT interaction_generation FROM meal_profile WHERE chat_id = ?", "chat-2")).toBe(0)
  })

  it("serialize-and-supersede at the D1 level: a second create replaces the first, generation 1 then 2", async () => {
    const { store } = createD1Store()
    await store.loadOrCreateProfile(CHAT)
    const first = await createPlan(store, createInput())
    expect(first.generation).toBe(1)
    const second = await createPlan(store, createInput({ planId: "plan-2" }))
    expect(second.previousReplaced).toBe(true)
    expect(second.generation).toBe(2)
    expect(await store.activePlan(CHAT)).toMatchObject({ plan: { planId: "plan-2", currentVersion: 1 } })
  })

  it("migration CHECK constraints reject non-canonical enum values", () => {
    const { db } = createD1Store()
    const now = "2026-09-07T00:00:00.000Z"
    const valid = {
      plan_id: "plan-1",
      chat_id: CHAT,
      week_start: now,
      week_end: now,
      timezone: "Asia/Kolkata",
      instance_id: "wf-1",
      created_at: now,
      updated_at: now,
    }
    const bad = { ...valid, plan_id: "bad-status", status: "paused" }
    expect(() =>
      db
        .prepare(
          `INSERT INTO meal_plan (${Object.keys(bad).join(", ")}) VALUES (${Object.keys(bad)
            .map(() => "?")
            .join(", ")})`,
        )
        .run(...Object.values(bad)),
    ).toThrow("constraint failed")
    expect(() =>
      db
        .prepare(
          "INSERT INTO meal_plan_version (plan_id, version, candidate_json, evaluation_json, request_kind, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("plan-1", 99, "{}", "{}", "supersede", now),
    ).toThrow("constraint failed")
  })

  it("migration stays D1-compatible: no GLOB/LIKE patterns (node:sqlite accepts them, D1 rejects them) and the enum CHECKs are present", () => {
    const migration = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../migrations/0001_init.sql"),
      "utf8",
    ).replace(/^\s*--.*$/gm, "")
    expect(migration).not.toMatch(/GLOB|LIKE/i)
    expect(migration).toMatch(/CHECK\s*\(\s*status\s+IN\s*\(\s*'active'\s*,\s*'replaced'\s*\)\s*\)/i)
    expect(migration).toMatch(/CHECK\s*\(\s*request_kind\s+IN\s*\(\s*'initial_plan'\s*,\s*'revision'\s*\)\s*\)/i)
  })
})

describe.each([
  ["in-memory", async () => newStore()],
  [
    "D1",
    async () => {
      const { store } = createD1Store()
      await store.loadOrCreateProfile(CHAT)
      return store
    },
  ],
] as const)("Mini App durable contracts (%s)", (_name, makeStore) => {
  it("fences plan creation to the current unexpired generation lease", async () => {
    const store = await makeStore()
    await createPlan(store, createInput())
    await store.startPlanGeneration({
      chatId: CHAT,
      generationId: "generation-2",
      expiresAt: "2999-01-01T00:00:00.000Z",
    })

    await expect(
      store.createActivePlan(createInput({ planId: "stale-plan", generationId: "generation-1" })),
    ).rejects.toThrow("generation lease missing or expired")
    expect(await store.activePlan(CHAT)).toMatchObject({ plan: { planId: "plan-1", status: "active" } })

    await store.startPlanGeneration({
      chatId: CHAT,
      generationId: "generation-expired",
      expiresAt: "2020-01-01T00:00:00.000Z",
    })
    await expect(
      store.createActivePlan(createInput({ planId: "expired-plan", generationId: "generation-expired" })),
    ).rejects.toThrow("generation lease missing or expired")
    expect(await store.activePlanGeneration(CHAT, "3000-01-01T00:00:00.000Z")).toBeNull()

    await store.startPlanGeneration({
      chatId: CHAT,
      generationId: "generation-3",
      expiresAt: "2999-01-01T00:00:00.000Z",
    })
    await createPlan(store, createInput({ planId: "plan-3", generationId: "generation-3" }))
    expect(await store.activePlanGeneration(CHAT)).toBeNull()
  })

  it("keeps private chat scope, expires opaque sessions, and rejects replayed init data", async () => {
    const store = await makeStore()
    await createPlan(store, createInput())
    const context = await store.upsertMiniAppReviewContext({
      telegramUserId: "parent-1",
      chatId: CHAT,
      planId: "plan-1",
      weekEnd: WEEKS.weekEnd,
    })
    expect((await store.resolveMiniAppReviewContext("parent-1"))?.chatId).toBe(CHAT)
    expect(context.planId).toBe("plan-1")

    await store.createMiniAppSession({
      sessionId: "session-1",
      tokenHash: "digest",
      telegramUserId: "parent-1",
      chatId: CHAT,
      planId: "plan-1",
      expiresAt: "2026-09-07T00:10:00.000Z",
      createdAt: "2026-09-07T00:00:00.000Z",
    })
    expect(await store.readMiniAppSession("digest", "2026-09-07T00:05:00.000Z")).toMatchObject({ chatId: CHAT })
    expect(await store.readMiniAppSession("digest", "2026-09-07T00:10:00.000Z")).toBeNull()
    expect(
      await store.consumeMiniAppInitDataFingerprint(
        "launch-digest",
        "2026-09-07T00:10:00.000Z",
        "2026-09-07T00:00:00.000Z",
      ),
    ).toBe(true)
    expect(
      await store.consumeMiniAppInitDataFingerprint(
        "launch-digest",
        "2026-09-07T00:10:00.000Z",
        "2026-09-07T00:01:00.000Z",
      ),
    ).toBe(false)
  })

  it("falls back to the replaced plan context until the new active plan gets its review button", async () => {
    const store = await makeStore()
    await createPlan(store, createInput())
    await store.upsertMiniAppReviewContext({
      telegramUserId: "parent-1",
      chatId: CHAT,
      planId: "plan-1",
      weekEnd: WEEKS.weekEnd,
    })

    await createPlan(
      store,
      createInput({
        planId: "plan-2",
        instanceId: "instance-2",
        generationId: "generation-2",
        weekStart: "2026-09-14T00:00:00.000Z",
        weekEnd: "2026-09-19T23:59:59.000Z",
      }),
    )

    expect(await store.resolveMiniAppReviewContext("parent-1")).toMatchObject({ planId: "plan-1" })

    await store.upsertMiniAppReviewContext({
      telegramUserId: "parent-1",
      chatId: CHAT,
      planId: "plan-2",
      weekEnd: "2026-09-19T23:59:59.000Z",
    })
    expect(await store.resolveMiniAppReviewContext("parent-1")).toMatchObject({ planId: "plan-2" })
  })

  it("keeps generation leases token-scoped and blocks feedback while generation is active", async () => {
    const store = await makeStore()
    await createPlan(store, createInput())
    await store.startPlanGeneration({
      chatId: CHAT,
      generationId: "generation-1",
      startedAt: "2026-09-07T00:00:00.000Z",
      expiresAt: "2999-09-07T01:00:00.000Z",
    })
    expect(await store.activePlanGeneration(CHAT, "2026-09-07T00:30:00.000Z")).toMatchObject({
      generationId: "generation-1",
      status: "generating",
    })
    expect(await store.finishPlanGeneration(CHAT, "wrong-generation")).toBe(false)
    expect(await store.activePlanGeneration(CHAT, "2026-09-07T00:30:00.000Z")).not.toBeNull()

    expect(
      await store.acceptFeedbackBatch({
        batchId: "blocked-batch",
        planId: "plan-1",
        chatId: CHAT,
        baseVersion: 1,
        workflowInstanceId: "instance-1",
        idempotencyKey: "blocked-request",
        items: [{ text: "wait", target: { kind: "plan" } }],
      }),
    ).toEqual({ ok: false, reason: "generating" })

    expect(await store.finishPlanGeneration(CHAT, "generation-1")).toBe(true)
    expect(await store.activePlanGeneration(CHAT, "2026-09-07T00:30:00.000Z")).toBeNull()
    expect(
      await store.acceptFeedbackBatch({
        batchId: "accepted-after-generation",
        planId: "plan-1",
        chatId: CHAT,
        baseVersion: 1,
        workflowInstanceId: "instance-1",
        idempotencyKey: "accepted-request",
        items: [{ text: "now", target: { kind: "plan" } }],
      }),
    ).toMatchObject({ ok: true, batch: { status: "accepted" } })
  })

  it("hydrates current and replaced plans through chat-scoped history reads", async () => {
    const store = await makeStore()
    for (let index = 1; index <= MAX_MEAL_PLAN_HISTORY + 2; index++) {
      const planId = `plan-${String(index).padStart(2, "0")}`
      await createPlan(store, createInput({ planId, instanceId: `instance-${planId}` }))
    }

    const history = await store.listPlanHistory(CHAT)
    expect(history).toHaveLength(MAX_MEAL_PLAN_HISTORY)
    expect(history[0]).toMatchObject({ plan: { planId: "plan-14", status: "active" }, version: { version: 1 } })
    expect(history.at(-1)).toMatchObject({ plan: { planId: "plan-03", status: "replaced" }, version: { version: 1 } })
    expect(await store.planById(CHAT, "plan-03")).toMatchObject({ plan: { status: "replaced" } })
    expect(await store.planById("other-chat", "plan-03")).toBeNull()
  })

  it("accepts one version-bound batch idempotently and advances its dispatch lifecycle", async () => {
    const store = await makeStore()
    await createPlan(store, createInput())
    const input = {
      batchId: "batch-1",
      planId: "plan-1",
      chatId: CHAT,
      baseVersion: 1,
      workflowInstanceId: "instance-1",
      idempotencyKey: "request-1",
      items: [{ id: "item-1", text: "Too many new dishes", target: { kind: "plan" as const } }],
    }
    const accepted = await store.acceptFeedbackBatch(input)
    expect(accepted).toMatchObject({
      ok: true,
      duplicate: false,
      batch: {
        status: "accepted",
        items: [{ id: "mini-1" }],
        chatId: CHAT,
        workflowInstanceId: "instance-1",
        weekEnd: WEEKS.weekEnd,
      },
    })
    expect(await store.acceptFeedbackBatch({ ...input, batchId: "batch-other" })).toMatchObject({
      ok: true,
      duplicate: true,
    })
    expect(await store.markFeedbackBatchDelivered("batch-1")).toBe(true)
    expect(
      await store.claimFeedbackBatchForWorkflow("batch-1", "wrong-instance", "2026-09-07T00:01:30.000Z"),
    ).toBeNull()
    expect(
      await store.claimFeedbackBatchForWorkflow("batch-1", "instance-1", "2026-09-07T00:01:00.000Z"),
    ).toMatchObject({ status: "processing" })
    expect(await store.claimFeedbackBatchForWorkflow("batch-1", "instance-1", "2026-09-07T00:01:15.000Z")).toBeNull()
    expect(await store.markFeedbackBatchFailed("batch-1", "workflow", "2026-09-07T00:02:00.000Z")).toBe(true)
    expect(await store.claimFeedbackBatchFailureNotification("batch-1", "2026-09-07T00:03:00.000Z")).toBe(true)
    expect(await store.claimFeedbackBatchFailureNotification("batch-1", "2026-09-07T00:04:00.000Z")).toBe(false)
  })

  it("normalizes valid cell targets and rejects malformed or nonexistent feedback", async () => {
    const store = await makeStore()
    await createPlan(
      store,
      createInput({
        candidate: candidate({
          Mon: {
            breakfast: { dish: "poha", vegetarian: true, items: ["poha"], cookMinutes: 10, priorNightPrep: false },
          },
        }),
      }),
    )
    const base = { planId: "plan-1", chatId: CHAT, baseVersion: 1, workflowInstanceId: "instance-1" }
    const cell = await store.acceptFeedbackBatch({
      ...base,
      batchId: "cell-batch",
      idempotencyKey: "cell-request",
      items: [{ text: "  Please change this  ", target: { kind: "cell", day: "Mon", slot: "breakfast" } }],
    })
    expect(cell).toMatchObject({
      ok: true,
      batch: {
        items: [{ id: "mini-1", text: "Please change this", target: { kind: "cell", day: "Mon", slot: "breakfast" } }],
      },
    })
    await expect(
      store.acceptFeedbackBatch({ ...base, batchId: "bad-1", idempotencyKey: "bad-1", items: [] }),
    ).resolves.toEqual({ ok: false, reason: "invalid_items" })
    await expect(
      store.acceptFeedbackBatch({
        ...base,
        batchId: "bad-2",
        idempotencyKey: "bad-2",
        items: [{ text: "missing cell", target: { kind: "cell", day: "Mon", slot: "school-lunch" } }],
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid_items" })
  })
})
