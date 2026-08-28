import { Hono } from "hono"
import { CalendarWorkflow } from "./calendar/workflow"
import { createTokenVault } from "./core/token-vault-client"
import type { Env } from "./core/types"
import { createTelegramClient, TELEGRAM_NOTIFY_TIMEOUT_MS } from "./integrations/telegram"
import { miniAppPage } from "./meal-plan-spike/page"
import { createMiniAppSession, readMiniAppPlan, submitMiniAppFeedback } from "./meal-plan-spike/routes"
import { HTTP_STATUS } from "./runtime/http"
import { logRuntime } from "./runtime/logging"
import { userFacingFailureMessage } from "./runtime/user-failures"
import { handleCadenceCron } from "./triggers/cadence"
import { handleGoogleCalendarAuthCallback, handleGoogleCalendarAuthStart } from "./triggers/google-calendar-auth"
import { handleAuthCallback, handleAuthStart } from "./triggers/linkedin-auth"
import { hasSetupAccess } from "./triggers/oauth"
import { handleRssCron, RssFetchError } from "./triggers/rss"
import { handleTelegramWebhook } from "./triggers/telegram-webhook"
import { handleTokenCheckCron } from "./triggers/token-check"

export { IdeaIngestDO } from "./core/idea-ingest"
export { InteractionRouterDO } from "./core/interaction-router"
export { TokenVaultDO } from "./core/token-vault"
export { PipelineWorkflow } from "./linkedin/workflow"
export { CalendarWorkflow }

const app = new Hono<{ Bindings: Env }>()

app.get("/", (c) => c.text("linkedin-pipeline"))

app.get("/mini-app", (c) => c.html(miniAppPage()))
app.post("/api/mini-app/session", (c) => createMiniAppSession(c.req.raw, c.env))
app.get("/api/mini-app/plan", (c) => readMiniAppPlan(c.req.raw))
app.post("/api/mini-app/feedback", (c) => submitMiniAppFeedback(c.req.raw, c.env))

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
      const rssFetchFailure = err instanceof RssFetchError ? err : null
      logRuntime(env, {
        event: "scheduled-cron",
        outcome: "failed",
        failureCategory: rssFetchFailure
          ? rssFetchFailure.transient
            ? "rss-upstream-transient"
            : "rss-upstream-non-transient"
          : "unclassified",
        ...(rssFetchFailure
          ? {
              retryCount: rssFetchFailure.attempts - 1,
              details: { rssStatus: rssFetchFailure.status, rssAttempts: rssFetchFailure.attempts },
            }
          : {}),
      })
      if (rssFetchFailure) {
        console.error(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            component: "kipp-runtime",
            event: "scheduled-cron",
            outcome: "failed",
            failureCategory: rssFetchFailure.transient ? "rss-upstream-transient" : "rss-upstream-non-transient",
            rssStatus: rssFetchFailure.status,
            rssAttempts: rssFetchFailure.attempts,
          }),
        )
      } else {
        console.error(new Date().toISOString(), "[scheduled] unhandled error:", err)
      }
      const operatorChatId = env.TELEGRAM_ALLOWED_USER_ID.trim()
      if (operatorChatId && env.TELEGRAM_BOT_TOKEN && !rssFetchFailure?.transient) {
        await createTelegramClient(env.TELEGRAM_BOT_TOKEN)
          .sendMessage(operatorChatId, userFacingFailureMessage(err), {
            signal: AbortSignal.timeout(TELEGRAM_NOTIFY_TIMEOUT_MS),
          })
          .catch(() => {})
      }
    }
  },
}
