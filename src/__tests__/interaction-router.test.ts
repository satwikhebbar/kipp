import { beforeEach, describe, expect, it, vi } from "vitest"
import { startEditWorkflow } from "../core/edit-workflow"
import { CONSUMED_INTERACTION_RETENTION_MS, InteractionRouterDO } from "../core/interaction-router"
import { createInteractionRouter } from "../core/interaction-router-client"
import type { Env } from "../core/types"
import { INTERACTION_KIND } from "../core/types"
import { sqliteInteractionRouter } from "./fixtures/interaction-router"

const NOW = 1_000_000

interface RouterRow {
  interaction_id: string
  version: number
  workflow_id: string
  kind: string
  expires_at: number
  consumed_update_id: number | null
  interaction_group: string | null
  generation: number | null
}

function createRouter(rowFor?: { query: string; row: RouterRow } | null, maxGeneration: number | null = null) {
  const exec = vi.fn((query: string, ..._args: unknown[]) => {
    if (rowFor && query.includes(rowFor.query)) return { toArray: () => [rowFor.row] }
    if (query.includes("SELECT MAX(generation)")) return { toArray: () => [{ max_generation: maxGeneration }] }
    return { toArray: () => [] }
  })
  const ctx = { storage: { sql: { exec } } }
  return { router: new InteractionRouterDO(ctx as never, {} as never), exec }
}

