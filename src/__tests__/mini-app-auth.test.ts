import { describe, expect, it } from "vitest"
import { authenticateMiniApp, verifyTelegramInitData } from "../meal-planning/mini-app-auth"
import { createMealPlanningStore } from "../meal-planning/store"
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

async function initData(): Promise<string> {
  const params = new URLSearchParams({
    auth_date: String(AUTH_DATE),
    query_id: "query-1",
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
})
