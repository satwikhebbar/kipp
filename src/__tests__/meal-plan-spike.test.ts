import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../linkedin/workflow", () => ({ PipelineWorkflow: class {} }))
vi.mock("../calendar/workflow", () => ({ CalendarWorkflow: class {} }))

import worker from "../index"
import { resetMealPlanSpikeForTests } from "../meal-plan-spike/state"

const NOW_MS = 1_700_000_000_000
const BOT_TOKEN = "test-mini-app-token"
const telegramFetch = vi.fn()

/** Generates valid signed Telegram Mini App launch data for Worker route tests. */
async function signedInitData(
  userId = 1001,
  queryId = crypto.randomUUID(),
  authDate = Math.floor(NOW_MS / 1000),
): Promise<string> {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: queryId,
    user: JSON.stringify({ id: userId, first_name: "Test" }),
  })
  const stringToSign = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")
  const secret = await sign(new TextEncoder().encode("WebAppData"), new TextEncoder().encode(BOT_TOKEN))
  params.set("hash", toHex(await sign(secret, new TextEncoder().encode(stringToSign))))
  return params.toString()
}

/** Signs payload bytes with a SHA-256 HMAC using Web Crypto. */
async function sign(key: BufferSource, value: BufferSource): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return crypto.subtle.sign("HMAC", cryptoKey, value)
}

/** Converts bytes to the hexadecimal encoding Telegram uses for init-data hashes. */
function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** Creates a minimal Worker environment for Mini App endpoint tests. */
function env() {
  return { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USER_ID: "1001" }
}

/** Makes a Mini App API request against the Worker fetch handler. */
async function request(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`https://example.test${path}`, init), env() as never, {} as ExecutionContext)
}

/** Starts one authenticated Mini App session and returns its bearer token. */
async function session(userId = 1001): Promise<string> {
  const response = await request("/api/mini-app/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData: await signedInitData(userId) }),
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as { sessionToken: string }).sessionToken
}

describe("throwaway Mini App feedback routes", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
    telegramFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 1 } }) })
    vi.stubGlobal("fetch", telegramFetch)
    resetMealPlanSpikeForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("serves a normal-browser diagnostic without protected mock data", async () => {
    const page = await request("/mini-app")
    expect(page.status).toBe(200)
    expect(await page.text()).toContain("Telegram authentication required")
    const persistedDraftPage = await request("/mini-app")
    expect(await persistedDraftPage.text()).toContain("DeviceStorage")

    const protectedPlan = await request("/api/mini-app/plan")
    expect(protectedPlan.status).toBe(401)
  })

  it("accepts valid signed init data and reads the versioned mock plan", async () => {
    const token = await session()
    const response = await request("/api/mini-app/plan", { headers: { authorization: `Bearer ${token}` } })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { plan: { version: number; days: unknown[] } }
    expect(body.plan.version).toBe(1)
    expect(body.plan.days).toHaveLength(6)
  })

  it("rejects malformed, expired, replayed, and unauthorized launches", async () => {
    const malformed = await request("/api/mini-app/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: "not-signed" }),
    })
    expect(malformed.status).toBe(401)

    const expired = await request("/api/mini-app/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: await signedInitData(1001, "expired", Math.floor(NOW_MS / 1000) - 601) }),
    })
    expect(expired.status).toBe(401)

    const initData = await signedInitData(1001, "replayed")
    const first = await request("/api/mini-app/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData }),
    })
    const replay = await request("/api/mini-app/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData }),
    })
    expect(first.status).toBe(200)
    expect(replay.status).toBe(401)

    const denied = await request("/api/mini-app/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: await signedInitData(2002) }),
    })
    expect(denied.status).toBe(403)
  })

  it("hands one finalized batch to Telegram without replacing the active plan", async () => {
    const token = await session()
    const input = {
      feedback: [
        { dayId: "mon", mealId: "dinner", text: "Make this faster" },
        { dayId: "tue", mealId: "lunch", text: "Use fewer dishes" },
      ],
      baseVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    }
    const save = () =>
      request("/api/mini-app/feedback", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(input),
      })
    const first = await save()
    const second = await save()
    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    expect((await first.json()) as { acceptedFeedbackCount: number }).toEqual({ acceptedFeedbackCount: 2 })
    expect(telegramFetch).toHaveBeenCalledTimes(1)
    expect(telegramFetch).toHaveBeenCalledWith(
      expect.stringContaining("sendMessage"),
      expect.objectContaining({ body: expect.stringContaining("which change matters most") }),
    )
    const plan = await request("/api/mini-app/plan", { headers: { authorization: `Bearer ${token}` } })
    expect(((await plan.json()) as { plan: { version: number } }).plan.version).toBe(1)
  })

  it("returns a conflict without mutating a stale plan", async () => {
    const secondToken = await session()
    const save = (token: string, idempotencyKey: string, baseVersion: number) =>
      request("/api/mini-app/feedback", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          feedback: [{ dayId: "tue", mealId: "lunch", text: "A change" }],
          baseVersion,
          idempotencyKey,
        }),
      })
    const stale = await save(secondToken, crypto.randomUUID(), 2)
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as { plan: { version: number } }).plan.version).toBe(1)
  })

  it("rejects invalid feedback input and expired sessions", async () => {
    const token = await session()
    const invalid = await request("/api/mini-app/feedback", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        feedback: [{ dayId: "monday", mealId: "dinner", text: "" }],
        baseVersion: 1,
        idempotencyKey: "bad",
      }),
    })
    expect(invalid.status).toBe(400)

    vi.advanceTimersByTime(15 * 60 * 1000)
    const expired = await request("/api/mini-app/plan", { headers: { authorization: `Bearer ${token}` } })
    expect(expired.status).toBe(401)
  })
})
