import { describe, expect, it } from "vitest"
import type { Env } from "../core/types"
import { miniAppRoutes } from "../meal-planning/mini-app-routes"
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
  it("serves a data-free no-store shell and rejects unauthenticated plan reads", async () => {
    const shell = await miniAppRoutes.fetch(new Request("https://kipp.example/mini-app"), env())
    expect(shell.status).toBe(200)
    expect(shell.headers.get("cache-control")).toBe("no-store")
    expect(await shell.text()).not.toContain("planId")

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
  })
})
