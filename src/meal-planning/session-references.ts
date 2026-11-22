import type { MealPlanContext, MealPlanSelectionCandidate, MealPlanSelectionPatch } from "./types"

/** Creates deterministic, kind-separated references for one unchanged session context. */
export function mealSessionReferences(context: MealPlanContext) {
  const established = (context.profile.mealDefinitions ?? []).filter((meal) => meal.status === "established")
  const provisional = (context.provisionalMealDefinitions ?? []).filter((meal) => meal.status === "provisional")
  const byId = new Map<string, string>()
  const provisionalById = new Map<string, string>()
  const establishedByReference = new Map<string, string>()
  const provisionalByReference = new Map<string, string>()
  established.forEach((meal, index) => {
    const reference = `M${index + 1}`
    byId.set(meal.id, reference)
    establishedByReference.set(reference, meal.id)
  })
  provisional.forEach((meal, index) => {
    const reference = `P${index + 1}`
    provisionalById.set(meal.id, reference)
    provisionalByReference.set(reference, meal.id)
  })
  return { byId, provisionalById, establishedByReference, provisionalByReference }
}

/** Resolves only references of the expected kind; unknown references fail normal hydration. */
export function resolveMealSessionReferences<T extends MealPlanSelectionCandidate | MealPlanSelectionPatch>(
  candidate: T,
  context: MealPlanContext,
): T {
  const references = mealSessionReferences(context)
  // Reserve short reference spellings even if a stored ID happens to match one.
  const resolve = (value: string, entries: ReadonlyMap<string, string>) =>
    entries.get(value) ?? (/^[MP]\d+$/.test(value) ? `unknown-session-reference:${value}` : value)
  const grid = Object.fromEntries(
    Object.entries(candidate.grid).map(([day, cells]) => [
      day,
      Object.fromEntries(
        Object.entries(cells).map(([slot, selection]) => {
          if ("mealDefinitionId" in selection)
            return [
              slot,
              {
                ...selection,
                mealDefinitionId: resolve(selection.mealDefinitionId, references.establishedByReference),
              },
            ]
          if ("provisionalMealId" in selection)
            return [
              slot,
              {
                ...selection,
                provisionalMealId: resolve(selection.provisionalMealId, references.provisionalByReference),
              },
            ]
          return [slot, selection]
        }),
      ),
    ]),
  )
  return { ...candidate, grid }
}
