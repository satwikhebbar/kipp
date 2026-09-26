import { runInNewContext } from "node:vm"
import { parseHTML } from "linkedom"
import { describe, expect, it, vi } from "vitest"
import type { Env } from "../core/types"
import { MINI_APP_SHELL, miniAppRoutes, startFeedbackBatch } from "../meal-planning/mini-app-routes"
import { createMealPlanningStore } from "../meal-planning/store"
import type { MealGrid } from "../meal-planning/types"
import { createD1TestDb } from "./d1-test-db"

function env(): Env {
  const { d1 } = createD1TestDb()
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
  const { d1 } = createD1TestDb()
  const store = createMealPlanningStore(d1)
  await seedPlan(store, planId, weekStart, weekEnd, grid)
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
    expect(html).toContain("dayDate(i).getUTCDate()")
    expect(html).not.toContain('dateLabel(i).split(" ").slice(-1)[0]')
    expect(html).not.toContain("mealplan-")

    const plan = await miniAppRoutes.fetch(new Request("https://kipp.example/mini-app/api/plan"), env())
    expect(plan.status).toBe(403)
    expect(plan.headers.get("cache-control")).toBe("no-store")
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
    Object.defineProperty(window, "Telegram", { value: telegram })
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
    let generating = false
    let firstPlanGenerating = false
    client.fetch = async (input) => {
      const path = String(input)
      calls.push(path)
      if (path === "/mini-app/api/session")
        return new Response(JSON.stringify({ token: "session-token" }), { status: 201 })
      const selected = new URL(path, location.origin).searchParams.get("planId")
      const historical = selected === "plan-old"
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
      const { db, d1 } = createD1TestDb()
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

  it("serves a replaced plan as historical and rejects feedback for it", async () => {
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
      const historical = await miniAppRoutes.fetch(
        new Request("https://kipp.example/mini-app/api/plan?planId=plan-replaced", {
          headers: { Authorization: `Bearer ${fixture.token}` },
        }),
        fixture.testEnv,
      )
      expect(await historical.json()).toMatchObject({
        status: "historical",
        plan: { planId: "plan-replaced", readOnly: true },
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
    const { db, d1 } = createD1TestDb()
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
    const { db, d1 } = createD1TestDb()
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
            details: expect.objectContaining({ phase: "workflow-get", errorName: "Error" }),
          }),
        ]),
      )
    } finally {
      log.mockRestore()
    }
  })
})
