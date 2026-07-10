import { Hono } from "hono"
import type { Env } from "./types"

export { PipelineWorkflow } from "./workflow"

const app = new Hono<{ Bindings: Env }>()

app.get("/", (c) => c.text("LinkedIn Pipeline — running"))

app.post("/webhook/telegram", async (c) => {
  return c.text("Not yet implemented")
})

export default app
