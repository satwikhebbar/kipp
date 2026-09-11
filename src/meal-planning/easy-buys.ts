import { normalizeIngredient } from "./ingredient-normalization"
import type { MealPlanCandidate, MealPlanContext } from "./types"

/**
 * Derives the shopping list required by a fully hydrated revision. Easy buys
 * are plan-owned: stale entries must not survive merely because their original
 * cell was replaced, and a newly selected meal must bring its missing ordinary
 * ingredients along with it.
 */
export function reconcileEasyBuys(candidate: MealPlanCandidate, context: MealPlanContext): MealPlanCandidate {
  const alreadyAvailable = new Set(
    [
      ...context.weeklyInventory.items.filter((item) => item.status !== "unavailable").map((item) => item.name),
      ...context.profile.pantryBaseline,
    ].map(normalizeIngredient),
  )
  const easyBuys: string[] = []
  const seen = new Set<string>()
  for (const cells of Object.values(candidate.grid)) {
    for (const cell of Object.values(cells)) {
      for (const item of cell.items) {
        const normalized = normalizeIngredient(item)
        if (!normalized || alreadyAvailable.has(normalized) || seen.has(normalized)) continue
        seen.add(normalized)
        easyBuys.push(item)
      }
    }
  }
  return { ...candidate, easyBuys }
}