function post(path: string, body: unknown): Request {
  return new Request(`https://interaction-router${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

function callbackRow(overrides?: Partial<RouterRow>): RouterRow {
  return {
    interaction_id: "interaction-1",
    version: 1,
    workflow_id: "workflow-1",
    kind: INTERACTION_KIND.MEAL_FEEDBACK,
    expires_at: NOW + 1,
    consumed_update_id: null,
    interaction_group: "meal-planning",
    generation: 1,
    ...overrides,
  }
}

describe("InteractionRouterDO retention", () => {
  beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(NOW))

  it("removes expired and old consumed entries during registration", async () => {
    const { router, exec } = createRouter()

    const response = await router.fetch(
      post("/register", {
        interactionId: "interaction-1",
        version: 1,
        workflowId: "workflow-1",
        kind: INTERACTION_KIND.APPROVE,
        expiresAt: NOW + 1,
      }),
    )

    expect(response.status).toBe(200)
    expect(exec).toHaveBeenCalledWith("DELETE FROM interactions WHERE expires_at <= ?", NOW)
    expect(exec).toHaveBeenCalledWith(
      "DELETE FROM interactions WHERE consumed_at IS NOT NULL AND consumed_at <= ?",
      NOW - CONSUMED_INTERACTION_RETENTION_MS,
    )
  })

  it("performs the same cleanup before resolving an interaction", async () => {
    const { router, exec } = createRouter()

    const response = await router.fetch(post("/resolve", { telegramUpdateId: 12, callbackToken: "opaque-token" }))

    expect(response.status).toBe(200)
    expect(exec).toHaveBeenCalledWith("DELETE FROM interactions WHERE expires_at <= ?", NOW)
    expect(exec).toHaveBeenCalledWith(
      "DELETE FROM interactions WHERE consumed_at IS NOT NULL AND consumed_at <= ?",
      NOW - CONSUMED_INTERACTION_RETENTION_MS,
    )
  })

  it("accepts plain text for pending Calendar and meal-planning reply prompts", async () => {
    const { router, exec } = createRouter()

    await router.fetch(post("/resolve", { telegramUpdateId: 12, text: "2026-08-03 at 11:00" }))

    expect(exec).toHaveBeenCalledWith(
      expect.stringContaining("kind IN (?, ?, ?, ?, ?, ?, ?)"),
      INTERACTION_KIND.REVISION_FEEDBACK,
      INTERACTION_KIND.CALENDAR_CLARIFICATION,
      INTERACTION_KIND.CALENDAR_CONFLICT_REPLACE,
      INTERACTION_KIND.CALENDAR_RECURRENCE_NEW_TIME,
      INTERACTION_KIND.CALENDAR_EDIT_FEEDBACK,
      INTERACTION_KIND.MEAL_CLARIFICATION,
      INTERACTION_KIND.MEAL_FEEDBACK_REPLY,
    )
  })

  it("deletes a group's lower-generation unconsumed rows when a registration carries a generation", async () => {
    const { router, exec } = createRouter()

    await router.fetch(
      post("/register", {
        interactionId: "new-button",
        version: 1,
        workflowId: "meal-wf-2",
        kind: INTERACTION_KIND.MEAL_FEEDBACK,
        callbackToken: "new-token",
        expiresAt: NOW + 60_000,
        interactionGroup: "meal-planning",
        generation: 4,
      }),
    )

    expect(exec).toHaveBeenCalledWith(
      "DELETE FROM interactions WHERE interaction_group = ? AND generation < ? AND consumed_update_id IS NULL",
      "meal-planning",
      4,
    )
  })

  it("keeps the legacy version-based cleanup for registrations without a generation", async () => {
    const { router, exec } = createRouter()

    await router.fetch(
      post("/register", {
        interactionId: "calendar-1",
        version: 3,
        workflowId: "cal-wf-1",
        kind: INTERACTION_KIND.CALENDAR_CLARIFICATION,
        expiresAt: NOW + 60_000,
        interactionGroup: "calendar",
      }),
    )

    expect(exec).toHaveBeenCalledWith(
      "DELETE FROM interactions WHERE interaction_group = ? AND version < ? AND consumed_update_id IS NULL",
      "calendar",
      3,
    )
  })

  it("resolves null when a row's generation is below the group's highest present generation", async () => {
    const { router } = createRouter({ query: "SELECT * FROM interactions", row: callbackRow() }, 5)

    const response = await router.fetch(post("/resolve", { telegramUpdateId: 1, callbackToken: "old-token" }))

    expect(await response.json()).toEqual({ interaction: null, reason: "stale" })
  })

  it("resolves a row whose generation matches the group's highest present generation", async () => {
    const { router } = createRouter({ query: "SELECT * FROM interactions", row: callbackRow({ generation: 5 }) }, 5)

    const response = await router.fetch(post("/resolve", { telegramUpdateId: 1, callbackToken: "live-token" }))

    expect((await response.json()) as { interaction: RouterRow }).toMatchObject({
      interaction: { interactionId: "interaction-1", kind: INTERACTION_KIND.MEAL_FEEDBACK },
    })
  })
})

describe("persistent edit authority", () => {
  beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(NOW))

  it("keeps unrelated resources and chats independent while an edit holds a lock", async () => {
    const { namespace } = sqliteInteractionRouter()
    const first = createInteractionRouter(namespace, "chat-a")
    const second = createInteractionRouter(namespace, "chat-b")
    expect(await first.claimEdit("calendar:one", "edit-a", "calendar")).toEqual({ ok: true })
    const claims = await Promise.all([
      first.claimEdit("calendar:one", "competing", "calendar"),
      first.claimEdit("calendar:two", "edit-b", "calendar"),
      first.claimEdit("meal:one", "edit-meal", "meal"),
      second.claimEdit("calendar:one", "other-chat", "calendar"),
    ])
    expect(claims).toEqual([{ ok: false }, { ok: true }, { ok: true }, { ok: true }])
    await second.releaseEdit("calendar:one", "edit-a")
    expect(await first.claimEdit("calendar:one", "competing", "calendar")).toEqual({ ok: false })
  })

  it("enforces chat, user and deadline ownership and never restores an obsolete baseline on replay", async () => {
    const { namespace } = sqliteInteractionRouter()
    const router = createInteractionRouter(namespace, "chat-a")
    const original = {
      sessionId: "v1",
      resourceId: "event-1",
      userId: "42",
      expiresAt: NOW + 100,
      context: { baseline: "first" },
    }
    await router.saveEditContext(original)
    expect((await router.editContext("v1", "42")).context).toEqual({ baseline: "first" })
    expect((await router.editContext("v1", "other-user")).context).toBeNull()
    expect((await createInteractionRouter(namespace, "chat-b").editContext("v1", "42")).context).toBeNull()
    await router.saveEditContext({ ...original, sessionId: "v2", context: { baseline: "updated" } })
    await router.saveEditContext(original)
    expect((await router.editContext("v1", "42")).context).toBeNull()
    expect((await router.editContext("v2", "42")).context).toEqual({ baseline: "updated" })
    vi.spyOn(Date, "now").mockReturnValue(NOW + 100)
    expect((await router.editContext("v2", "42")).context).toBeNull()
  })

  it("admits only one concurrent edit per resource and recovers locks from terminal runs", async () => {
    let status = "running"
    const binding = { get: async () => ({ status: async () => ({ status }) }) }
    const { namespace } = sqliteInteractionRouter({ CALENDAR_WORKFLOW: binding } as unknown as Env)
    const router = createInteractionRouter(namespace, "chat-a")
    const claims = await Promise.all([
      router.claimEdit("event-1", "first", "calendar"),
      router.claimEdit("event-1", "second", "calendar"),
    ])
    expect(claims).toEqual([{ ok: true }, { ok: false }])
    await router.releaseEdit("event-1", "second")
    expect(await router.claimEdit("event-1", "second", "calendar")).toEqual({ ok: false })
    status = "terminated"
    expect(await router.claimEdit("event-1", "second", "calendar")).toEqual({ ok: true })
    await router.releaseEdit("event-1", "second")
    expect(await router.claimEdit("event-1", "third", "calendar")).toEqual({ ok: true })
  })

  it("keeps edit actions reusable until expiry while preserving their identity on registration retries", async () => {
    const { namespace } = sqliteInteractionRouter()
    const router = createInteractionRouter(namespace, "chat-a")
    const registration = {
      interactionId: "edit-1",
      workflowId: "generation-1",
      version: 1,
      kind: INTERACTION_KIND.CALENDAR_EDIT,
      callbackToken: "token",
      expiresAt: NOW + 100,
      edit: { sessionId: "saved" },
    }
    await router.register(registration)
    expect((await router.resolve({ callbackToken: "token", telegramUpdateId: 1 })).interaction?.edit).toEqual({
      sessionId: "saved",
    })
    await router.register(registration)
    expect((await router.resolve({ callbackToken: "token", telegramUpdateId: 2 })).interaction?.edit).toEqual({
      sessionId: "saved",
    })
    expect((await router.resolve({ callbackToken: "token", telegramUpdateId: 1 })).interaction?.interactionId).toBe(
      "edit-1",
    )
    vi.spyOn(Date, "now").mockReturnValue(NOW + 100)
    expect(await router.resolve({ callbackToken: "token", telegramUpdateId: 3 })).toEqual({
      interaction: null,
      reason: "expired",
    })
  })

  it.each([
    "queued",
    "running",
    "paused",
    "waiting",
    "waitingForPause",
    "unknown",
    "complete",
    "errored",
    "terminated",
  ])("recovers a lock only when the previous workflow status is terminal (%s)", async (status) => {
    const binding = {
      get: async (id: string) => ({ status: async () => ({ status: id === "original" ? status : "running" }) }),
    }
    const { namespace } = sqliteInteractionRouter({ MEAL_PLANNING_WORKFLOW: binding } as unknown as Env)
    const router = createInteractionRouter(namespace, "chat")
    expect(await router.claimEdit("plan", "original", "meal")).toEqual({ ok: true })
    const terminal = ["complete", "errored", "terminated"].includes(status)
    expect(await router.claimEdit("plan", "replacement", "meal")).toEqual({ ok: terminal })
    await router.releaseEdit("plan", "original")
    expect(await router.claimEdit("plan", "third", "meal")).toEqual({ ok: !terminal })
  })

  it.each([
    "missing-binding",
    "get-error",
    "status-error",
  ])("retains locks when status cannot be established (%s)", async (failure) => {
    const binding = {
      get: async () => {
        if (failure === "get-error") throw new Error("lookup unavailable")
        return {
          status: async () => {
            throw new Error("status unavailable")
          },
        }
      },
    }
    const { namespace } = sqliteInteractionRouter(
      (failure === "missing-binding" ? {} : { CALENDAR_WORKFLOW: binding }) as unknown as Env,
    )
    const router = createInteractionRouter(namespace, "chat")
    await router.claimEdit("event", "original", "calendar")
    expect(await router.claimEdit("event", "replacement", "calendar")).toEqual({ ok: false })
    expect(await router.claimEdit("event", "original", "calendar")).toEqual({ ok: true })
  })

  it("admits one winner when abandoned-lock recovery status lookups overlap", async () => {
    const resolveStatus: Array<(value: { status: string }) => void> = []
    const binding = { get: async () => ({ status: () => new Promise((resolve) => resolveStatus.push(resolve)) }) }
    const { namespace } = sqliteInteractionRouter({ CALENDAR_WORKFLOW: binding } as unknown as Env)
    const router = createInteractionRouter(namespace, "chat")
    await router.claimEdit("event", "abandoned", "calendar")
    const first = router.claimEdit("event", "first", "calendar")
    const second = router.claimEdit("event", "second", "calendar")
    await vi.waitFor(() => expect(resolveStatus).toHaveLength(2))
    resolveStatus[0]({ status: "errored" })
    expect(await first).toEqual({ ok: true })
    resolveStatus[1]({ status: "errored" })
    expect(await second).toEqual({ ok: false })
    await router.releaseEdit("event", "abandoned")
    expect(await router.claimEdit("event", "first", "calendar")).toEqual({ ok: true })
  })

  it("rehydrates context, invalidation, deadlines and locks from the same SQLite database", async () => {
    const fixture = sqliteInteractionRouter({
      CALENDAR_WORKFLOW: { get: async () => ({ status: async () => ({ status: "running" }) }) },
    } as unknown as Env)
    const router = createInteractionRouter(fixture.namespace, "chat")
    const original = {
      sessionId: "v1",
      resourceId: "event",
      userId: "42",
      expiresAt: NOW + 100,
      context: { version: 1 },
    }
    await router.saveEditContext(original)
    await router.saveEditContext({ ...original, sessionId: "v2", context: { version: 2 } })
    await router.claimEdit("event", "owner", "calendar")
    expect(fixture.evict("telegram-chat:chat")).toBe(true)
    expect((await router.editContext("v1", "42")).context).toBeNull()
    expect((await router.editContext("v2", "42")).context).toEqual({ version: 2 })
    expect(await router.claimEdit("event", "competitor", "calendar")).toEqual({ ok: false })
    await router.saveEditContext(original)
    expect((await router.editContext("v1", "42")).context).toBeNull()
    vi.spyOn(Date, "now").mockReturnValue(NOW + 100)
    expect(fixture.evict("telegram-chat:chat")).toBe(true)
    expect((await router.editContext("v2", "42")).context).toBeNull()
  })

  it("starts one edit for duplicate delivery and propagates a failed create when no run exists", async () => {
    const ids = new Set<string>()
    const binding = {
      create: vi.fn(async ({ id }: { id: string }) => {
        if (ids.has(id)) throw new Error("already exists")
        ids.add(id)
      }),
      get: async (id: string) => ({ status: async () => ({ status: ids.has(id) ? "complete" : "unknown" }) }),
    }
    const results = await Promise.all([
      startEditWorkflow(binding as never, "update-1", {}),
      startEditWorkflow(binding as never, "update-1", {}),
    ])
    expect(results[0]).toBe(results[1])
    expect(ids.size).toBe(1)
    binding.create.mockRejectedValueOnce(new Error("network failed"))
    await expect(startEditWorkflow(binding as never, "update-2", {})).rejects.toThrow("network failed")
  })
})
