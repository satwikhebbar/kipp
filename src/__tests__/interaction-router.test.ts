import { beforeEach, describe, expect, it, vi } from "vitest"
import { CONSUMED_INTERACTION_RETENTION_MS, InteractionRouterDO } from "../core/interaction-router"
import { INTERACTION_KIND } from "../core/types"

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

    expect(await response.json()).toEqual({ interaction: null })
  })

  it("resolves a row whose generation matches the group's highest present generation", async () => {
    const { router } = createRouter({ query: "SELECT * FROM interactions", row: callbackRow({ generation: 5 }) }, 5)

    const response = await router.fetch(post("/resolve", { telegramUpdateId: 1, callbackToken: "live-token" }))

    expect((await response.json()) as { interaction: RouterRow }).toMatchObject({
      interaction: { interactionId: "interaction-1", kind: INTERACTION_KIND.MEAL_FEEDBACK },
    })
  })
})
