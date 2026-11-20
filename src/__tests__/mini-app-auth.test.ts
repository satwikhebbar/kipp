import { describe, expect, it } from "vitest"
import {
  authenticateMiniApp,
  createSettingsLaunchReference,
  verifyTelegramInitData,
} from "../meal-planning/mini-app-auth"
import { createMealPlanningStore, SEED_PROFILE, SEED_SCHEDULE } from "../meal-planning/store"
import { createD1TestDb } from "./d1-test-db"

const BOT_TOKEN = "123:bot-token"
const NOW = new Date("2026-09-01T12:00:00.000Z")
const AUTH_DATE = Math.floor(NOW.getTime() / 1_000)

async function sign(key: Uint8Array, value: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value)))
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function initData(options: { queryId?: string; userId?: number } = {}): Promise<string> {
  const params = new URLSearchParams({
    auth_date: String(AUTH_DATE),
    user: JSON.stringify({ id: options.userId ?? 42, first_name: "Parent" }),
  })
  if (options.queryId !== "") params.set("query_id", options.queryId ?? "query-1")
  const secret = await sign(new TextEncoder().encode("WebAppData"), BOT_TOKEN)
  const check = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")
  params.set("hash", toHex(await sign(secret, check)))
  return params.toString()
}

describe("Mini App Telegram authentication", () => {
  it("verifies the canonical HMAC and rejects tampering or stale launches", async () => {
    const raw = await initData()
    await expect(verifyTelegramInitData(raw, BOT_TOKEN, AUTH_DATE)).resolves.toMatchObject({ userId: "42" })
    await expect(verifyTelegramInitData(`${raw.slice(0, -1)}0`, BOT_TOKEN, AUTH_DATE)).rejects.toMatchObject({
      reason: "invalid",
    })
    await expect(verifyTelegramInitData(raw, BOT_TOKEN, AUTH_DATE + 601)).rejects.toMatchObject({ reason: "expired" })
  })

  it("creates a scoped session once and rejects replayed init data", async () => {
    const { d1 } = createD1TestDb()
    const store = createMealPlanningStore(d1)
    await store.loadOrCreateProfile("chat-42")
    await store.startPlanGeneration({
      chatId: "chat-42",
      generationId: "generation-1",
      expiresAt: "2999-01-01T00:00:00.000Z",
    })
    await store.createActivePlan({
      planId: "plan-1",
      chatId: "chat-42",
      weekStart: "2026-08-31T00:00:00.000Z",
      weekEnd: "2026-09-05T23:59:59.000Z",
      timezone: "Asia/Kolkata",
      schedule: SEED_SCHEDULE,
      establishedMealDefinitions: SEED_PROFILE.mealDefinitions ?? [],
      instanceId: "instance-1",
      generationId: "generation-1",
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
      planId: "plan-1",
      weekEnd: "2026-09-05T23:59:59.000Z",
    })
    const env = { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USER_ID: "42", MEAL_PLANNING_DB: d1 }
    const raw = await initData()
    await expect(authenticateMiniApp(raw, env, NOW)).resolves.toMatchObject({ context: { chatId: "chat-42" } })
    const reordered = [...new URLSearchParams(raw).entries()]
      .reverse()
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join("&")
    await expect(authenticateMiniApp(reordered, env, NOW)).rejects.toMatchObject({ reason: "replayed" })
  })

  it("creates a settings-only session from signed inline-button initData before any plan exists", async () => {
    const { d1 } = createD1TestDb()
    const env = { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USER_ID: "42", MEAL_PLANNING_DB: d1 }
    const store = createMealPlanningStore(d1)
    await store.loadOrCreateProfile("42")
    const { reference } = await createSettingsLaunchReference("42", "42", env, NOW)
    const result = await authenticateMiniApp(await initData(), env, NOW, reference)
    expect(result.context).toBeNull()
    expect(result.session).toMatchObject({ telegramUserId: "42", chatId: "42", planId: null, scope: "settings" })
    expect(await store.activePlan("42")).toBeNull()
    await expect(authenticateMiniApp(await initData(), env, NOW, reference)).rejects.toMatchObject({
      reason: "unauthorized",
    })
  })

  it("rejects missing, expired, replayed and user-mismatched settings references", async () => {
    const { d1 } = createD1TestDb()
    const env = { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USER_ID: "42", MEAL_PLANNING_DB: d1 }
    await expect(authenticateMiniApp(await initData(), env, NOW)).rejects.toMatchObject({ reason: "unauthorized" })
    await expect(authenticateMiniApp(await initData({ queryId: "" }), env, NOW, "missing-query")).rejects.toMatchObject(
      {
        reason: "invalid",
      },
    )

    const expired = await createSettingsLaunchReference("42", "42", env, new Date(NOW.getTime() - 601_000))
    await expect(authenticateMiniApp(await initData(), env, NOW, expired.reference)).rejects.toMatchObject({
      reason: "unauthorized",
    })

    const mismatched = await createSettingsLaunchReference("43", "43", env, NOW)
    await expect(authenticateMiniApp(await initData(), env, NOW, mismatched.reference)).rejects.toMatchObject({
      reason: "unauthorized",
    })

    const replay = await createSettingsLaunchReference("42", "42", env, NOW)
    const raw = await initData()
    const accepted = await authenticateMiniApp(raw, env, NOW, replay.reference)
    expect(accepted.session.scope).toBe("settings")
    const newLaunch = await createSettingsLaunchReference("42", "42", env, NOW)
    await expect(authenticateMiniApp(raw, env, NOW, newLaunch.reference)).rejects.toMatchObject({ reason: "replayed" })
    await expect(
      authenticateMiniApp(await initData({ queryId: "query-after-replay" }), env, NOW, newLaunch.reference),
    ).resolves.toMatchObject({ session: { scope: "settings" } })
  })

  it("keeps replay protection through the final accepted init-data second", async () => {
    const { d1 } = createD1TestDb()
    const env = { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USER_ID: "42", MEAL_PLANNING_DB: d1 }
    const raw = await initData()
    const firstLaunch = await createSettingsLaunchReference("42", "42", env, NOW)
    await authenticateMiniApp(raw, env, NOW, firstLaunch.reference)

    // This unused reference remains valid until one second after the auth-data boundary.
    const unusedLaunch = await createSettingsLaunchReference("42", "42", env, new Date(NOW.getTime() + 1_000))
    await expect(
      authenticateMiniApp(raw, env, new Date(NOW.getTime() + 599_999), unusedLaunch.reference),
    ).rejects.toMatchObject({ reason: "replayed" })
    await expect(
      authenticateMiniApp(raw, env, new Date(NOW.getTime() + 600_000), unusedLaunch.reference),
    ).rejects.toMatchObject({ reason: "replayed" })
  })

  it("keeps a settings launch usable when session insertion fails", async () => {
    const { d1, db } = createD1TestDb()
    const env = { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USER_ID: "42", MEAL_PLANNING_DB: d1 }
    const launch = await createSettingsLaunchReference("42", "42", env, NOW)
    db.exec(`CREATE TRIGGER fail_settings_session BEFORE INSERT ON mini_app_session
      WHEN NEW.scope = 'settings' BEGIN SELECT RAISE(ABORT, 'forced settings session failure'); END`)
    await expect(
      authenticateMiniApp(await initData({ queryId: "query-failed-session" }), env, NOW, launch.reference),
    ).rejects.toThrow("forced settings session failure")
    db.exec("DROP TRIGGER fail_settings_session")
    await expect(
      authenticateMiniApp(await initData({ queryId: "query-retry-session" }), env, NOW, launch.reference),
    ).resolves.toMatchObject({ session: { scope: "settings" } })
  })
})
