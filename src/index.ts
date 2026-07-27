import { Hono } from "hono"
import { CalendarWorkflow } from "./calendar-workflow"
import { createTokenVault } from "./token-vault-client"
import { handleCadenceCron } from "./triggers/cadence"
import { handleGoogleCalendarAuthCallback, handleGoogleCalendarAuthStart } from "./triggers/google-calendar-auth"
import { handleAuthCallback, handleAuthStart } from "./triggers/linkedin-auth"
import { hasSetupAccess } from "./triggers/oauth"
import { handleRssCron } from "./triggers/rss"
import { handleTelegramWebhook } from "./triggers/telegram-webhook"
import { handleTokenCheckCron } from "./triggers/token-check"
import type { Env } from "./types"

export { InteractionRouterDO } from "./interaction-router"
export { TokenVaultDO } from "./token-vault"
export { PipelineWorkflow } from "./workflow"
export { CalendarWorkflow }

const app = new Hono<{ Bindings: Env }>()

app.get("/", (c) => c.text("linkedin-pipeline"))

app.get("/setup/linkedin", async (c) => handleAuthStart(c.req.raw, c.req.header("host") ?? "", c.env))

app.get("/setup/google-calendar", async (c) =>
  handleGoogleCalendarAuthStart(c.req.raw, c.req.header("host") ?? "", c.env),
)

app.get("/auth/linkedin/callback", async (c) => {
  const code = c.req.query("code")
  const state = c.req.query("state") ?? ""
  if (!code) return c.text("Missing code parameter", 400)
  return handleAuthCallback(code, state, c.req.header("host") ?? "", c.env, c.req.raw)
})

app.get("/auth/google-calendar/callback", async (c) => {
  const code = c.req.query("code")
  const state = c.req.query("state") ?? ""
  if (!code) return c.text("Missing code parameter", 400)
  return handleGoogleCalendarAuthCallback(code, state, c.req.header("host") ?? "", c.env, c.req.raw)
})

app.post("/admin/rewrap", async (c) => {
  if (!(await hasSetupAccess(c.req.raw, c.env))) {
    return c.text("Unauthorized", 403)
  }
  const vault = createTokenVault(c.env)
  try {
    const result = await vault.rewrap()
    return c.json(result)
  } catch {
    return c.json({ success: false }, 500)
  }
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
