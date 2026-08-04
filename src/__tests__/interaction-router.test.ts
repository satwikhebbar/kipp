import { beforeEach, describe, expect, it, vi } from "vitest"
import { CONSUMED_INTERACTION_RETENTION_MS, InteractionRouterDO } from "../core/interaction-router"
import { INTERACTION_KIND } from "../core/types"

const NOW = 1_000_000
function createRouter() {
  const exec = vi.fn((_query: string) => ({
    toArray: () => [],
  }))
  const ctx = { storage: { sql: { exec } } }
  return { router: new InteractionRouterDO(ctx as never, {} as never), exec }
}

function post(path: string, body: unknown): Request {
  return new Request(`https://interaction-router${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  })
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

  it("accepts plain text for active Calendar reply prompts", async () => {
    const { router, exec } = createRouter()

    await router.fetch(post("/resolve", { telegramUpdateId: 12, text: "2026-08-03 at 11:00" }))

    expect(exec).toHaveBeenCalledWith(
      expect.stringContaining("kind IN (?, ?, ?, ?)"),
      INTERACTION_KIND.REVISION_FEEDBACK,
      INTERACTION_KIND.CALENDAR_CLARIFICATION,
      INTERACTION_KIND.CALENDAR_CONFLICT_REPLACE,
      INTERACTION_KIND.CALENDAR_EDIT_FEEDBACK,
    )
  })
})
