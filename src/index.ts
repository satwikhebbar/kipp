import { Hono } from "hono"
import { handleCadenceCron } from "./triggers/cadence"
import { handleRssCron } from "./triggers/rss"
import { handleTelegramWebhook } from "./triggers/telegram-webhook"
import { handleTokenCheckCron } from "./triggers/token-check"
import type { Env } from "./types"

export { PipelineWorkflow } from "./workflow"

const app = new Hono<{ Bindings: Env }>()

app.get("/", (c) => c.text("LinkedIn Pipeline — running"))

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
