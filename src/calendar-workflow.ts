import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import { createTelegramClient } from "./integrations/telegram"
import { logRuntime } from "./runtime/logging"
import type { Env } from "./types"

export interface CalendarWorkflowParams {
  chatId: string
  requestText: string
  telegramMessageId: number
}

/**
 * The Calendar workflow is deliberately separate from LinkedIn. Its planning
 * and deterministic write stages are added incrementally in this milestone.
 */
export class CalendarWorkflow extends WorkflowEntrypoint<Env, CalendarWorkflowParams> {
  override async run(event: WorkflowEvent<CalendarWorkflowParams>, step: WorkflowStep): Promise<void> {
    logRuntime(this.env, { workflow: event.instanceId, event: "calendar-workflow-run", outcome: "started" })
    await step.do("calendar-not-available", async () => {
      const tg = createTelegramClient(this.env.TELEGRAM_BOT_TOKEN)
      await tg.sendMessage(event.payload.chatId, "Calendar scheduling is being prepared. Please try again shortly.")
    })
    logRuntime(this.env, { workflow: event.instanceId, event: "calendar-workflow-run", outcome: "succeeded" })
  }
}
