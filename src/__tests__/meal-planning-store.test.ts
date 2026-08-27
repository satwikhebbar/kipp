import { describe, expect, it } from "vitest"
import {
  type CreateActivePlanInput,
  createInMemoryMealPlanningStore,
  type InMemoryMealPlanningBacking,
  type MealPlanningStore,
  type PromotePlanVersionInput,
} from "../meal-planning/store"
import type { MealPlanCandidate, MealPlanEvaluation } from "../meal-planning/types"

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

describe("createInMemoryMealPlanningStore", () => {
  it("seeds the initial household profile on first use and never reseeds", async () => {
    const store = createInMemoryMealPlanningStore()
    const profile = await store.loadOrCreateProfile(CHAT)
    expect(profile.chatId).toBe(CHAT)
    expect(profile.interactionGeneration).toBe(0)
    expect(profile.profile.dishRepertoire.length).toBeGreaterThan(0)
    expect(profile.customPolicies.map((policy) => policy.id)).toEqual([
      "snack-policy",
      "equipment-gap",
      "packing-capacity",
      "nutrition-target-fruit",
      "nutrition-target-nuts",
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
    const result = await store.createActivePlan(createInput())
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
    await store.createActivePlan(createInput())
    const second = await store.createActivePlan(createInput({ planId: "plan-2", instanceId: "instance-2" }))
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
    const other = await store.createActivePlan(createInput({ planId: "plan-3", chatId: "chat-2" }))
    expect(other.generation).toBe(1)
  })

  it("promotePlanVersion commits a revision: version N+1, current_version advance, generation bump, and the immutable submission batch linked from the new version", async () => {
    const store = await newStore()
    await store.createActivePlan(createInput())

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

  it("a stale promote changes nothing: no version row, generation unmoved, current_version unmoved, inventory unmoved, no feedback batch row", async () => {
    const store = await newStore()
    await store.createActivePlan(createInput({ weeklyInventory: { items: [], notes: ["original"] } }))
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

  it("the same-target race (a concurrent revision already committed the same newVersion) resolves stale, not an error, and leaves no extra version", async () => {
    const store = await newStore()
    await store.createActivePlan(createInput())
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

  it("an injected batch failure rolls back the whole create: no new plan, previous active stays, generation unmoved", async () => {
    const backing: InMemoryMealPlanningBacking = {
      profiles: new Map(),
      plans: new Map(),
      versions: new Map(),
      batches: new Map(),
    }
    const store = await newStore(backing)
    await store.createActivePlan(createInput())

    const failing = createInMemoryMealPlanningStore({ backing, failNextOn: "createActivePlan" })
    await expect(failing.createActivePlan(createInput({ planId: "plan-2", instanceId: "instance-2" }))).rejects.toThrow(
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
    await store.createActivePlan(createInput())

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
    const created = await store.createActivePlan(createInput())
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
    await first.createActivePlan(createInput())

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
})

describe("meal-planning store type exports", () => {
  it("exposes a MealPlanningStore-typed factory", () => {
    const store: MealPlanningStore = createInMemoryMealPlanningStore()
    expect(typeof store.createActivePlan).toBe("function")
    expect(typeof store.promotePlanVersion).toBe("function")
    expect(typeof store.activePlan).toBe("function")
  })
})
