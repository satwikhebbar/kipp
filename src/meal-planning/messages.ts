import type { MealPlanRecord, MealPlanVersionRecord } from "./store"
import type { CustomPolicy, MealSchedule } from "./types"

export const MEAL_HELP = `Start a school-week meal plan with /mealplan.

By default the plan covers the current Mon–Sat school week (invoked Mon–Wed)
or the next one (invoked Thu–Sun). Overrides:
/mealplan this week
/mealplan next week
/mealplan YYYY-MM-DD`

export const MEAL_AGENT_UNAVAILABLE = "I couldn't reach the meal-planning agent. Please try again shortly."
export const MEAL_STALE_PLAN =
  "This plan was already updated — tap [Give feedback] on the newest plan message to try again."
export const MEAL_PLANNING_CANCELED = "No reply received — run /mealplan to try again."
export const MEAL_FEEDBACK_NOT_APPLIED =
  "No reply received — your feedback was not applied; tap [Give feedback] to try again."
export const MEAL_NO_CHANGES = "No changes — your feedback is noted."
export const MEAL_OPEN_FEEDBACK_PROMPT = "Reply with your feedback for this plan (e.g. 'Wed lunch: too oily')."
export const MEAL_PLAN_ENDED = "This week's plan has ended — run /mealplan for the next week."

/** Formats one stored ISO instant as a short weekday-and-date label (e.g. "Mon Sep 7") in the plan's timezone. */
function formatWeekDay(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: timezone,
  }).format(new Date(iso))
}

/**
 * Renders the active plan as deterministic, phone-friendly fridge-board text:
 * a school-week header, five slot lines per day (dish plus prep and easy-buy
 * markers), and a one-line summary of material trade-offs (labels only, no
 * essay). Pure and snapshot-testable (the plan §7 shape; rendering polish and
 * snapshot tests land with iteration 3).
 */
export function renderPlanMessage(
  plan: MealPlanRecord,
  version: MealPlanVersionRecord,
  schedule: MealSchedule,
  customPolicies: CustomPolicy[],
): string {
  const weekStart = formatWeekDay(plan.weekStart, plan.timezone)
  const weekEnd = formatWeekDay(plan.weekEnd, plan.timezone)
  const lines = [`School week of ${weekStart} – ${weekEnd}`, ""]
  for (const day of schedule.days) {
    lines.push(day)
    for (const slot of schedule.slots) {
      const cell = version.candidate.grid[day]?.[slot.id]
      if (!cell) continue
      lines.push(`  ${slot.name}: ${cell.dish}${cellMarkers(version, cell.dish, cell.priorNightPrep)}`)
    }
    lines.push("")
  }
  const tradeOffs = materialTradeOffs(version, customPolicies)
  if (tradeOffs.length) lines.push(`Trade-offs: ${tradeOffs.join("; ")}`, "")
  while (lines[lines.length - 1] === "") lines.pop()
  return lines.join("\n")
}

/** Returns dish markers: an easy-buy suffix and a prior-night-prep suffix. */
function cellMarkers(version: MealPlanVersionRecord, dish: string, priorNightPrep: boolean): string {
  const markers: string[] = []
  if (version.candidate.easyBuys.includes(dish)) markers.push("easy buy")
  if (priorNightPrep) markers.push("prep")
  return markers.length ? ` (${markers.join(", ")})` : ""
}

/** Returns the labels of every policy carrying a material trade-off, in policy order. */
function materialTradeOffs(version: MealPlanVersionRecord, customPolicies: CustomPolicy[]): string[] {
  const labels = new Map(customPolicies.map((policy) => [policy.id, policy.label]))
  return Object.entries(version.candidate.policyOutcomes)
    .filter(([, outcome]) => outcome.outcome === "trade-off")
    .map(([id]) => labels.get(id) ?? id)
}
