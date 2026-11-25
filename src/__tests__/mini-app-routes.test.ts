import { runInNewContext } from "node:vm"
import { parseHTML } from "linkedom"
import { describe, expect, it, vi } from "vitest"
import type { Env } from "../core/types"
import { createSettingsLaunchReference } from "../meal-planning/mini-app-auth"
import { MINI_APP_SHELL, miniAppRoutes, startFeedbackBatch } from "../meal-planning/mini-app-routes"
import { mealProfileConfigurationRequestSchema } from "../meal-planning/profile-configuration"
import { validateMealSchedule } from "../meal-planning/schedule"
import { createMealPlanningStore, SEED_PROFILE, SEED_SCHEDULE } from "../meal-planning/store"
import type { MealGrid, MealProfile, MealSchedule, WeeklyExceptions } from "../meal-planning/types"
import { createClockedD1TestDb, createD1TestDb } from "./d1-test-db"

function env(): Env {
  const { d1 } = createClockedD1TestDb()
  return {
    MEAL_PLANNING_DB: d1,
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_ALLOWED_USER_ID: "42",
  } as Env
}

const BOT_TOKEN = "bot-token"
const FAKE_NOW = new Date("2026-09-22T05:40:00.000Z")

async function sign(key: Uint8Array, value: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value)))
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function signedInitData(): Promise<string> {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(FAKE_NOW.getTime() / 1_000)),
    query_id: "query-routes",
    user: JSON.stringify({ id: 42, first_name: "Parent" }),
  })
  const secret = await sign(new TextEncoder().encode("WebAppData"), BOT_TOKEN)
  const check = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")
  params.set("hash", toHex(await sign(secret, check)))
  return params.toString()
}

async function seedPlan(
  store: ReturnType<typeof createMealPlanningStore>,
  planId: string,
  weekStart: string,
  weekEnd: string,
  grid: MealGrid = {},
) {
  await store.loadOrCreateProfile("chat-42")
  const generationId = `generation-${planId}`
  await store.startPlanGeneration({
    chatId: "chat-42",
    generationId,
    expiresAt: "2999-01-01T00:00:00.000Z",
  })
  await store.createActivePlan({
    planId,
    chatId: "chat-42",
    weekStart,
    weekEnd,
    timezone: "Asia/Kolkata",
    schedule: SEED_SCHEDULE,
    establishedMealDefinitions: SEED_PROFILE.mealDefinitions ?? [],
    instanceId: `instance-${planId}`,
    generationId,
    candidate: { grid, easyBuys: [], policyOutcomes: {} },
    evaluation: {
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
    },
    weeklyInventory: { items: [], notes: [] },
    weeklyExceptions: { items: [] },
  })
}

/** Seeds one active plan, authenticates the allowed user, and returns the Mini App fixture. */
async function authenticatedPlanFixture(
  planId: string,
  weekStart: string,
  weekEnd: string,
  grid: MealGrid = {},
): Promise<{ d1: D1Database; store: ReturnType<typeof createMealPlanningStore>; testEnv: Env; token: string }> {
  let persistedAt: string | undefined = new Date(Math.min(Date.parse(weekStart), Date.now() - 1)).toISOString()
  const { d1 } = createClockedD1TestDb(() => persistedAt ?? new Date().toISOString())
  const store = createMealPlanningStore(d1)
  await seedPlan(store, planId, weekStart, weekEnd, grid)
  persistedAt = undefined
  await store.upsertMiniAppReviewContext({ telegramUserId: "42", chatId: "chat-42", planId, weekEnd })
  const testEnv = { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USER_ID: "42", MEAL_PLANNING_DB: d1 } as Env
  const session = await miniAppRoutes.fetch(
    new Request("https://kipp.example/mini-app/api/session", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: await signedInitData(),
    }),
    testEnv,
  )
  const { token } = (await session.json()) as { token: string }
  return { d1, store, testEnv, token }
}

/** Seeds one active plan for the allowed user and returns its Mini App plan response. */
async function planResponse(weekStart: string, weekEnd: string): Promise<Response> {
  const { testEnv, token } = await authenticatedPlanFixture("plan-1", weekStart, weekEnd)
  return miniAppRoutes.fetch(
    new Request("https://kipp.example/mini-app/api/plan", { headers: { Authorization: `Bearer ${token}` } }),
    testEnv,
  )
}

