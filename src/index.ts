import { Hono } from "hono"
import { CalendarWorkflow } from "./calendar/workflow"
import { createTokenVault } from "./core/token-vault-client"
import type { Env } from "./core/types"
import { createTelegramClient, TELEGRAM_NOTIFY_TIMEOUT_MS } from "./integrations/telegram"
import { MealPlanningWorkflow } from "./meal-planning/workflow"
import { HTTP_STATUS } from "./runtime/http"
import { logRuntime } from "./runtime/logging"
import { userFacingFailureMessage } from "./runtime/user-failures"
import { handleCadenceCron } from "./triggers/cadence"
import { handleGoogleCalendarAuthCallback, handleGoogleCalendarAuthStart } from "./triggers/google-calendar-auth"
import { handleAuthCallback, handleAuthStart } from "./triggers/linkedin-auth"
import { hasSetupAccess } from "./triggers/oauth"
import { handleRssCron } from "./triggers/rss"
import { handleTelegramWebhook } from "./triggers/telegram-webhook"
import { handleTokenCheckCron } from "./triggers/token-check"

export { IdeaIngestDO } from "./core/idea-ingest"
export { InteractionRouterDO } from "./core/interaction-router"
export { TokenVaultDO } from "./core/token-vault"
export { PipelineWorkflow } from "./linkedin/workflow"
export { CalendarWorkflow, MealPlanningWorkflow }

const app = new Hono<{ Bindings: Env }>()

app.get("/", (c) => c.text("linkedin-pipeline"))

app.get("/setup/linkedin", async (c) => handleAuthStart(c.req.raw, c.req.header("host") ?? "", c.env))

app.get("/setup/google-calendar", async (c) =>
  handleGoogleCalendarAuthStart(c.req.raw, c.req.header("host") ?? "", c.env),
)

app.get("/auth/linkedin/callback", async (c) => {
  const code = c.req.query("code")
  const state = c.req.query("state") ?? ""
  if (!code) return c.text("Missing code parameter", HTTP_STATUS.BAD_REQUEST)
  return handleAuthCallback(code, state, c.req.header("host") ?? "", c.env, c.req.raw)
})

app.get("/auth/google-calendar/callback", async (c) => {
  const code = c.req.query("code")
  const state = c.req.query("state") ?? ""
  if (!code) return c.text("Missing code parameter", HTTP_STATUS.BAD_REQUEST)
  return handleGoogleCalendarAuthCallback(code, state, c.req.header("host") ?? "", c.env, c.req.raw)
})

app.post("/admin/rewrap", async (c) => {
  if (!(await hasSetupAccess(c.req.raw, c.env))) {
    return c.text("Unauthorized", HTTP_STATUS.FORBIDDEN)
  }
  const vault = createTokenVault(c.env)
  try {
    const result = await vault.rewrap()
    return c.json(result)
  } catch {
    return c.json({ success: false }, HTTP_STATUS.INTERNAL_SERVER_ERROR)
  }
})

app.post("/webhook/telegram", async (c) => handleTelegramWebhook(c.req.raw, c.env))

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env) {
    try {
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
    } catch (err) {
      logRuntime(env, { event: "scheduled-cron", outcome: "failed" })
      console.error(new Date().toISOString(), "[scheduled] unhandled error:", err)
      const operatorChatId = env.TELEGRAM_ALLOWED_USER_ID.trim()
      if (operatorChatId && env.TELEGRAM_BOT_TOKEN) {
        await createTelegramClient(env.TELEGRAM_BOT_TOKEN)
          .sendMessage(operatorChatId, userFacingFailureMessage(err), {
            signal: AbortSignal.timeout(TELEGRAM_NOTIFY_TIMEOUT_MS),
          })
          .catch(() => {})
      }
    }
  },
}
