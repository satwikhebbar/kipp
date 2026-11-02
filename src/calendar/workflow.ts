import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import type { Env } from "../core/types"
import { runAgentCenteredCalendarWorkflow, runCalendarEditWorkflow } from "./agent-workflow"

export interface CalendarWorkflowParams {
  chatId: string
  requestText: string
  telegramMessageId: number
  /** Trusted origin of the Telegram webhook request, used for OAuth recovery links. */
  setupOrigin?: string
  edit?: { sessionId: string; userId: string; text?: string; openPrompt: boolean }
}

/** Durable entrypoint for the bounded agent-centered Calendar workflow. */
export class CalendarWorkflow extends WorkflowEntrypoint<Env, CalendarWorkflowParams> {
  override async run(event: WorkflowEvent<CalendarWorkflowParams>, step: WorkflowStep): Promise<void> {
    if (event.payload.edit) return runCalendarEditWorkflow(this.env, event, step)
    return runAgentCenteredCalendarWorkflow(this.env, event, step)
  }
}