describe("Mini App HTTP boundary", () => {
  it("opens settings before a plan and atomically reads and saves versioned configuration", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(FAKE_NOW)
    try {
      const { d1 } = createD1TestDb()
      const testEnv = { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USER_ID: "42", MEAL_PLANNING_DB: d1 } as Env
      const launch = await createSettingsLaunchReference("42", "chat-42", testEnv, FAKE_NOW)
      const sessionResponse = await miniAppRoutes.fetch(
        new Request(`https://kipp.example/mini-app/api/session?launch=${encodeURIComponent(launch.reference)}`, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: await signedInitData(),
        }),
        testEnv,
      )
      expect(sessionResponse.status).toBe(201)
      expect(sessionResponse.headers.get("cache-control")).toBe("no-store")
      const session = (await sessionResponse.json()) as { token: string; scope: string }
      expect(session.scope).toBe("settings")
      const headers = { Authorization: `Bearer ${session.token}` }
      const profileResponse = await miniAppRoutes.fetch(
        new Request("https://kipp.example/mini-app/api/profile", { headers }),
        testEnv,
      )
      expect(profileResponse.status).toBe(200)
      expect(profileResponse.headers.get("cache-control")).toBe("no-store")
      const original = (await profileResponse.json()) as {
        configurationVersion: number
        profile: MealProfile
        customPolicies: unknown[]
        schedule: MealSchedule
        location: unknown
        eligibleEstablishedMeals: Record<string, string[]>
      }
      const planResponse = await miniAppRoutes.fetch(
        new Request("https://kipp.example/mini-app/api/plan", { headers }),
        testEnv,
      )
      expect(planResponse.status).toBe(403)
      const feedbackResponse = await miniAppRoutes.fetch(
        new Request("https://kipp.example/mini-app/api/feedback", {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: "{}",
        }),
        testEnv,
      )
      expect(feedbackResponse.status).toBe(403)

      const configuration = {
        expectedVersion: original.configurationVersion,
        profile: {
          dietaryExclusions: ["peanut", "sesame"],
          foodPreferences: original.profile.foodPreferences,
          allowNewFoods: original.profile.allowNewFoods,
          sensoryGuidelines: original.profile.sensoryGuidelines,
          morningCookingBudgetMinutes: original.profile.morningCookingBudgetMinutes,
          priorNightPrepAllowed: original.profile.priorNightPrepAllowed,
          pantryBaseline: original.profile.pantryBaseline,
        },
        customPolicies: [
          ...original.customPolicies,
          { id: "household-rule", label: "Household rule", scope: "persistent", value: "Use a varied lunch." },
        ],
        schedule: original.schedule,
        eligibleEstablishedMeals: original.eligibleEstablishedMeals,
        location: { country: "India", city: "Bengaluru" },
      }
      const ownerSupplied = await miniAppRoutes.fetch(
        new Request("https://kipp.example/mini-app/api/profile", {
          method: "PUT",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ ...configuration, chatId: "other-chat" }),
        }),
        testEnv,
      )
      expect(ownerSupplied.status).toBe(400)
      const saved = await miniAppRoutes.fetch(
        new Request("https://kipp.example/mini-app/api/profile", {
          method: "PUT",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(configuration),
        }),
        testEnv,
      )
      expect(saved.status).toBe(200)
      const savedConfig = (await saved.json()) as typeof original
      expect(savedConfig.configurationVersion).toBe(original.configurationVersion + 1)
      expect(savedConfig.profile.dietaryExclusions).toEqual(["peanut", "sesame"])
      expect(savedConfig.profile.mealDefinitions).toEqual(original.profile.mealDefinitions)
      expect(savedConfig.profile.dishRepertoire).toEqual(original.profile.dishRepertoire)
      expect(savedConfig.location).toEqual({ country: "India", city: "Bengaluru" })
      const staleVersion = await miniAppRoutes.fetch(
        new Request("https://kipp.example/mini-app/api/profile", {
          method: "PUT",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(configuration),
        }),
        testEnv,
      )
      expect(staleVersion.status).toBe(409)
      expect(savedConfig.customPolicies).toContainEqual({
        id: "household-rule",
        label: "Household rule",
        scope: "persistent",
        value: "Use a varied lunch.",
      })
      const reloaded = await miniAppRoutes.fetch(
        new Request("https://kipp.example/mini-app/api/profile", { headers }),
        testEnv,
      )
      const reloadedConfig = (await reloaded.json()) as typeof original
      expect(reloadedConfig).toMatchObject({
        configurationVersion: original.configurationVersion + 1,
        profile: { dietaryExclusions: ["peanut", "sesame"] },
      })
      expect(reloadedConfig.schedule).toEqual(savedConfig.schedule)
      expect(validateMealSchedule(reloadedConfig.schedule, reloadedConfig.profile)).toEqual([])

      const requiredPrepMeal = reloadedConfig.profile.mealDefinitions?.find(
        (definition) => definition.name.toLowerCase() === "rajma",
      )
      if (!requiredPrepMeal) throw new Error("missing required-prep meal fixture")
      const unavailablePrepOnlyConfiguration = {
        expectedVersion: reloadedConfig.configurationVersion,
        profile: {
          dietaryExclusions: reloadedConfig.profile.dietaryExclusions,
          foodPreferences: reloadedConfig.profile.foodPreferences,
          allowNewFoods: false,
          sensoryGuidelines: reloadedConfig.profile.sensoryGuidelines,
          morningCookingBudgetMinutes: reloadedConfig.profile.morningCookingBudgetMinutes,
          priorNightPrepAllowed: false,
          pantryBaseline: reloadedConfig.profile.pantryBaseline,
        },
        customPolicies: reloadedConfig.customPolicies,
        schedule: {
          days: ["Mon"],
          halfDays: [],
          slots: [
            {
              id: "prep-required",
              name: "Prep required",
              packed: false,
              dry: false,
              maxCookMinutes: null,
              halfDayBehavior: { action: "keep" },
            },
          ],
        },
        eligibleEstablishedMeals: { "prep-required": [requiredPrepMeal.id] },
        location: reloadedConfig.location,
      }
      const rejectedPrepOnlySchedule = await miniAppRoutes.fetch(
        new Request("https://kipp.example/mini-app/api/profile", {
          method: "PUT",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(unavailablePrepOnlyConfiguration),
        }),
        testEnv,
      )
      expect(rejectedPrepOnlySchedule.status).toBe(422)

      const invalidPolicyConfiguration = {
        ...configuration,
        expectedVersion: reloadedConfig.configurationVersion,
        customPolicies: [{ id: "constructor", label: "Bad ID", scope: "persistent", value: "bad" }],
      }
      const invalidPolicy = await miniAppRoutes.fetch(
        new Request("https://kipp.example/mini-app/api/profile", {
          method: "PUT",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(invalidPolicyConfiguration),
        }),
        testEnv,
      )
      expect(invalidPolicy.status).toBe(400)

      const implicitLegacySchedule = {
        ...configuration,
        expectedVersion: reloadedConfig.configurationVersion,
        schedule: {
          days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
          slots: [{ id: "school-lunch", name: "School lunch", packed: true, dry: false, maxCookMinutes: null }],
        },
        eligibleEstablishedMeals: { "school-lunch": [] },
      }
      const legacyNormalizedWrite = await miniAppRoutes.fetch(
        new Request("https://kipp.example/mini-app/api/profile", {
          method: "PUT",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(implicitLegacySchedule),
        }),
        testEnv,
      )
      expect(legacyNormalizedWrite.status).toBe(400)

      const stale = await miniAppRoutes.fetch(
        new Request("https://kipp.example/mini-app/api/profile", {
          method: "PUT",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(configuration),
        }),
        testEnv,
      )
      expect(stale.status).toBe(409)
      expect(await stale.json()).toEqual({ error: "version_conflict" })
    } finally {
      vi.useRealTimers()
    }
  })

  it("canonicalizes a legacy Sunday-only schedule before profile-only edits", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(FAKE_NOW)
    try {
      const { db, d1 } = createD1TestDb()
      const testEnv = { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USER_ID: "42", MEAL_PLANNING_DB: d1 } as Env
      const store = createMealPlanningStore(d1)
      const seeded = await store.loadOrCreateProfile("chat-42")
      const legacySchedule = {
        days: ["Sun"],
        slots: seeded.schedule.slots.map(({ halfDayBehavior: _behavior, ...slot }) => slot),
      }
      db.prepare("UPDATE meal_profile SET schedule_json = ?, version = 1 WHERE chat_id = ?").run(
        JSON.stringify(legacySchedule),
        "chat-42",
      )
      const launch = await createSettingsLaunchReference("42", "chat-42", testEnv, FAKE_NOW)
      const sessionResponse = await miniAppRoutes.fetch(
        new Request(`https://kipp.example/mini-app/api/session?launch=${encodeURIComponent(launch.reference)}`, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: await signedInitData(),
        }),
        testEnv,
      )
      const { token } = (await sessionResponse.json()) as { token: string }
      const headers = { Authorization: `Bearer ${token}` }
      const read = async () =>
        (await (
          await miniAppRoutes.fetch(new Request("https://kipp.example/mini-app/api/profile", { headers }), testEnv)
        ).json()) as {
          configurationVersion: number
          profile: MealProfile
          customPolicies: unknown[]
          schedule: MealSchedule
          location: { country: string; city: string } | null
          eligibleEstablishedMeals: Record<string, string[]>
        }
      const profile = await read()
      expect(profile.schedule.days).toEqual(["Sun"])
      expect(profile.schedule.halfDays).toEqual([])
      expect(validateMealSchedule(profile.schedule, profile.profile)).toEqual([])
      const savedResponse = await miniAppRoutes.fetch(
        new Request("https://kipp.example/mini-app/api/profile", {
          method: "PUT",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedVersion: profile.configurationVersion,
            profile: {
              dietaryExclusions: [...profile.profile.dietaryExclusions, "sesame"],
              foodPreferences: profile.profile.foodPreferences,
              allowNewFoods: profile.profile.allowNewFoods,
              sensoryGuidelines: profile.profile.sensoryGuidelines,
              morningCookingBudgetMinutes: profile.profile.morningCookingBudgetMinutes,
              priorNightPrepAllowed: profile.profile.priorNightPrepAllowed,
              pantryBaseline: profile.profile.pantryBaseline,
            },
            customPolicies: profile.customPolicies,
            schedule: profile.schedule,
            eligibleEstablishedMeals: profile.eligibleEstablishedMeals,
            location: profile.location,
          }),
        }),
        testEnv,
      )
      expect(savedResponse.status).toBe(200)
      const saved = (await savedResponse.json()) as typeof profile
      const reloaded = await read()
      expect(reloaded.configurationVersion).toBe(saved.configurationVersion)
      expect(reloaded.profile.dietaryExclusions).toContain("sesame")
      expect(reloaded.schedule).toEqual(profile.schedule)
      expect(reloaded.schedule.halfDays).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("rejects strict, oversized, and client-owner profile writes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(FAKE_NOW)
    try {
      const { testEnv, token } = await authenticatedPlanFixture("plan-profile", "2026-09-21", "2026-09-26")
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
      const profileResponse = await miniAppRoutes.fetch(
        new Request("https://kipp.example/mini-app/api/profile", { headers }),
        testEnv,
      )
      const current = (await profileResponse.json()) as {
        configurationVersion: number
        profile: MealProfile
        customPolicies: Array<{ id: string; label: string; scope: string; value: string }>
        schedule: MealSchedule
        eligibleEstablishedMeals: Record<string, string[]>
        location: { country: string; city: string } | null
      }
      const validBody = {
        expectedVersion: current.configurationVersion,
        profile: {
          dietaryExclusions: current.profile.dietaryExclusions,
          foodPreferences: current.profile.foodPreferences,
          allowNewFoods: current.profile.allowNewFoods,
          sensoryGuidelines: current.profile.sensoryGuidelines,
          morningCookingBudgetMinutes: current.profile.morningCookingBudgetMinutes,
          priorNightPrepAllowed: current.profile.priorNightPrepAllowed,
          pantryBaseline: current.profile.pantryBaseline,
        },
        customPolicies: current.customPolicies,
        schedule: current.schedule,
        eligibleEstablishedMeals: current.eligibleEstablishedMeals,
        location: current.location,
      }
      for (const body of ['{"chatId":"other-chat"}', "{}"])
        expect(
          (
            await miniAppRoutes.fetch(
              new Request("https://kipp.example/mini-app/api/profile", { method: "PUT", headers, body }),
              testEnv,
            )
          ).status,
        ).toBe(400)
      const ordinaryWrite = await miniAppRoutes.fetch(
        new Request("https://kipp.example/mini-app/api/profile", {
          method: "PUT",
          headers,
          body: JSON.stringify(validBody),
        }),
        testEnv,
      )
      expect(ordinaryWrite.status).toBe(200)
      const ordinarySaved = (await ordinaryWrite.json()) as { configurationVersion: number }
      const oversizedBody = {
        ...validBody,
        expectedVersion: ordinarySaved.configurationVersion,
        profile: {
          ...validBody.profile,
          dietaryExclusions: Array(100).fill("x".repeat(160)),
          foodPreferences: { favourites: Array(100).fill("y".repeat(160)), avoid: Array(100).fill("z".repeat(160)) },
          sensoryGuidelines: Array(50).fill("g".repeat(500)),
          pantryBaseline: Array(100).fill("p".repeat(160)),
        },
      }
      expect(mealProfileConfigurationRequestSchema.safeParse(oversizedBody).success).toBe(true)
      expect(new TextEncoder().encode(JSON.stringify(oversizedBody)).byteLength).toBeGreaterThan(64 * 1024)
      const oversized = await miniAppRoutes.fetch(
        new Request("https://kipp.example/mini-app/api/profile", {
          method: "PUT",
          headers: { ...headers, "Content-Length": "70000" },
          body: JSON.stringify(oversizedBody),
        }),
        testEnv,
      )
      expect(oversized.status).toBe(400)
      const afterOversized = await miniAppRoutes.fetch(
        new Request("https://kipp.example/mini-app/api/profile", { headers }),
        testEnv,
      )
      expect(((await afterOversized.json()) as { configurationVersion: number }).configurationVersion).toBe(
        ordinarySaved.configurationVersion,
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it("shows a recurring half-day marker only when the saved plan has the reduced Saturday shape", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(FAKE_NOW)
    try {
      const cell = { dish: "Banana", vegetarian: true, items: ["banana"], cookMinutes: 0, priorNightPrep: false }
      const { testEnv, token } = await authenticatedPlanFixture(
        "full-saturday",
        "2026-09-27T18:30:00.000Z",
        "2026-10-03T18:29:59.000Z",
        { Sat: { breakfast: cell, snack1: cell, snack2: cell, "school-lunch": cell, "home-lunch": cell } },
      )
      const response = await miniAppRoutes.fetch(
        new Request("https://kipp.example/mini-app/api/plan", { headers: { Authorization: `Bearer ${token}` } }),
        testEnv,
      )
      const body = (await response.json()) as { plan: { schedule: { halfDays: string[] } } }
      expect(body.plan.schedule.halfDays).toEqual([])

      const reduced = await authenticatedPlanFixture(
        "half-saturday",
        "2026-09-27T18:30:00.000Z",
        "2026-10-03T18:29:59.000Z",
        { Sat: { breakfast: cell, snack1: cell, "home-lunch": cell } },
      )
      const reducedResponse = await miniAppRoutes.fetch(
        new Request("https://kipp.example/mini-app/api/plan", {
          headers: { Authorization: `Bearer ${reduced.token}` },
        }),
        reduced.testEnv,
      )
      const reducedBody = (await reducedResponse.json()) as { plan: { schedule: { halfDays: string[] } } }
      expect(reducedBody.plan.schedule.halfDays).toEqual(["Sat"])

      const quickSchedule: MealSchedule = {
        days: ["Sun"],
        halfDays: ["Sun"],
        slots: [
          {
            id: "morning-tea",
            name: "Morning tea",
            packed: true,
            dry: true,
            maxCookMinutes: null,
            halfDayBehavior: { action: "quick", maxCookMinutes: 15 },
          },
        ],
      }
      const quick = await authenticatedPlanFixture(
        "quick-sunday",
        "2026-09-27T18:30:00.000Z",
        "2026-10-04T18:29:59.000Z",
        { Sun: { "morning-tea": cell } },
      )
      quick.d1
        .prepare("UPDATE meal_plan SET schedule_json = ? WHERE plan_id = ?")
        .bind(JSON.stringify(quickSchedule), "quick-sunday")
        .run()
      const quickResponse = await miniAppRoutes.fetch(
        new Request("https://kipp.example/mini-app/api/plan", { headers: { Authorization: `Bearer ${quick.token}` } }),
        quick.testEnv,
      )
      const quickBody = (await quickResponse.json()) as { plan: { schedule: MealSchedule } }
      expect(quickBody.plan.schedule.halfDays).toEqual(["Sun"])

      const fullDay = await authenticatedPlanFixture(
        "quick-sunday-full-day",
        "2026-09-27T18:30:00.000Z",
        "2026-10-04T18:29:59.000Z",
        { Sun: { "morning-tea": cell } },
      )
      fullDay.d1
        .prepare("UPDATE meal_plan SET schedule_json = ?, weekly_exceptions_json = ? WHERE plan_id = ?")
        .bind(
          JSON.stringify(quickSchedule),
          JSON.stringify({
            items: [{ kind: "full_day", appliesTo: { day: "Sun" }, instruction: "Sunday is a full school day" }],
          } satisfies WeeklyExceptions),
          "quick-sunday-full-day",
        )
        .run()
      const fullDayResponse = await miniAppRoutes.fetch(
        new Request("https://kipp.example/mini-app/api/plan", {
          headers: { Authorization: `Bearer ${fullDay.token}` },
        }),
        fullDay.testEnv,
      )
      const fullDayBody = (await fullDayResponse.json()) as { plan: { schedule: MealSchedule } }
      expect(fullDayBody.plan.schedule.halfDays).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("serves a data-free Mini App shell with ready, empty, and feedback affordances", async () => {
    const shell = await miniAppRoutes.fetch(new Request("https://kipp.example/mini-app"), env())
    expect(shell.status).toBe(200)
    expect(shell.headers.get("cache-control")).toBe("no-store")
    expect(shell.headers.get("content-type")).toBe("text/html; charset=utf-8")
    const html = await shell.text()
    expect(html).toContain("Change plan")
    expect(html).toContain("Household settings")
    expect(html).toContain("https://telegram.org/js/telegram-web-app.js")
    expect(html).toContain("Feedback ready")
    expect(html).toContain("Your next meal plan is still being generated.")
    expect(html).toContain("review and re-enter it on the new plan")
    expect(html).toContain("This plan has been replaced.")
    expect(html).toContain("Easy buys this week")
    expect(html).toContain("No easy buys needed this week.")
    expect(html).toContain("Holiday")
    expect(html).toContain("/mealplan")
    expect(html).toContain("A new plan is being generated.")
    expect(html).toContain("state.currentPlan!==undefined")
    expect(html).toContain('aria-label","Read-only plan')
    expect(html).toContain("Refresh plan")
    expect(html).toContain('aria-label","Choose meal plan week')
    expect(html).not.toContain("Current plan — feedback is available.")
    expect(html).not.toContain("History · ")
    expect(html).toContain("dayDate(day).getUTCDate()")
    expect(html).not.toContain('dateLabel(day).split(" ").slice(-1)[0]')
    expect(html).not.toContain("mealplan-")

    const plan = await miniAppRoutes.fetch(new Request("https://kipp.example/mini-app/api/plan"), env())
    expect(plan.status).toBe(403)
    expect(plan.headers.get("cache-control")).toBe("no-store")
  })

  it("edits and reloads household settings from a settings-only Mini App launch", async () => {
    const { window } = parseHTML('<main id="app"><div class="status">Loading your plan…</div></main>')
    const location = new URL("https://kipp.example/mini-app?launch=private-launch")
    Object.defineProperty(window, "location", { value: location, configurable: true })
    Object.defineProperty(window, "Telegram", {
      value: { WebApp: { initData: "signed-inline-init-data", ready: vi.fn(), expand: vi.fn() } },
      configurable: true,
    })
    const client = window as unknown as { fetch: typeof fetch; MutationObserver: typeof window.MutationObserver }
    const profile = JSON.parse(JSON.stringify(SEED_PROFILE)) as MealProfile
    const schedule = JSON.parse(JSON.stringify(SEED_SCHEDULE)) as MealSchedule
    let serverSettings = {
      configurationVersion: 1,
      profile,
      customPolicies: [
        {
          id: "legacy-week-policy",
          label: "Week-only instruction",
          scope: "current_week",
          value: "Keep the plan simple",
        },
      ],
      schedule,
      location: null,
      eligibleEstablishedMeals: Object.fromEntries(
        schedule.slots.map((slot) => [
          slot.id,
          (profile.mealDefinitions ?? [])
            .filter((definition) => definition.status === "established" && definition.suitableSlots.includes(slot.id))
            .map((definition) => definition.id),
        ]),
      ),
    }
    const calls: Array<{ path: string; method: string }> = []
    const submissions: Array<Record<string, unknown>> = []
    let delayNextSave = false
    let lateSaveOutcome: "conflict" | "server-error" | "network-error" | null = null
    let delayNextProfileGet = false
    let delayNextPlanGet = false
    let rejectNextPlanGet = false
    let conflictNextSave = false
    let conflictSequence = 0
    let slotConflictNextSave = false
    let eligibilityConflictNextSave: { slotId: string; eligibleIds: string[] } | null = null
    let dayConflictNextSave = false
    let halfDayConflictNextSave: "half" | "full" | null = null
    const delayedSave = {
      release: undefined as (() => void) | undefined,
      releases: [] as Array<() => void>,
    }
    const delayedGet = { release: undefined as (() => void) | undefined }
    const delayedPlan = { release: undefined as (() => void) | undefined }
    client.fetch = async (input, init) => {
      const path = String(input)
      const method = init?.method ?? "GET"
      calls.push({ path, method })
      if (path.startsWith("/mini-app/api/session"))
        return new Response(JSON.stringify({ token: "settings-session", scope: "settings" }), { status: 201 })
      if (path.startsWith("/mini-app/api/plan")) {
        if (delayNextPlanGet) {
          delayNextPlanGet = false
          await new Promise<void>((resolve) => {
            delayedPlan.release = resolve
          })
        }
        if (rejectNextPlanGet) {
          rejectNextPlanGet = false
          throw new Error("offline")
        }
        return new Response(
          JSON.stringify({
            status: "current",
            plan: {
              planId: "plan-selected-after-back",
              version: 1,
              weekStart: "2026-09-27T18:30:00.000Z",
              timezone: "Asia/Kolkata",
              schedule: { days: ["Mon"], slots: [{ id: "lunch", name: "Lunch" }] },
              candidate: { grid: { Mon: { lunch: { dish: "Rice", items: ["Rice"] } } }, easyBuys: [] },
              weeklyExceptions: { items: [] },
            },
            history: [],
          }),
        )
      }
      if (path === "/mini-app/api/profile" && method === "PUT") {
        const submitted = JSON.parse(String(init?.body)) as Record<string, unknown>
        submissions.push(submitted)
        if (delayNextSave) {
          delayNextSave = false
          await new Promise<void>((resolve) => {
            delayedSave.release = resolve
            delayedSave.releases.push(resolve)
          })
        }
        if (lateSaveOutcome === "network-error") {
          lateSaveOutcome = null
          throw new Error("offline")
        }
        if (lateSaveOutcome === "conflict") {
          lateSaveOutcome = null
          serverSettings = {
            ...serverSettings,
            configurationVersion: serverSettings.configurationVersion + 1,
            profile: { ...serverSettings.profile, pantryBaseline: ["oats"] },
          }
          return new Response(JSON.stringify({ error: "version_conflict" }), { status: 409 })
        }
        if (lateSaveOutcome === "server-error") {
          lateSaveOutcome = null
          return new Response(JSON.stringify({ error: "unavailable" }), { status: 500 })
        }
        const data = submitted as typeof serverSettings & { expectedVersion: number }
        if (data.expectedVersion !== serverSettings.configurationVersion)
          return new Response(JSON.stringify({ error: "version_conflict" }), { status: 409 })
        if (submissions.length === 1) {
          serverSettings = {
            ...serverSettings,
            configurationVersion: 2,
            profile: { ...serverSettings.profile, sensoryGuidelines: ["Use gentle seasoning"] },
          }
          return new Response(JSON.stringify({ error: "version_conflict" }), { status: 409 })
        }
        if (conflictNextSave || conflictSequence > 0) {
          conflictNextSave = false
          const sequenceConflict = conflictSequence > 0
          if (sequenceConflict) conflictSequence -= 1
          serverSettings = {
            ...serverSettings,
            configurationVersion: serverSettings.configurationVersion + 1,
            profile: {
              ...serverSettings.profile,
              sensoryGuidelines: [
                sequenceConflict ? `Remote revision ${2 - conflictSequence}` : "Other session preference",
              ],
            },
          }
          return new Response(JSON.stringify({ error: "version_conflict" }), { status: 409 })
        }
        if (slotConflictNextSave) {
          slotConflictNextSave = false
          const lunch: MealSchedule["slots"][number] = {
            id: "remote-lunch",
            name: "Lunch",
            packed: false,
            dry: false,
            maxCookMinutes: null,
            halfDayBehavior: { action: "keep" as const },
          }
          serverSettings = {
            ...serverSettings,
            configurationVersion: serverSettings.configurationVersion + 1,
            schedule: { ...serverSettings.schedule, slots: [...serverSettings.schedule.slots, lunch] },
            eligibleEstablishedMeals: { ...serverSettings.eligibleEstablishedMeals, "remote-lunch": [] },
          }
          return new Response(JSON.stringify({ error: "version_conflict" }), { status: 409 })
        }
        if (eligibilityConflictNextSave) {
          const conflict = eligibilityConflictNextSave
          eligibilityConflictNextSave = null
          serverSettings = {
            ...serverSettings,
            configurationVersion: serverSettings.configurationVersion + 1,
            eligibleEstablishedMeals: {
              ...serverSettings.eligibleEstablishedMeals,
              [conflict.slotId]: conflict.eligibleIds,
            },
          }
          return new Response(JSON.stringify({ error: "version_conflict" }), { status: 409 })
        }
        if (dayConflictNextSave) {
          dayConflictNextSave = false
          serverSettings = {
            ...serverSettings,
            configurationVersion: serverSettings.configurationVersion + 1,
            schedule: { ...serverSettings.schedule, days: ["Tue"], halfDays: [] },
          }
          return new Response(JSON.stringify({ error: "version_conflict" }), { status: 409 })
        }
        if (halfDayConflictNextSave) {
          const conflict = halfDayConflictNextSave
          halfDayConflictNextSave = null
          const halfDays = new Set(serverSettings.schedule.halfDays ?? [])
          if (conflict === "half") halfDays.add("Tue")
          else halfDays.delete("Tue")
          serverSettings = {
            ...serverSettings,
            configurationVersion: serverSettings.configurationVersion + 1,
            schedule: { ...serverSettings.schedule, halfDays: [...halfDays] },
          }
          return new Response(JSON.stringify({ error: "version_conflict" }), { status: 409 })
        }
        const submittedSlotIds = data.schedule.slots.map((slot) => slot.id).sort()
        if (JSON.stringify(Object.keys(data.eligibleEstablishedMeals).sort()) !== JSON.stringify(submittedSlotIds))
          return new Response(JSON.stringify({ error: "invalid_configuration" }), { status: 400 })
        if ((data.schedule.halfDays ?? []).some((day) => !data.schedule.days.includes(day)))
          return new Response(JSON.stringify({ error: "invalid_configuration" }), { status: 400 })
        serverSettings = {
          configurationVersion: data.expectedVersion + 1,
          profile: { ...serverSettings.profile, ...data.profile },
          customPolicies: data.customPolicies,
          schedule: data.schedule,
          location: data.location,
          eligibleEstablishedMeals: data.eligibleEstablishedMeals,
        }
        return new Response(JSON.stringify(serverSettings))
      }
      if (path === "/mini-app/api/profile") {
        if (delayNextProfileGet) {
          delayNextProfileGet = false
          await new Promise<void>((resolve) => {
            delayedGet.release = resolve
          })
        }
        return new Response(JSON.stringify(serverSettings))
      }
      return new Response(JSON.stringify({ error: "unexpected_request" }), { status: 404 })
    }
    const scripts = [...MINI_APP_SHELL.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1])
    const context = {
      window,
      document: window.document,
      MutationObserver: client.MutationObserver,
      Event: window.Event,
      Response,
      URL,
      fetch: (...args: Parameters<typeof fetch>) => client.fetch(...args),
      localStorage: { getItem: () => null },
    }
    scripts.forEach((script) => {
      runInNewContext(script, context)
    })
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
    await settle()

    const app = window.document.getElementById("app")
    expect(app?.textContent).toContain("Household settings")
    expect(app?.textContent).toContain("/mealplan this week")
    expect(app?.querySelector(".settings-form")).not.toBeNull()
    expect(calls[0]?.path).toBe("/mini-app/api/session?launch=private-launch")
    expect(calls.some((call) => call.path.includes("/mini-app/api/plan"))).toBe(false)
    expect(app?.textContent).toContain("Current week only (saved)")

    const initialRows = [...(app?.querySelectorAll(".settings-slot") ?? [])]
    const slotRowToRemove = initialRows.at(-1)
    if (!slotRowToRemove) throw new Error("missing initial slot")
    const removedId = (slotRowToRemove.querySelector('[data-slot="id"]') as unknown as { value: string }).value
    slotRowToRemove
      .querySelector('button[data-slot-action="0"]')
      ?.dispatchEvent(new window.Event("click", { bubbles: true }))
    app?.querySelector('button[data-action="add-slot"]')?.dispatchEvent(new window.Event("click", { bubbles: true }))
    const rows = [...(app?.querySelectorAll(".settings-slot") ?? [])]
    const addedRow = rows.at(-1)
    expect(addedRow).toBeDefined()
    const addedId = addedRow?.querySelector('[data-slot="id"]') as unknown as { value: string; readOnly: boolean }
    const addedName = addedRow?.querySelector('[data-slot="name"]') as unknown as { value: string; checked: boolean }
    expect(addedId.readOnly).toBe(true)
    expect(addedId.value).not.toBe(removedId)
    addedName.value = "Morning tea"
    const eligible = addedRow?.querySelector("[data-meal-id]") as unknown as { value: string; checked: boolean }
    expect(eligible).toBeDefined()
    eligible.checked = true
    addedRow
      ?.querySelector('button[data-slot-action="-1"]')
      ?.dispatchEvent(new window.Event("click", { bubbles: true }))

    app?.querySelector('button[data-action="add-policy"]')?.dispatchEvent(new window.Event("click", { bubbles: true }))
    const firstAddedPolicy = [...(app?.querySelectorAll(".settings-policy") ?? [])].at(-1)
    const firstAddedId = firstAddedPolicy?.querySelector('[data-policy="id"]') as unknown as { value: string }
    expect(firstAddedId.value).toBe("household-rule-2")
    app?.querySelector('button[data-action="add-policy"]')?.dispatchEvent(new window.Event("click", { bubbles: true }))
    const currentFirstAdded = [...(app?.querySelectorAll(".settings-policy") ?? [])].find(
      (row) => (row.querySelector('[data-policy="id"]') as unknown as { value: string }).value === firstAddedId.value,
    )
    currentFirstAdded
      ?.querySelector('button[data-action="remove-policy"]')
      ?.dispatchEvent(new window.Event("click", { bubbles: true }))
    app?.querySelector('button[data-action="add-policy"]')?.dispatchEvent(new window.Event("click", { bubbles: true }))
    const policyIds = [...(app?.querySelectorAll('.settings-policy [data-policy="id"]') ?? [])].map(
      (input) => (input as unknown as { value: string }).value,
    )
    expect(new Set(policyIds).size).toBe(policyIds.length)
    const generatedPolicyCount = [...(app?.querySelectorAll(".settings-policy") ?? [])].filter((row) =>
      (row.querySelector('[data-policy="id"]') as unknown as { value: string }).value.startsWith("household-rule-"),
    ).length
    for (let attempt = 0; attempt < generatedPolicyCount; attempt += 1) {
      const generatedPolicy = [...(app?.querySelectorAll(".settings-policy") ?? [])].find((row) =>
        (row.querySelector('[data-policy="id"]') as unknown as { value: string }).value.startsWith("household-rule-"),
      )
      if (!generatedPolicy) break
      generatedPolicy
        .querySelector('button[data-action="remove-policy"]')
        ?.dispatchEvent(new window.Event("click", { bubbles: true }))
    }
    expect(
      [...(app?.querySelectorAll(".settings-policy") ?? [])].filter((row) =>
        (row.querySelector('[data-policy="id"]') as unknown as { value: string }).value.startsWith("household-rule-"),
      ),
    ).toHaveLength(0)
    app?.querySelector('button[data-action="add-policy"]')?.dispatchEvent(new window.Event("click", { bubbles: true }))
    const policy = [...(app?.querySelectorAll(".settings-policy") ?? [])].at(-1)
    ;(policy?.querySelector('[data-policy="id"]') as unknown as { value: string }).value = "avoid-red-dye"
    ;(policy?.querySelector('[data-policy="label"]') as unknown as { value: string }).value = "Avoid red dye"
    ;(policy?.querySelector('[data-policy="value"]') as unknown as { value: string }).value = "Do not use red dye"

    const dayChecks = [...(app?.querySelectorAll('input[name="days"]') ?? [])] as unknown as {
      value: string
      checked: boolean
    }[]
    dayChecks.forEach((input) => {
      input.checked = input.value === "Tue" || input.value === "Sun"
    })
    const halfDayChecks = [...(app?.querySelectorAll('input[name="halfDays"]') ?? [])] as unknown as {
      value: string
      checked: boolean
    }[]
    halfDayChecks.forEach((input) => {
      input.checked = input.value === "Sun"
    })
    const exclusions = app?.querySelector('[data-setting="dietaryExclusions"]') as unknown as { value: string }
    exclusions.value = "egg\nsesame"
    const form = app?.querySelector(".settings-form")
    form?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
    await settle()

    expect(submissions[0]).toMatchObject({
      expectedVersion: 1,
      profile: { dietaryExclusions: ["egg", "sesame"] },
      customPolicies: [
        {
          id: "legacy-week-policy",
          label: "Week-only instruction",
          scope: "current_week",
          value: "Keep the plan simple",
        },
        { id: "avoid-red-dye", label: "Avoid red dye", scope: "persistent", value: "Do not use red dye" },
      ],
      schedule: {
        days: ["Tue", "Sun"],
        halfDays: ["Sun"],
      },
    })
    expect(app?.textContent).toContain("changed in another session")
    delayNextProfileGet = true
    app?.querySelector('button[data-action="reapply"]')?.dispatchEvent(new window.Event("click", { bubbles: true }))
    expect(delayedGet.release).toBeDefined()
    const disabledDuringReapply = app?.querySelector('[data-setting="dietaryExclusions"]') as unknown as {
      disabled: boolean
    }
    expect(disabledDuringReapply.disabled).toBe(true)
    delayedGet.release?.()
    await settle()

    const reapplied = submissions[1]
    if (!reapplied) throw new Error("missing reapply request")
    expect(reapplied).toMatchObject({
      expectedVersion: 2,
      profile: { dietaryExclusions: ["egg", "sesame"], sensoryGuidelines: ["Use gentle seasoning"] },
      customPolicies: [
        {
          id: "legacy-week-policy",
          label: "Week-only instruction",
          scope: "current_week",
          value: "Keep the plan simple",
        },
        { id: "avoid-red-dye", label: "Avoid red dye", scope: "persistent", value: "Do not use red dye" },
      ],
    })
    const submittedSchedule = reapplied.schedule as MealSchedule
    expect(submittedSchedule.slots.map((slot) => slot.id)).toEqual([
      "breakfast",
      "snack1",
      "snack2",
      addedId.value,
      "school-lunch",
    ])
    expect((reapplied.eligibleEstablishedMeals as Record<string, string[]>)[addedId.value]).toEqual([eligible.value])
    expect(app?.textContent).toContain("Settings saved.")
    delayNextProfileGet = true
    app?.querySelector('button[data-action="reload"]')?.dispatchEvent(new window.Event("click", { bubbles: true }))
    expect(delayedGet.release).toBeDefined()
    const disabledDuringReload = app?.querySelector('[data-setting="dietaryExclusions"]') as unknown as {
      disabled: boolean
    }
    expect(disabledDuringReload.disabled).toBe(true)
    delayedGet.release?.()
    await settle()
    expect(calls.filter((call) => call.path === "/mini-app/api/profile" && call.method === "GET")).toHaveLength(3)
    expect((app?.querySelector('[data-setting="dietaryExclusions"]') as unknown as { value: string })?.value).toContain(
      "sesame",
    )
    expect(serverSettings.profile.sensoryGuidelines).toEqual(["Use gentle seasoning"])
    expect(app?.textContent).toContain("Current week only (saved)")

    delayNextProfileGet = true
    app?.querySelector('button[data-action="reload"]')?.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    expect(delayedGet.release).toBeDefined()
    window.dispatchEvent(new window.Event("popstate"))
    await settle()
    expect(app?.textContent).toContain("Rice")
    app?.querySelector(".settings-open")?.dispatchEvent(new window.Event("click"))
    await settle()
    const editsAfterReopen = app?.querySelector('[data-setting="dietaryExclusions"]') as unknown as { value: string }
    editsAfterReopen.value = "egg\nsesame\nnewer view edit"
    delayedGet.release?.()
    await settle()
    const editsAfterStaleReload = app?.querySelector('[data-setting="dietaryExclusions"]') as unknown as {
      value: string
    } | null
    expect(editsAfterStaleReload?.value).toBe("egg\nsesame\nnewer view edit")

    window.dispatchEvent(new window.Event("popstate"))
    await settle()
    expect(app?.textContent).toContain("Rice")
    delayNextPlanGet = true
    window.dispatchEvent(new window.Event("popstate"))
    await settle()
    expect(delayedPlan.release).toBeDefined()
    app?.querySelector(".settings-open")?.dispatchEvent(new window.Event("click"))
    await settle()
    const editsDuringPlanLoad = app?.querySelector('[data-setting="dietaryExclusions"]') as unknown as { value: string }
    editsDuringPlanLoad.value = "egg\nsesame\nedit during plan load"
    delayedPlan.release?.()
    await settle()
    const editsAfterPlanLoad = app?.querySelector('[data-setting="dietaryExclusions"]') as unknown as {
      value: string
    } | null
    expect(editsAfterPlanLoad?.value).toBe("egg\nsesame\nedit during plan load")

    window.dispatchEvent(new window.Event("popstate"))
    await settle()
    delayNextPlanGet = true
    rejectNextPlanGet = true
    window.dispatchEvent(new window.Event("popstate"))
    await settle()
    expect(delayedPlan.release).toBeDefined()
    app?.querySelector(".settings-open")?.dispatchEvent(new window.Event("click"))
    await settle()
    const editsDuringFailedPlanLoad = app?.querySelector('[data-setting="dietaryExclusions"]') as unknown as {
      value: string
    }
    editsDuringFailedPlanLoad.value = "egg\nsesame\nedit during failed plan load"
    delayedPlan.release?.()
    await settle()
    const editsAfterFailedPlanLoad = app?.querySelector('[data-setting="dietaryExclusions"]') as unknown as {
      value: string
    } | null
    expect(editsAfterFailedPlanLoad?.value).toBe("egg\nsesame\nedit during failed plan load")

    const profileOnlyExclusions = app?.querySelector('[data-setting="dietaryExclusions"]') as unknown as {
      value: string
    }
    profileOnlyExclusions.value = "egg\nsesame\nalmond"
    app?.querySelector(".settings-form")?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
    await settle()
    expect(serverSettings.customPolicies[0]?.scope).toBe("current_week")

    conflictNextSave = true
    const sensory = app?.querySelector('[data-setting="sensoryGuidelines"]') as unknown as { value: string }
    sensory.value = "Local preference"
    app?.querySelector(".settings-form")?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
    await settle()
    app?.querySelector('button[data-action="reapply"]')?.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    expect(app?.textContent).toContain("profile.sensoryGuidelines")
    const saveWithUnresolvedOverlap = app?.querySelector(".settings-save") as unknown as { disabled: boolean }
    expect(saveWithUnresolvedOverlap.disabled).toBe(true)
    const submissionCountWithOverlap = submissions.length
    app?.querySelector(".settings-form")?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
    await settle()
    expect(submissions).toHaveLength(submissionCountWithOverlap)
    app
      ?.querySelector('button[data-action="use-latest-conflicts"]')
      ?.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    expect(serverSettings.profile.sensoryGuidelines).toEqual(["Other session preference"])

    slotConflictNextSave = true
    const snackRow = [...(app?.querySelectorAll(".settings-slot") ?? [])].find(
      (row) => (row.querySelector('[data-slot="id"]') as unknown as { value: string }).value === "snack1",
    )
    snackRow?.querySelector('button[data-slot-action="0"]')?.dispatchEvent(new window.Event("click", { bubbles: true }))
    app?.querySelector(".settings-form")?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
    await settle()
    app?.querySelector('button[data-action="reapply"]')?.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    expect(app?.textContent).toContain("schedule.slots")
    app
      ?.querySelector('button[data-action="use-latest-conflicts"]')
      ?.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    expect(app?.textContent).toContain("Settings saved.")
    const resolvedSlotIds = serverSettings.schedule.slots.map((slot) => slot.id).sort()
    expect(Object.keys(serverSettings.eligibleEstablishedMeals).sort()).toEqual(resolvedSlotIds)
    expect(resolvedSlotIds).toContain("remote-lunch")
    expect(resolvedSlotIds).toContain("snack1")

    const establishedMealId = serverSettings.profile.mealDefinitions?.find(
      (definition) => definition.status === "established",
    )?.id
    if (!establishedMealId) throw new Error("missing established meal for the slot conflict test")
    const originalSnackMeals = [...serverSettings.eligibleEstablishedMeals.breakfast]
    const latestSnackMeals = originalSnackMeals.length ? [] : [establishedMealId]
    eligibilityConflictNextSave = { slotId: "breakfast", eligibleIds: latestSnackMeals }
    const snackToRemove = [...(app?.querySelectorAll(".settings-slot") ?? [])].find(
      (row) => (row.querySelector('[data-slot="id"]') as unknown as { value: string }).value === "breakfast",
    )
    snackToRemove
      ?.querySelector('button[data-slot-action="0"]')
      ?.dispatchEvent(new window.Event("click", { bubbles: true }))
    app?.querySelector(".settings-form")?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
    await settle()
    app?.querySelector('button[data-action="reapply"]')?.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    expect(app?.textContent).toContain("schedule.slots.breakfast and eligibleEstablishedMeals.breakfast")
    app
      ?.querySelector('button[data-action="use-latest-conflicts"]')
      ?.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    expect(serverSettings.schedule.slots.some((slot) => slot.id === "breakfast")).toBe(true)
    expect(serverSettings.eligibleEstablishedMeals.breakfast).toEqual(latestSnackMeals)

    const keepLocalSnackMeals = latestSnackMeals.length ? [] : [establishedMealId]
    eligibilityConflictNextSave = { slotId: "breakfast", eligibleIds: keepLocalSnackMeals }
    const snackToRemoveAgain = [...(app?.querySelectorAll(".settings-slot") ?? [])].find(
      (row) => (row.querySelector('[data-slot="id"]') as unknown as { value: string }).value === "breakfast",
    )
    snackToRemoveAgain
      ?.querySelector('button[data-slot-action="0"]')
      ?.dispatchEvent(new window.Event("click", { bubbles: true }))
    app?.querySelector(".settings-form")?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
    await settle()
    app?.querySelector('button[data-action="reapply"]')?.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    app
      ?.querySelector('button[data-action="keep-local-conflicts"]')
      ?.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    expect(serverSettings.schedule.slots.some((slot) => slot.id === "breakfast")).toBe(false)
    expect("breakfast" in serverSettings.eligibleEstablishedMeals).toBe(false)

    const configuredDays = [...(app?.querySelectorAll('input[name="days"]') ?? [])] as unknown as {
      value: string
      checked: boolean
    }[]
    configuredDays.forEach((input) => {
      input.checked = input.value === "Mon" || input.value === "Tue"
    })
    const configuredHalfDays = [...(app?.querySelectorAll('input[name="halfDays"]') ?? [])] as unknown as {
      value: string
      checked: boolean
    }[]
    configuredHalfDays.forEach((input) => {
      input.checked = false
    })
    app?.querySelector(".settings-form")?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
    await settle()
    expect(serverSettings.schedule.days).toEqual(["Mon", "Tue"])
    expect(serverSettings.schedule.halfDays ?? []).toEqual([])

    halfDayConflictNextSave = "half"
    const localConflictDays = [...(app?.querySelectorAll('input[name="days"]') ?? [])] as unknown as {
      value: string
      checked: boolean
    }[]
    localConflictDays.forEach((input) => {
      input.checked = input.value === "Mon" || input.value === "Wed"
    })
    app?.querySelector(".settings-form")?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
    await settle()
    const submissionsBeforeDayReapply = submissions.length
    app?.querySelector('button[data-action="reapply"]')?.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    expect(submissions).toHaveLength(submissionsBeforeDayReapply)
    expect(app?.textContent).toContain("schedule.day.Tue")
    app
      ?.querySelector('button[data-action="use-latest-conflicts"]')
      ?.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    expect(serverSettings.schedule.days).toEqual(["Mon", "Tue", "Wed"])
    expect(serverSettings.schedule.halfDays).toEqual(["Tue"])

    halfDayConflictNextSave = "full"
    const daysAfterLatestChoice = [...(app?.querySelectorAll('input[name="days"]') ?? [])] as unknown as {
      value: string
      checked: boolean
    }[]
    daysAfterLatestChoice.forEach((input) => {
      input.checked = input.value === "Mon" || input.value === "Wed"
    })
    app?.querySelector(".settings-form")?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
    await settle()
    app?.querySelector('button[data-action="reapply"]')?.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    expect(app?.textContent).toContain("schedule.day.Tue")
    app
      ?.querySelector('button[data-action="keep-local-conflicts"]')
      ?.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    expect(serverSettings.schedule.days).toEqual(["Mon", "Wed"])
    expect(serverSettings.schedule.halfDays ?? []).toEqual([])

    serverSettings = {
      ...serverSettings,
      configurationVersion: serverSettings.configurationVersion + 1,
      schedule: { ...serverSettings.schedule, days: ["Mon", "Tue"], halfDays: [] },
    }
    app?.querySelector('button[data-action="reload"]')?.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    dayConflictNextSave = true
    const conflictingDays = [...(app?.querySelectorAll('input[name="days"]') ?? [])] as unknown as {
      value: string
      checked: boolean
    }[]
    conflictingDays.forEach((input) => {
      input.checked = input.value === "Mon"
    })
    const conflictingHalfDays = [...(app?.querySelectorAll('input[name="halfDays"]') ?? [])] as unknown as {
      value: string
      checked: boolean
    }[]
    conflictingHalfDays.forEach((input) => {
      input.checked = input.value === "Mon"
    })
    app?.querySelector(".settings-form")?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
    await settle()
    app?.querySelector('button[data-action="reapply"]')?.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    expect(app?.textContent).toContain("schedule.day.Mon")
    app
      ?.querySelector('button[data-action="use-latest-conflicts"]')
      ?.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    expect(app?.textContent).toContain("Choose at least one day and one meal slot.")
    const resolvedDays = [...(app?.querySelectorAll('input[name="days"]') ?? [])] as unknown as {
      value: string
      checked: boolean
    }[]
    expect(resolvedDays.every((input) => !input.checked)).toBe(true)
    const submissionsBeforeInvalidSave = submissions.length
    app?.querySelector(".settings-form")?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
    await settle()
    expect(submissions).toHaveLength(submissionsBeforeInvalidSave)
    expect(serverSettings.schedule.days).toEqual(["Tue"])
    const retryDays = [...(app?.querySelectorAll('input[name="days"]') ?? [])] as unknown as {
      value: string
      checked: boolean
    }[]
    const tue = retryDays.find((input) => input.value === "Tue")
    if (!tue) throw new Error("missing Tuesday selection")
    tue.checked = true
    const retrySubmissionCount = submissions.length
    const retryVersion = serverSettings.configurationVersion
    app?.querySelector(".settings-form")?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
    await settle()
    expect(submissions).toHaveLength(retrySubmissionCount + 1)
    expect(serverSettings.configurationVersion).toBe(retryVersion + 1)
    expect(serverSettings.schedule.days).toEqual(["Tue"])

    conflictSequence = 2
    const localExclusions = app?.querySelector('[data-setting="dietaryExclusions"]') as unknown as { value: string }
    localExclusions.value = "egg\nsesame"
    app?.querySelector(".settings-form")?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
    await settle()
    app?.querySelector('button[data-action="reapply"]')?.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    expect(serverSettings.profile.sensoryGuidelines).toEqual(["Remote revision 2"])
    app?.querySelector('button[data-action="reapply"]')?.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    expect(serverSettings.profile.sensoryGuidelines).toEqual(["Remote revision 2"])
    expect(serverSettings.profile.dietaryExclusions).toEqual(["egg", "sesame"])

    const reviewNavigation = window.document.createElement("button")
    reviewNavigation.textContent = "Back to meal plan"
    app?.querySelector(".settings-card .head-main")?.append(reviewNavigation)
    delayNextSave = true
    const delayedExclusions = app?.querySelector('[data-setting="dietaryExclusions"]') as unknown as {
      value: string
      disabled: boolean
    }
    delayedExclusions.value = "egg\nsesame\npeanut"
    app?.querySelector(".settings-form")?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
    await settle()
    expect(delayedExclusions.disabled).toBe(true)
    const reloadWhileSaving = app?.querySelector('button[data-action="reload"]') as unknown as { disabled: boolean }
    expect(reloadWhileSaving.disabled).toBe(true)
    expect(reviewNavigation.disabled).toBe(true)
    expect(delayedSave.release).toBeDefined()
    delayedSave.release?.()
    await settle()
    expect(serverSettings.profile.dietaryExclusions).toEqual(["egg", "sesame", "peanut"])
    const savedExclusions = app?.querySelector('[data-setting="dietaryExclusions"]') as unknown as { value: string }
    expect(savedExclusions.value).toContain("peanut")

    delayNextSave = true
    savedExclusions.value = "egg\nsesame\npeanut\nwalnut"
    app?.querySelector(".settings-form")?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
    await settle()
    window.dispatchEvent(new window.Event("popstate"))
    await settle()
    expect(app?.textContent).toContain("Rice")
    app?.querySelector(".settings-open")?.dispatchEvent(new window.Event("click"))
    await settle()
    const reopenedDuringSave = app?.querySelector('[data-setting="dietaryExclusions"]') as unknown as { value: string }
    const reopenedValueBeforeLateSuccess = reopenedDuringSave.value
    delayedSave.release?.()
    await settle()
    expect(app?.textContent).not.toContain("Settings saved.")
    const reopenedAfterLateSuccess = app?.querySelector('[data-setting="dietaryExclusions"]') as unknown as {
      value: string
    } | null
    expect(reopenedAfterLateSuccess?.value).toBe(reopenedValueBeforeLateSuccess)
    reopenedDuringSave.value = "egg\nsesame\nmacadamia"
    const staleViewSubmissionCount = submissions.length
    app?.querySelector(".settings-form")?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
    await settle()
    expect(submissions).toHaveLength(staleViewSubmissionCount + 1)
    expect(submissions.at(-1)?.expectedVersion).toBe(serverSettings.configurationVersion - 1)
    expect(app?.textContent).toContain("changed in another session")
    app?.querySelector('button[data-action="reapply"]')?.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    expect(app?.textContent).toContain("profile.dietaryExclusions")
    app
      ?.querySelector('button[data-action="keep-local-conflicts"]')
      ?.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    expect(serverSettings.profile.dietaryExclusions).toEqual(["egg", "sesame", "macadamia"])
    app?.querySelector(".settings-card .head button")?.dispatchEvent(new window.Event("click"))
    await settle()

    const assertLateFailurePreservesPlanAndDraft = async (
      outcome: "conflict" | "server-error" | "network-error",
      retainedValue: string,
    ) => {
      if (!app?.querySelector(".settings-open")) {
        app?.querySelector(".settings-card .head button")?.dispatchEvent(new window.Event("click"))
        await settle()
      }
      app?.querySelector(".settings-open")?.dispatchEvent(new window.Event("click"))
      await settle()
      if (app?.querySelector('button[data-action="reapply"]')) {
        app.querySelector('button[data-action="reapply"]')?.dispatchEvent(new window.Event("click", { bubbles: true }))
        await settle()
        app
          .querySelector('button[data-action="keep-local-conflicts"]')
          ?.dispatchEvent(new window.Event("click", { bubbles: true }))
        await settle()
      }
      const field = app?.querySelector('[data-setting="dietaryExclusions"]') as unknown as { value: string }
      field.value = `egg\nsesame\npeanut\n${retainedValue}`
      lateSaveOutcome = outcome
      delayNextSave = true
      app
        ?.querySelector(".settings-form")
        ?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
      await settle()
      window.dispatchEvent(new window.Event("popstate"))
      await settle()
      expect(app?.textContent).toContain("Rice")
      delayedSave.release?.()
      await settle()
      expect(app?.textContent).toContain("Rice")
      app?.querySelector(".settings-open")?.dispatchEvent(new window.Event("click"))
      await settle()
      const reopened = app?.querySelector('[data-setting="dietaryExclusions"]') as unknown as { value: string }
      expect(reopened.value).toContain(retainedValue)
      const reopenedSave = app?.querySelector(".settings-save") as unknown as { disabled: boolean }
      if (outcome === "conflict") {
        expect(reopenedSave.disabled).toBe(true)
        expect(app?.querySelector('button[data-action="reapply"]')).not.toBeNull()
      } else {
        expect(reopenedSave.disabled).toBe(false)
      }
    }
    await assertLateFailurePreservesPlanAndDraft("conflict", "walnut")
    expect(serverSettings.profile.pantryBaseline).toEqual(["oats"])
    app?.querySelector('button[data-action="add-policy"]')?.dispatchEvent(new window.Event("click", { bubbles: true }))
    expect(app?.querySelector('button[data-action="reapply"]')).not.toBeNull()
    const policyInstructions = app?.querySelectorAll('[data-policy="value"]') ?? []
    const newPolicyInstruction = policyInstructions[policyInstructions.length - 1] as unknown as { value: string }
    newPolicyInstruction.value = "Keep the plan simple"
    app?.querySelector('button[data-action="reapply"]')?.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    expect(app?.textContent).toContain("Settings saved.")
    await assertLateFailurePreservesPlanAndDraft("server-error", "cashew")
    await assertLateFailurePreservesPlanAndDraft("network-error", "almond")

    const discardedDraft = app?.querySelector('[data-setting="dietaryExclusions"]') as unknown as { value: string }
    discardedDraft.value = "egg\nsesame\npeanut\ndiscard-me"
    lateSaveOutcome = "server-error"
    delayNextSave = true
    app?.querySelector(".settings-form")?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
    await settle()
    delayedSave.release?.()
    await settle()
    app?.querySelector('button[data-action="reload"]')?.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    const reloadedDraft = app?.querySelector('[data-setting="dietaryExclusions"]') as unknown as { value: string }
    expect(reloadedDraft.value).not.toContain("discard-me")
    window.dispatchEvent(new window.Event("popstate"))
    await settle()
    app?.querySelector(".settings-open")?.dispatchEvent(new window.Event("click"))
    await settle()
    const reopenedAfterReload = app?.querySelector('[data-setting="dietaryExclusions"]') as unknown as { value: string }
    expect(reopenedAfterReload.value).not.toContain("discard-me")

    const firstPendingSaveIndex = delayedSave.releases.length
    const olderSaveField = app?.querySelector('[data-setting="dietaryExclusions"]') as unknown as { value: string }
    olderSaveField.value = "egg\nsesame\nolder save"
    delayNextSave = true
    app?.querySelector(".settings-form")?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
    await settle()
    expect(delayedSave.releases).toHaveLength(firstPendingSaveIndex + 1)
    const releaseOlderSave = delayedSave.releases[firstPendingSaveIndex]
    window.dispatchEvent(new window.Event("popstate"))
    await settle()
    app?.querySelector(".settings-open")?.dispatchEvent(new window.Event("click"))
    await settle()
    const newerSaveField = app?.querySelector('[data-setting="dietaryExclusions"]') as unknown as { value: string }
    newerSaveField.value = "egg\nsesame\nnewer save"
    delayNextSave = true
    app?.querySelector(".settings-form")?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
    await settle()
    expect(delayedSave.releases).toHaveLength(firstPendingSaveIndex + 2)
    lateSaveOutcome = "server-error"
    delayedSave.releases[firstPendingSaveIndex + 1]?.()
    await settle()
    expect(app?.textContent).toContain("Settings could not be saved.")
    lateSaveOutcome = "server-error"
    releaseOlderSave?.()
    await settle()
    window.dispatchEvent(new window.Event("popstate"))
    await settle()
    app?.querySelector(".settings-open")?.dispatchEvent(new window.Event("click"))
    await settle()
    const retainedNewerSave = app?.querySelector('[data-setting="dietaryExclusions"]') as unknown as { value: string }
    expect(retainedNewerSave.value).toBe("egg\nsesame\nnewer save")
  })

  it("keeps state and settings views when earlier plan or feedback operations finish late", async () => {
    const { window } = parseHTML('<main id="app"><div class="status">Loading your plan…</div></main>')
    const location = new URL("https://kipp.example/mini-app")
    Object.defineProperty(window, "location", { value: location, configurable: true })
    Object.defineProperty(window, "Telegram", {
      value: { WebApp: { initData: "signed-launch-data", ready: vi.fn(), expand: vi.fn() } },
      configurable: true,
    })
    const plan = {
      planId: "plan-feedback-removal",
      version: 1,
      weekStart: "2026-09-27T18:30:00.000Z",
      timezone: "Asia/Kolkata",
      schedule: { days: ["Mon"], slots: [{ id: "lunch", name: "Lunch" }] },
      candidate: { grid: { Mon: { lunch: { dish: "Rice", items: ["Rice"] } } }, easyBuys: [] },
      weeklyExceptions: { items: [] },
    }
    const profile = JSON.parse(JSON.stringify(SEED_PROFILE)) as MealProfile
    const schedule = JSON.parse(JSON.stringify(SEED_SCHEDULE)) as MealSchedule
    const settings = {
      configurationVersion: 1,
      profile,
      customPolicies: [],
      schedule,
      location: null,
      eligibleEstablishedMeals: Object.fromEntries(
        schedule.slots.map((slot) => [
          slot.id,
          (profile.mealDefinitions ?? [])
            .filter((definition) => definition.status === "established" && definition.suitableSlots.includes(slot.id))
            .map((definition) => definition.id),
        ]),
      ),
    }
    const storedDraft = JSON.stringify([{ target: { kind: "plan" }, text: "Use less salt" }])
    const localStorage = {
      getItem: (key: string) => (key === "kipp-meal-drafts:plan-feedback-removal:v1" ? storedDraft : null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    }
    const client = window as unknown as { fetch: typeof fetch; MutationObserver: typeof window.MutationObserver }
    let delayProfileGet = false
    const delayedProfile = { release: undefined as (() => void) | undefined }
    client.fetch = async (input) => {
      const path = String(input)
      if (path === "/mini-app/api/session")
        return new Response(JSON.stringify({ token: "session-token" }), { status: 201 })
      if (path === "/mini-app/api/plan") return new Response(JSON.stringify({ status: "current", plan, history: [] }))
      if (path === "/mini-app/api/profile") {
        if (delayProfileGet) {
          delayProfileGet = false
          await new Promise<void>((resolve) => {
            delayedProfile.release = resolve
          })
        }
        return new Response(JSON.stringify(settings))
      }
      return new Response(JSON.stringify({ error: "unexpected_request" }), { status: 404 })
    }
    const scripts = [...MINI_APP_SHELL.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1])
    const context = {
      window,
      document: window.document,
      MutationObserver: client.MutationObserver,
      Event: window.Event,
      Response,
      URL,
      fetch: (...args: Parameters<typeof fetch>) => client.fetch(...args),
      localStorage,
    }
    scripts.forEach((script) => {
      runInNewContext(script, context)
    })
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
    await settle()
    const app = window.document.getElementById("app")
    expect(app?.querySelector(".draft button")?.textContent).toBe("Remove")

    delayProfileGet = true
    app?.querySelector(".draft button")?.dispatchEvent(new window.Event("click", { bubbles: true }))
    app?.querySelector(".settings-open")?.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    expect(delayedProfile.release).toBeDefined()
    expect(app?.querySelector(".status")?.textContent).toBe("Loading household settings…")
    delayedProfile.release?.()
    await settle()
    expect(app?.querySelector(".settings-form")).not.toBeNull()
    expect(localStorage.removeItem).toHaveBeenCalledWith("kipp-meal-drafts:plan-feedback-removal:v1")
  })

  it("keeps delayed feedback add and submit callbacks inside their originating view", async () => {
    const { window } = parseHTML('<main id="app"><div class="status">Loading your plan…</div></main>')
    const location = new URL("https://kipp.example/mini-app")
    Object.defineProperty(window, "location", { value: location, configurable: true })
    const originalDraftKey = "kipp-meal-drafts:plan-delayed-feedback:v1"
    const otherPlanDraftKey = "kipp-meal-drafts:plan-other:v1"
    const otherPlanDrafts = JSON.stringify({
      drafts: [{ target: { kind: "plan" }, text: "Keep the other plan feedback" }],
      idempotencyKey: "other-plan-feedback",
    })
    const savedDrafts = new Map<string, string>([[otherPlanDraftKey, otherPlanDrafts]])
    let delayNextDraftWrite = false
    let delayNextProfileGet = false
    let delayNextFeedback = false
    const delayedDraftWrite = { release: undefined as (() => void) | undefined }
    const delayedProfile = { release: undefined as (() => void) | undefined }
    const delayedFeedback = { release: undefined as (() => void) | undefined }
    const storage = {
      getItem: (key: string, callback: (error: Error | null, value?: string) => void) =>
        callback(null, savedDrafts.get(key) ?? "[]"),
      setItem: (_key: string, value: string, callback: (error?: Error | null) => void) => {
        if (delayNextDraftWrite) {
          delayNextDraftWrite = false
          delayedDraftWrite.release = () => {
            savedDrafts.set(_key, value)
            callback(null)
          }
          return
        }
        savedDrafts.set(_key, value)
        callback(null)
      },
      removeItem: (_key: string, callback: (error?: Error | null) => void) => {
        savedDrafts.delete(_key)
        callback(null)
      },
    }
    const close = vi.fn()
    Object.defineProperty(window, "Telegram", {
      value: {
        WebApp: { initData: "signed-launch-data", ready: vi.fn(), expand: vi.fn(), close, DeviceStorage: storage },
      },
      configurable: true,
    })
    const planFor = (planId: string) => ({
      planId,
      version: 1,
      weekStart: "2026-09-27T18:30:00.000Z",
      timezone: "Asia/Kolkata",
      schedule: { days: ["Mon"], slots: [{ id: "lunch", name: "Lunch" }] },
      candidate: { grid: { Mon: { lunch: { dish: "Rice", items: ["Rice"] } } }, easyBuys: [] },
      weeklyExceptions: { items: [] },
    })
    const plan = planFor("plan-delayed-feedback")
    const otherPlan = planFor("plan-other")
    let showOtherPlan = false
    const profile = JSON.parse(JSON.stringify(SEED_PROFILE)) as MealProfile
    const schedule = JSON.parse(JSON.stringify(SEED_SCHEDULE)) as MealSchedule
    const settings = {
      configurationVersion: 1,
      profile,
      customPolicies: [],
      schedule,
      location: null,
      eligibleEstablishedMeals: Object.fromEntries(
        schedule.slots.map((slot) => [
          slot.id,
          (profile.mealDefinitions ?? [])
            .filter((definition) => definition.status === "established" && definition.suitableSlots.includes(slot.id))
            .map((definition) => definition.id),
        ]),
      ),
    }
    const client = window as unknown as { fetch: typeof fetch; MutationObserver: typeof window.MutationObserver }
    client.fetch = async (input) => {
      const path = String(input)
      if (path === "/mini-app/api/session")
        return new Response(JSON.stringify({ token: "session-token" }), { status: 201 })
      if (path.startsWith("/mini-app/api/plan")) {
        const selectedPlan = showOtherPlan ? otherPlan : plan
        return new Response(JSON.stringify({ status: "current", plan: selectedPlan, history: [] }))
      }
      if (path === "/mini-app/api/profile") {
        if (delayNextProfileGet) {
          delayNextProfileGet = false
          await new Promise<void>((resolve) => {
            delayedProfile.release = resolve
          })
        }
        return new Response(JSON.stringify(settings))
      }
      if (path === "/mini-app/api/feedback") {
        if (delayNextFeedback) {
          delayNextFeedback = false
          await new Promise<void>((resolve) => {
            delayedFeedback.release = resolve
          })
        }
        return new Response(JSON.stringify({ status: "accepted" }), { status: 202 })
      }
      return new Response(JSON.stringify({ error: "unexpected_request" }), { status: 404 })
    }
    let delayedClose: (() => void) | undefined
    const scripts = [...MINI_APP_SHELL.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1])
    const context = {
      window,
      document: window.document,
      MutationObserver: client.MutationObserver,
      Event: window.Event,
      Response,
      URL,
      fetch: (...args: Parameters<typeof fetch>) => client.fetch(...args),
      setTimeout: (callback: () => void) => {
        delayedClose = callback
        return 1
      },
      crypto: { randomUUID: () => "feedback-id" },
      localStorage: { getItem: () => null },
    }
    scripts.forEach((script) => {
      runInNewContext(script, context)
    })
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
    await settle()
    const app = window.document.getElementById("app")

    app?.querySelector(".meal button")?.dispatchEvent(new window.Event("click", { bubbles: true }))
    const addSheet = window.document.querySelector(".sheet")
    const feedbackText = addSheet?.querySelector("textarea") as unknown as { value: string }
    feedbackText.value = "Make the lunch less salty"
    delayNextDraftWrite = true
    ;[...(addSheet?.querySelectorAll("button") ?? [])]
      .find((button) => button.textContent === "Add feedback")
      ?.dispatchEvent(new window.Event("click", { bubbles: true }))
    expect(delayedDraftWrite.release).toBeDefined()
    delayNextProfileGet = true
    app?.querySelector(".settings-open")?.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    expect(delayedProfile.release).toBeDefined()
    delayedDraftWrite.release?.()
    await settle()
    expect(app?.querySelector(".status")?.textContent).toBe("Loading household settings…")
    delayedProfile.release?.()
    await settle()
    expect(app?.querySelector(".settings-form")).not.toBeNull()

    app?.querySelector(".settings-card .head button")?.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    expect(app?.querySelector(".draft")).not.toBeNull()
    delayNextFeedback = true
    app
      ?.querySelectorAll(".drafts button")
      .item(1)
      ?.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    expect(delayedFeedback.release).toBeDefined()
    window.dispatchEvent(new window.Event("popstate"))
    await settle()
    app?.querySelector(".settings-open")?.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    const otherPlanDraftStorage = savedDrafts.get(otherPlanDraftKey)
    showOtherPlan = true
    window.dispatchEvent(new window.Event("kipp:plan-load"))
    await settle()
    expect(app?.textContent).toContain("Keep the other plan feedback")
    delayedFeedback.release?.()
    await settle()
    expect(app?.querySelector(".draft")?.textContent).toContain("Keep the other plan feedback")
    expect(savedDrafts.has(originalDraftKey)).toBe(false)
    expect(savedDrafts.get(otherPlanDraftKey)).toBe(otherPlanDraftStorage)
    expect(app?.textContent).not.toContain("Feedback sent")

    app
      ?.querySelectorAll(".drafts button")
      .item(1)
      ?.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    expect(app?.textContent).toContain("Feedback sent — continue in Telegram.")
    expect(savedDrafts.has(otherPlanDraftKey)).toBe(false)
    expect(delayedClose).toBeDefined()
    window.dispatchEvent(new window.Event("popstate"))
    await settle()
    app?.querySelector(".settings-open")?.dispatchEvent(new window.Event("click", { bubbles: true }))
    await settle()
    delayedClose?.()
    expect(close).not.toHaveBeenCalled()
    expect(app?.querySelector(".settings-form")).not.toBeNull()
  })

  it("leaves a single week as a simple header without a redundant status", async () => {
    const { window } = parseHTML('<main id="app"><div class="status">Loading your plan…</div></main>')
    const app = window.document.getElementById("app")
    if (!app) throw new Error("missing test app")
    Object.defineProperty(window, "location", { value: { search: "" }, configurable: true })
    const client = window as unknown as { fetch: typeof fetch; MutationObserver: typeof window.MutationObserver }
    client.fetch = async () =>
      new Response(
        JSON.stringify({
          status: "current",
          plan: { planId: "plan-current" },
          history: [{ planId: "plan-current", lifecycle: "current", weekStart: "2026-09-27T18:30:00.000Z" }],
        }),
      )
    const script = MINI_APP_SHELL.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    if (!script) throw new Error("missing Mini App state script")
    runInNewContext(script, {
      window,
      document: window.document,
      MutationObserver: client.MutationObserver,
      Response,
    })

    await client.fetch("/mini-app/api/plan")
    const card = window.document.createElement("section")
    card.className = "card"
    card.innerHTML =
      '<header class="head"><div class="head-main"><h1 class="title">Week of Sep 28</h1><div class="head-action"><button class="plan-change">Change plan</button></div></div></header>'
    app.replaceChildren(card)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(app.querySelector(".title")?.textContent).toBe("Week of Sep 28")
    expect(app.querySelector(".week-select")).toBeNull()
    expect(app.querySelector(".notice")).toBeNull()
  })

  it("renders the correct date and half-day badge for a sparse Sunday custom schedule", async () => {
    const { window } = parseHTML('<main id="app"><div class="status">Loading your plan…</div></main>')
    const location = new URL("https://kipp.example/mini-app")
    Object.defineProperty(window, "location", { value: location, configurable: true })
    Object.defineProperty(window, "Telegram", {
      value: { WebApp: { initData: "signed-launch-data", ready: vi.fn(), expand: vi.fn() } },
      configurable: true,
    })
    const client = window as unknown as { fetch: typeof fetch; MutationObserver: typeof window.MutationObserver }
    const plan = {
      planId: "sunday-plan",
      version: 1,
      weekStart: "2026-09-06T18:30:00.000Z",
      timezone: "Asia/Kolkata",
      readOnly: false,
      schedule: {
        days: ["Sun"],
        halfDays: ["Sun"],
        slots: [
          {
            id: "morning-tea",
            name: "Morning tea",
            packed: true,
            dry: true,
            maxCookMinutes: null,
            halfDayBehavior: { action: "quick", maxCookMinutes: 15 },
          },
        ],
      },
      candidate: {
        grid: {
          Sun: {
            "morning-tea": {
              dish: "Banana",
              vegetarian: true,
              items: ["banana"],
              cookMinutes: 0,
              priorNightPrep: false,
            },
          },
        },
        easyBuys: [],
      },
      weeklyExceptions: { items: [] },
    }
    client.fetch = async (input) =>
      String(input) === "/mini-app/api/session"
        ? new Response(JSON.stringify({ token: "session-token" }), { status: 201 })
        : new Response(JSON.stringify({ status: "current", plan, history: [] }))
    const scripts = [...MINI_APP_SHELL.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1])
    const context = {
      window,
      document: window.document,
      MutationObserver: client.MutationObserver,
      Event: window.Event,
      Response,
      URL,
      fetch: (...args: Parameters<typeof fetch>) => client.fetch(...args),
      localStorage: { getItem: () => null },
    }
    scripts.forEach((script) => {
      runInNewContext(script, context)
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const day = window.document.querySelector(".day")
    expect(day?.querySelector("strong")?.textContent).toBe("Sun")
    expect(day?.querySelector("small")?.textContent).toBe("13")
    expect(day?.getAttribute("aria-label")).toContain("half day")
    expect(day?.querySelector(".half-day-badge")?.textContent).toBe("◐")
  })

  it("opens historical plans and returns to the current plan without replaying Telegram authentication", async () => {
    const { window } = parseHTML('<main id="app"><div class="status">Loading your plan…</div></main>')
    const location = new URL("https://kipp.example/mini-app#tgWebAppData=launch-data")
    Object.defineProperty(window, "location", { value: location, configurable: true })
    const history = {
      pushState: vi.fn((_state: unknown, _title: string, url: URL) => {
        location.href = url.href
      }),
    }
    Object.defineProperty(window, "history", { value: history })
    const telegram = { WebApp: { initData: "signed-launch-data", ready: vi.fn(), expand: vi.fn() } }
    Object.defineProperty(window, "Telegram", { value: telegram, configurable: true })
    const storage = { getItem: vi.fn(() => null) }
    const client = window as unknown as { fetch: typeof fetch; MutationObserver: typeof window.MutationObserver }
    const plan = (planId: string) => ({
      planId,
      version: 1,
      weekStart: planId === "plan-old" ? "2026-09-20T18:30:00.000Z" : "2026-09-27T18:30:00.000Z",
      timezone: "Asia/Kolkata",
      schedule: { days: ["Monday"], slots: [{ id: "lunch", name: "Lunch" }] },
      candidate: { grid: { Monday: { lunch: { dish: "Rice", items: ["Rice"] } } }, easyBuys: [] },
      weeklyExceptions: { items: [] },
    })
    const entries = [
      { planId: "plan-current", lifecycle: "current", weekStart: "2026-09-27T18:30:00.000Z" },
      { planId: "plan-old", lifecycle: "historical", weekStart: "2026-09-20T18:30:00.000Z" },
    ]
    const calls: string[] = []
    let planRequestCount = 0
    const delayedInitialPlan = { release: undefined as (() => void) | undefined }
    let generating = false
    let firstPlanGenerating = false
    client.fetch = async (input) => {
      const path = String(input)
      calls.push(path)
      if (path === "/mini-app/api/session")
        return new Response(JSON.stringify({ token: "session-token" }), { status: 201 })
      const selected = new URL(path, location.origin).searchParams.get("planId")
      const historical = selected === "plan-old"
      if (!historical && planRequestCount++ === 0) {
        await new Promise<void>((resolve) => {
          delayedInitialPlan.release = resolve
        })
        return new Response(
          JSON.stringify({ status: "generating", currentPlan: plan("plan-current"), history: entries }),
        )
      }
      return new Response(
        JSON.stringify({
          status: historical ? "historical" : firstPlanGenerating || generating ? "generating" : "current",
          plan: historical ? plan("plan-old") : firstPlanGenerating || generating ? undefined : plan("plan-current"),
          currentPlan: firstPlanGenerating ? null : generating && !historical ? plan("plan-current") : undefined,
          history: firstPlanGenerating ? [] : entries,
        }),
      )
    }
    const scripts = [...MINI_APP_SHELL.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1])
    expect(scripts).toHaveLength(2)
    const context = {
      window,
      document: window.document,
      MutationObserver: client.MutationObserver,
      Event: window.Event,
      Response,
      URL,
      fetch: (...args: Parameters<typeof fetch>) => client.fetch(...args),
      localStorage: storage,
    }
    scripts.forEach((script) => {
      runInNewContext(script, context)
    })
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
    await settle()
    const app = window.document.getElementById("app")
    expect(delayedInitialPlan.release).toBeDefined()
    window.dispatchEvent(new window.Event("popstate"))
    await settle()
    expect(app?.querySelector(".read-only-indicator")).toBeNull()
    delayedInitialPlan.release?.()
    await settle()
    app?.append(window.document.createElement("span"))
    await settle()
    expect(app?.querySelector(".notice")).toBeNull()
    expect(app?.querySelector(".read-only-indicator")).toBeNull()
    expect(app?.querySelector(".plan-change")?.hidden).toBe(false)
    const selectedWeek = () => {
      const select = app?.querySelector(".week-select") as unknown as {
        value: string
        querySelectorAll: typeof app.querySelectorAll
      } | null
      return [...(select?.querySelectorAll("option") ?? [])].find((option) => option.value === select?.value)
        ?.textContent
    }
    expect(app?.querySelector(".title")?.firstChild?.textContent).toBe("Week of ")
    expect(selectedWeek()).toBe("Sep 28")
    expect([...(app?.querySelectorAll(".week-select option") ?? [])].map((option) => option.textContent)).toEqual([
      "Sep 28",
      "Sep 21",
    ])
    expect(app?.querySelector(".history")).toBeNull()
    expect(app?.querySelector(".notice")).toBeNull()
    expect(app?.querySelector(".read-only-indicator")).toBeNull()
    expect(app?.querySelector(".plan-change")?.hidden).toBe(false)
    expect(app?.querySelector(".meal button")?.hidden).toBe(false)
    const choose = (planId: string) => {
      const select = app?.querySelector(".week-select")
      if (!select) throw new Error("missing week selector")
      const options = [...select.querySelectorAll("option")]
      for (const option of options) option.selected = false
      const chosen = options.find((option) => option.value === planId)
      if (!chosen) throw new Error("missing plan option")
      chosen.selected = true
      select.dispatchEvent(new window.Event("change"))
    }

    choose("plan-old")
    await settle()
    expect(location.search).toBe("?planId=plan-old")
    expect(location.hash).toBe("#tgWebAppData=launch-data")
    expect(selectedWeek()).toBe("Sep 21")
    expect(app?.querySelector(".notice")).toBeNull()
    expect(app?.querySelector(".read-only-indicator")?.getAttribute("aria-label")).toBe("Read-only plan")
    expect(app?.querySelector(".plan-change")?.hidden).toBe(true)
    expect(app?.querySelector(".meal button")?.hidden).toBe(true)

    choose("plan-current")
    await settle()
    expect(location.search).toBe("")
    expect(selectedWeek()).toBe("Sep 28")
    expect(app?.querySelector(".read-only-indicator")).toBeNull()
    expect(app?.querySelector(".meal button")?.hidden).toBe(false)
    location.search = "?planId=plan-old"
    window.dispatchEvent(new window.Event("popstate"))
    await settle()
    expect(selectedWeek()).toBe("Sep 21")
    generating = true
    choose("plan-current")
    await settle()
    expect(app?.querySelector(".notice")?.textContent).toContain("A new plan is being generated")
    const callsBeforeRefresh = calls.length
    app?.querySelector(".refresh-plan")?.click()
    await settle()
    expect(calls).toHaveLength(callsBeforeRefresh + 1)
    firstPlanGenerating = true
    window.dispatchEvent(new window.Event("kipp:plan-load"))
    await settle()
    expect(app?.textContent).toContain("Your first meal plan is being generated")
    const callsBeforeFirstPlanRefresh = calls.length
    app?.querySelector(".generating-empty button")?.click()
    await settle()
    expect(calls).toHaveLength(callsBeforeFirstPlanRefresh + 1)
    expect(calls.filter((path) => path === "/mini-app/api/session")).toHaveLength(1)
    expect(calls).toContain("/mini-app/api/plan?planId=plan-old")
    expect(history.pushState).toHaveBeenCalledTimes(3)
  })

  it("serves a plan created for next week until its own week ends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(FAKE_NOW)
    try {
      const response = await planResponse("2026-09-27T18:30:00.000Z", "2026-10-03T18:29:59.000Z")
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        status: "current",
        plan: { planId: "plan-1", weekStart: "2026-09-27T18:30:00.000Z", readOnly: false },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps an ended plan available as the current read-only-capable read model", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(FAKE_NOW)
    try {
      const response = await planResponse("2026-09-13T18:30:00.000Z", "2026-09-19T18:29:59.000Z")
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        status: "current",
        plan: { planId: "plan-1", weekEnd: "2026-09-19T18:29:59.000Z", readOnly: false },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("returns an explicit generating state when the first plan has no prior snapshot", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(FAKE_NOW)
    try {
      const { db, d1 } = createClockedD1TestDb()
      const store = createMealPlanningStore(d1)
      await store.loadOrCreateProfile("chat-42")
      const generationId = "generation-first-plan"
      await store.startPlanGeneration({
        chatId: "chat-42",
        generationId,
        expiresAt: "2099-01-01T00:00:00.000Z",
      })
      await store.createActivePlan({
        planId: "pending-plan",
        chatId: "chat-42",
        weekStart: "2026-09-27T18:30:00.000Z",
        weekEnd: "2026-10-03T18:29:59.000Z",
        timezone: "Asia/Kolkata",
        schedule: SEED_SCHEDULE,
        establishedMealDefinitions: SEED_PROFILE.mealDefinitions ?? [],
        instanceId: "instance-pending-plan",
        generationId,
        candidate: { grid: {}, easyBuys: [], policyOutcomes: {} },
        evaluation: {
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
        },
        weeklyInventory: { items: [], notes: [] },
        weeklyExceptions: { items: [] },
      })
      await store.upsertMiniAppReviewContext({
        telegramUserId: "42",
        chatId: "chat-42",
        planId: "pending-plan",
        weekEnd: "2026-10-03T18:29:59.000Z",
      })
      await store.startPlanGeneration({
        chatId: "chat-42",
        generationId: "generation-first-plan",
        expiresAt: "2099-01-01T00:00:00.000Z",
      })
      const testEnv = { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USER_ID: "42", MEAL_PLANNING_DB: d1 } as Env
      const session = await miniAppRoutes.fetch(
        new Request("https://kipp.example/mini-app/api/session", {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: await signedInitData(),
        }),
        testEnv,
      )
      expect(session.status).toBe(201)
      const { token } = (await session.json()) as { token: string }
      db.prepare("DELETE FROM meal_plan WHERE plan_id = ?").run("pending-plan")
      await store.startPlanGeneration({
        chatId: "chat-42",
        generationId,
        expiresAt: "2099-01-01T00:00:00.000Z",
      })
      const response = await miniAppRoutes.fetch(
        new Request("https://kipp.example/mini-app/api/plan?planId=missing-plan", {
          headers: { Authorization: `Bearer ${token}` },
        }),
        testEnv,
      )
      expect(await response.json()).toMatchObject({
        status: "generating",
        currentPlan: null,
        history: [],
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("marks the current plan read-only while a replacement is generating", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(FAKE_NOW)
    try {
      const fixture = await authenticatedPlanFixture(
        "plan-generating",
        "2026-09-27T18:30:00.000Z",
        "2026-10-03T18:29:59.000Z",
      )
      await fixture.store.startPlanGeneration({
        chatId: "chat-42",
        generationId: "generation-1",
        expiresAt: "2099-01-01T00:00:00.000Z",
      })
      const response = await miniAppRoutes.fetch(
        new Request("https://kipp.example/mini-app/api/plan", {
          headers: { Authorization: `Bearer ${fixture.token}` },
        }),
        fixture.testEnv,
      )
      expect(await response.json()).toMatchObject({
        status: "generating",
        currentPlan: { planId: "plan-generating", readOnly: true },
        history: [{ planId: "plan-generating", lifecycle: "current", readOnly: true }],
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("opens the newest same-week plan for a replaced plan link and rejects feedback for the replaced plan", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(FAKE_NOW)
    try {
      const fixture = await authenticatedPlanFixture(
        "plan-replaced",
        "2026-09-27T18:30:00.000Z",
        "2026-10-03T18:29:59.000Z",
      )
      await seedPlan(fixture.store, "plan-current", "2026-09-27T18:30:00.000Z", "2026-10-03T18:29:59.000Z")
      await fixture.store.upsertMiniAppReviewContext({
        telegramUserId: "42",
        chatId: "chat-42",
        planId: "plan-current",
        weekEnd: "2026-10-03T18:29:59.000Z",
      })
      const historicalLink = await miniAppRoutes.fetch(
        new Request("https://kipp.example/mini-app/api/plan?planId=plan-replaced", {
          headers: { Authorization: `Bearer ${fixture.token}` },
        }),
        fixture.testEnv,
      )
      expect(await historicalLink.json()).toMatchObject({
        status: "current",
        plan: { planId: "plan-current", readOnly: false },
        history: [{ planId: "plan-current", lifecycle: "current" }],
      })

      const feedback = await miniAppRoutes.fetch(
        new Request("https://kipp.example/mini-app/api/feedback", {
          method: "POST",
          headers: { Authorization: `Bearer ${fixture.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            planId: "plan-replaced",
            baseVersion: 1,
            idempotencyKey: "historical-feedback",
            items: [{ id: "feedback-1", text: "Less oily", target: { kind: "plan" } }],
          }),
        }),
        fixture.testEnv,
      )
      expect(feedback.status).toBe(409)
      expect(await feedback.json()).toEqual({ error: "historical_or_stale" })
      const batches = await fixture.d1.prepare("SELECT COUNT(*) AS count FROM feedback_batch").bind().all()
      expect(batches.results?.[0]?.count).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("requires the raw init-data content type and bounds malformed feedback requests", async () => {
    const response = await miniAppRoutes.fetch(
      new Request("https://kipp.example/mini-app/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: "not-raw" }),
      }),
      env(),
    )
    expect(response.status).toBe(400)
    expect(response.headers.get("cache-control")).toBe("no-store")

    const oversized = new Request("https://kipp.example/mini-app/api/session", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "x".repeat(64 * 1_024 + 1),
    })
    expect(oversized.headers.get("content-length")).toBeNull()
    const rejected = await miniAppRoutes.fetch(oversized, env())
    expect(rejected.status).toBe(400)
  })

  it("terminalizes and notifies once when a batch has no workflow dispatch capability", async () => {
    const { db, d1 } = createClockedD1TestDb()
    const batch = {
      batchId: "mini-batch-1",
      planId: "plan-1",
      baseVersion: 1,
      items: [{ id: "mini-1", text: "Less oily", target: { kind: "plan" as const } }],
      chatId: "chat-1",
      workflowInstanceId: "wf-1",
      weekEnd: "2026-09-05T18:29:59.999Z",
      idempotencyKey: "key-1",
      status: "accepted" as const,
      failureCategory: null,
      failureNotifiedAt: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    }
    db.prepare(
      `INSERT INTO feedback_batch
         (batch_id, plan_id, base_version, items_json, idempotency_key, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?)`,
    ).run(
      batch.batchId,
      batch.planId,
      batch.baseVersion,
      JSON.stringify(batch.items),
      batch.idempotencyKey,
      batch.createdAt,
      batch.updatedAt,
    )
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })))
    vi.stubGlobal("fetch", fetchMock)
    try {
      expect(await startFeedbackBatch(batch, { ...env(), MEAL_PLANNING_DB: d1 })).toBe(false)
      const persisted = await createMealPlanningStore(d1).feedbackBatch(batch.batchId)
      expect(persisted).toMatchObject({ status: "failed", failureNotifiedAt: expect.any(String) })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("logs the workflow dispatch phase and provider error when the instance is unreachable", async () => {
    const { db, d1 } = createClockedD1TestDb()
    const batch = {
      batchId: "mini-batch-unreachable",
      planId: "plan-1",
      baseVersion: 1,
      items: [{ id: "mini-1", text: "Less oily", target: { kind: "plan" as const } }],
      chatId: null,
      workflowInstanceId: "wf-unreachable",
      weekEnd: "2026-09-05T18:29:59.999Z",
      idempotencyKey: "key-unreachable",
      status: "accepted" as const,
      failureCategory: null,
      failureNotifiedAt: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    }
    db.prepare(
      `INSERT INTO feedback_batch
         (batch_id, plan_id, base_version, items_json, idempotency_key, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?)`,
    ).run(
      batch.batchId,
      batch.planId,
      batch.baseVersion,
      JSON.stringify(batch.items),
      batch.idempotencyKey,
      batch.createdAt,
      batch.updatedAt,
    )
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const workflow = {
      create: vi.fn(async () => {
        throw new Error("workflow service unavailable")
      }),
      get: vi.fn(async () => {
        throw new Error("instance is not active")
      }),
    } as unknown as Env["MEAL_PLANNING_WORKFLOW"]
    try {
      expect(
        await startFeedbackBatch(batch, {
          ...env(),
          LOG_LEVEL: "info",
          MEAL_PLANNING_DB: d1,
          MEAL_PLANNING_WORKFLOW: workflow,
        }),
      ).toBe(false)
      const events = log.mock.calls.map(([line]) => JSON.parse(String(line)))
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "mini-app-feedback-dispatch",
            outcome: "failed",
            failureCategory: "workflow-unreachable",
            details: expect.objectContaining({ phase: "workflow-create", errorName: "Error" }),
          }),
        ]),
      )
    } finally {
      log.mockRestore()
    }
  })
})
