import { Hono } from "hono"
import { handleCadenceCron } from "./triggers/cadence"
import { handleAuthCallback, handleAuthStart } from "./triggers/linkedin-auth"
import { handleRssCron } from "./triggers/rss"
import { handleTelegramWebhook } from "./triggers/telegram-webhook"
import { handleTokenCheckCron } from "./triggers/token-check"
import type { Env } from "./types"

export { PipelineWorkflow } from "./workflow"

const app = new Hono<{ Bindings: Env }>()

app.get("/", (c) => c.text("LinkedIn Pipeline — running"))

app.get("/setup/linkedin", async (c) => handleAuthStart(c.req.header("host") ?? "", c.env))

app.get("/auth/linkedin/callback", async (c) => {
  const code = c.req.query("code")
  const state = c.req.query("state") ?? ""
  if (!code) return c.text("Missing code parameter", 400)
  return handleAuthCallback(code, state, c.req.header("host") ?? "", c.env)
})

app.post("/webhook/telegram", async (c) => handleTelegramWebhook(c.req.raw, c.env))

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env) {
    switch (controller.cron) {
      case "0 9 * * *":
        await handleRssCron(env)
        break
      case "0 8 * * 1":
        await handleTokenCheckCron(env)
        break
      case "0 9 * * 1":
        await handleCadenceCron(env)
        break
    }
  },
}
