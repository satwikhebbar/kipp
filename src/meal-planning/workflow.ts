import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import type { Env } from "../core/types"
import type { MealPlanningLiveEvent } from "./agent-workflow"
import { runAgentCenteredMealPlanningWorkflow, runMealPlanningEditWorkflow } from "./agent-workflow"

export interface MealPlanningWorkflowParams {
  chatId: string
  telegramMessageId: number
  requestText: string
  /** Captured by the webhook at `/mealplan`; week resolution never calls `Date.now()` inside the workflow (replay-safe). */
  invokedAtMs: number
  edit?: { planInstanceId: string; userId: string; feedback: MealPlanningLiveEvent }
}

/** Durable entrypoint for the bounded agent-centered meal-planning workflow. */
export class MealPlanningWorkflow extends WorkflowEntrypoint<Env, MealPlanningWorkflowParams> {
  override async run(event: WorkflowEvent<MealPlanningWorkflowParams>, step: WorkflowStep): Promise<void> {
    if (event.payload.edit) return runMealPlanningEditWorkflow(this.env, event, step)
    return runAgentCenteredMealPlanningWorkflow(this.env, event, step)
  }
}
