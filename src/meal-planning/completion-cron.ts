import type { Env } from "../core/types"
import { logRuntime } from "../runtime/logging"
import type { MealPlanningStore } from "./store"
import { createMealPlanningStore } from "./store"

export const MEAL_COMPLETION_CRON = "15 * * * *"
const SWEEP_LIMIT = 5

/** Attempts a bounded set of due plans, continuing after any row-local failure. */
export async function handleMealCompletionCron(
  env: Pick<Env, "MEAL_PLANNING_DB" | "LOG_LEVEL">,
  store = env.MEAL_PLANNING_DB ? createMealPlanningStore(env.MEAL_PLANNING_DB) : undefined,
): Promise<void> {
  if (!store) return
  await sweep(store, env)
}

/** Advances durable progress before attempting each eligible plan. */
async function sweep(store: MealPlanningStore, env: Pick<Env, "LOG_LEVEL">): Promise<void> {
  const seen = new Set<string>()
  for (let index = 0; index < SWEEP_LIMIT; index++) {
    const target = await store.claimDueMealCompletion(seen)
    if (!target) return
    seen.add(target.planId)
    try {
      const counts = await store.completeEligibleMealPlan(target)
      logRuntime(env, {
        event: "meal-plan-completion",
        outcome: counts ? "succeeded" : "ignored",
        ...(counts ? { metrics: counts } : {}),
      })
    } catch {
      console.error(
        JSON.stringify({ event: "meal-plan-completion", outcome: "failed", failureCategory: "store-error" }),
      )
    }
  }
}
