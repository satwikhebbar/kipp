import type { MealPlanningTerminalOutcome } from "../../agent/meal-planning-session"
import type { MealDefinition, MealPlanContext, MealPlanScenario } from "../../meal-planning/types"

/** Restores the explicit repertoire facts of a hydrated corpus fixture for selection-based live sessions. */
export function withCorpusCatalog(scenario: MealPlanScenario): MealPlanContext {
  const context = scenario.context
  const reference = scenario.candidates.find((candidate) => candidate.expect.pass)
  if (!reference) throw new Error(`no passing reference for ${scenario.id}`)
  const definitions = new Map<string, MealDefinition>()
  for (const slots of Object.values(reference.plan.grid)) {
    for (const [slotId, cell] of Object.entries(slots)) {
      if (!context.profile.dishRepertoire.includes(cell.dish))
        throw new Error(`reference dish ${cell.dish} is not in the household repertoire`)
      const slot = context.schedule.slots.find((entry) => entry.id === slotId)
      if (!slot) throw new Error(`unknown reference slot ${slotId}`)
      if (!cell.vegetarian) throw new Error(`reference dish ${cell.dish} is not vegetarian`)
      const prior = definitions.get(cell.dish)
      if (prior) {
        if (!prior.suitableSlots.includes(slotId)) prior.suitableSlots.push(slotId)
        continue
      }
      definitions.set(cell.dish, {
        id: `corpus_${scenario.id}_${definitions.size}`,
        name: cell.dish,
        aliases: [cell.dish],
        principalIngredients: cell.items,
        vegetarian: true,
        suitableSlots: [slotId],
        packedFood: { suitable: slot.packed, dry: slot.dry },
        typicalCookMinutes: cell.cookMinutes,
        priorNightPrep: cell.priorNightPrep ? "required" : "none",
        requiredIngredients: cell.items,
        optionalIngredients: [],
        status: "established",
      })
    }
  }
  return { ...context, profile: { ...context.profile, mealDefinitions: [...definitions.values()] } }
}

/** Follows the production workflow's scoped-feedback replan after its context-update handoff. */
export async function continueScopedRevision<T extends { terminal: MealPlanningTerminalOutcome | null }>(
  context: MealPlanContext,
  result: T,
  runUpdatedSession: (updated: MealPlanContext) => Promise<T>,
): Promise<T> {
  if (result.terminal?.kind !== "update_week_context" || !context.feedbackItems?.some((item) => item.scope))
    return result
  const update = result.terminal.update
  return runUpdatedSession({
    ...context,
    weeklyInventory: update.weeklyInventory,
    weeklyExceptions: update.weeklyExceptions,
    // Retain server-owned scopes so the evaluator can authorize exactly the
    // requested cells after the inventory fact has been applied.
    feedbackItems: context.feedbackItems.filter((item) => item.scope),
    request: {
      kind: "revision",
      text: `Week-context updates from this message are already applied. Carry out the requested replan: ${context.feedbackItems.map((item) => item.text).join(" ")}`,
    },
  })
}
