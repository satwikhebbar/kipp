import { describe, expect, it, vi } from "vitest"
import type { Env } from "../core/types"
import { miniAppRoutes, startFeedbackBatch } from "../meal-planning/mini-app-routes"
import { createMealPlanningStore } from "../meal-planning/store"
import { createD1TestDb } from "./d1-test-db"

function env(): Env {
  const { d1 } = createD1TestDb()
  return {
    MEAL_PLANNING_DB: d1,
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_ALLOWED_USER_ID: "42",
  } as Env
}

describe("Mini App HTTP boundary", () => {
  it("serves a data-free Mini App shell with ready, empty, and feedback affordances", async () => {
    const shell = await miniAppRoutes.fetch(new Request("https://kipp.example/mini-app"), env())
    expect(shell.status).toBe(200)
    expect(shell.headers.get("cache-control")).toBe("no-store")
    expect(shell.headers.get("content-type")).toBe("text/html; charset=utf-8")
    const html = await shell.text()
    expect(html).toContain("Change plan")
    expect(html).toContain("https://telegram.org/js/telegram-web-app.js")
    expect(html).toContain("Feedback ready")
    expect(html).toContain("Holiday")
    expect(html).toContain("/mealplan")
    expect(html).not.toContain("mealplan-")

    const plan = await miniAppRoutes.fetch(new Request("https://kipp.example/mini-app/api/plan"), env())
    expect(plan.status).toBe(403)
    expect(plan.headers.get("cache-control")).toBe("no-store")
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
})
