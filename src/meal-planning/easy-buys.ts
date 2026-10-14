import { normalizeIngredient } from "./ingredient-normalization"
import type { MealPlanCandidate, MealPlanContext } from "./types"

/**
 * Long-shelf and specialty categories the weekly easy-buys list must never
 * contain. The complement (ordinary staples, everyday produce, neighborhood
 * grocery items) is open, so this is a small, stable negative set. Entries are
 * singular stems matched as whole words against the normalized ingredient form,
 * so "mixed seeds" is caught while "seedless grapes" is not. Unlisted
 * categories ("dried apricots") are left to the semantic easy-buy classifier.
 */
export const PROHIBITED_EASY_BUY_TOKENS = [
  "date",
  "raisin",
  "dry coconut",
  "jaggery",
  "paneer",
  "cashew",
  "almond",
  "walnut",
  "peanut",
  "pistachio",
  "seed",
] as const

/** Word-boundary matcher per stem; the trailing `s?` tolerates a plural not at the end of the phrase. */
const PROHIBITED_EASY_BUY_PATTERNS = PROHIBITED_EASY_BUY_TOKENS.map(
  (token) => new RegExp(`(?:^| )${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?(?= |$)`),
)

/** Returns the entries of an easy-buys list that are prohibited specialty items, in input order. */
export function findProhibitedEasyBuys(easyBuys: readonly string[]): string[] {
  return easyBuys.filter((buy) => {
    const normalized = normalizeIngredient(buy)
    return PROHIBITED_EASY_BUY_PATTERNS.some((pattern) => pattern.test(normalized))
  })
}

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
