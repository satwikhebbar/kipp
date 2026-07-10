import { Hono } from "hono"

export interface Env {
  PIPELINE_WORKFLOW: Workflow
  TELEGRAM_BOT_TOKEN: string
  TELEGRAM_WEBHOOK_SECRET: string
  LINKEDIN_ACCESS_TOKEN: string
  LINKEDIN_REFRESH_TOKEN: string
  LLM_API_KEY: string
  LLM_PROVIDER: string
  GITHUB_PAT: string
  DATA_REPO_OWNER: string
  DATA_REPO_NAME: string
}

const app = new Hono<{ Bindings: Env }>()

app.get("/", (c) => c.text("LinkedIn Pipeline — running"))

app.post("/webhook/telegram", async (c) => {
  return c.text("Not yet implemented")
})

export default app
