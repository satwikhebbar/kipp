import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import { runAgentCenteredCalendarWorkflow } from "./calendar-agent-workflow"
import type { Env } from "./types"

export interface CalendarWorkflowParams {
  chatId: string
  requestText: string
  telegramMessageId: number
}

/** Durable entrypoint for the bounded agent-centered Calendar workflow. */
export class CalendarWorkflow extends WorkflowEntrypoint<Env, CalendarWorkflowParams> {
  override async run(event: WorkflowEvent<CalendarWorkflowParams>, step: WorkflowStep): Promise<void> {
    return runAgentCenteredCalendarWorkflow(this.env, event, step)
  }
}
