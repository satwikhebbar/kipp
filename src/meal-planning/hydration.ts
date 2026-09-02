import type {
  MealCell,
  MealDefinition,
  MealPlanCandidate,
  MealPlanContext,
  MealPlanFailure,
  MealPlanHydrationResult,
  MealPlanSelectionCandidate,
  MealPlanSelectionPatch,
  MealSelection,
  NewMealProposal,
} from "./types"

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function definitionNames(definition: MealDefinition): string[] {
  return [definition.name, ...(definition.aliases ?? [])].map(normalized)
}

function allowedChoices(definition: MealDefinition): Set<string> {
  return new Set([...(definition.optionalIngredients ?? []), ...(definition.allowedIngredientChoices ?? [])])
}

function selectionUsesPrep(selection: MealSelection): boolean {
  return "usesPriorNightPrep" in selection && selection.usesPriorNightPrep === true
}

function selectionAliases(selection: MealSelection): Record<string, string> {
  return "ingredientAliasesUsed" in selection ? (selection.ingredientAliasesUsed ?? {}) : {}
}

function validateProposal(proposal: NewMealProposal): string | undefined {
  if (!proposal.name.trim()) return "name is required"
  if (!proposal.vegetarian) return "new meals must be vegetarian"
  if (!proposal.principalIngredients.length) return "principalIngredients is required"
  if (!proposal.suitableSlots.length) return "suitableSlots is required"
  if (!proposal.ingredients.length) return "ingredients is required"
  if (!Number.isFinite(proposal.cookMinutes) || proposal.cookMinutes < 0) return "cookMinutes must be non-negative"
  if (!["none", "optional", "required"].includes(proposal.priorNightPrep)) return "invalid priorNightPrep"
  return undefined
}

function definitionFromProposal(proposal: NewMealProposal, id: string): MealDefinition {
  return {
    id,
    name: proposal.name.trim(),
    principalIngredients: proposal.principalIngredients,
    vegetarian: true,
    suitableSlots: proposal.suitableSlots,
    packedFood: proposal.packedFood,
    typicalCookMinutes: proposal.cookMinutes,
    priorNightPrep: proposal.priorNightPrep,
    requiredIngredients: proposal.ingredients,
    optionalIngredients: [],
    status: "provisional",
  }
}

function isKnown(selection: MealSelection): selection is Extract<MealSelection, { mealDefinitionId: string }> {
  return "mealDefinitionId" in selection
}

function isProvisional(selection: MealSelection): selection is Extract<MealSelection, { provisionalMealId: string }> {
  return "provisionalMealId" in selection
}

/**
 * Converts the compact LLM selection contract to the durable MealCell contract.
 * This is intentionally separate from evaluation so no generated metadata reaches
 * the evaluator, persistence, rendering, or recipe-video enrichment layers.
 */
export function hydrateMealPlan(
  selectionCandidate: MealPlanSelectionCandidate,
  context: MealPlanContext,
  createId: () => string = () => `provisional_${crypto.randomUUID()}`,
): MealPlanHydrationResult {
  const failures: MealPlanFailure[] = []
  const established = (context.profile.mealDefinitions ?? []).filter(
    (definition) => definition.status === "established",
  )
  const inherited = context.provisionalMealDefinitions ?? []
  const definitionById = new Map([...established, ...inherited].map((definition) => [definition.id, definition]))
  const allNames = new Set([...established, ...inherited].flatMap(definitionNames))
  const generated: MealDefinition[] = []
  const generatedNames = new Set<string>()
  const grid: Record<string, Record<string, MealCell>> = {}
  const availableIngredientNames = [
    ...context.weeklyInventory.items.filter((item) => item.status !== "unavailable").map((item) => item.name),
    ...context.profile.pantryBaseline,
    ...selectionCandidate.easyBuys,
  ]
  const availableIngredients = new Map(availableIngredientNames.map((name) => [normalized(name), name]))
  const unavailableIngredients = new Set(
    context.weeklyInventory.items.filter((item) => item.status === "unavailable").map((item) => normalized(item.name)),
  )

  for (const [day, selections] of Object.entries(selectionCandidate.grid)) {
    const cells: Record<string, MealCell> = {}
    grid[day] = cells
    for (const [slotId, selection] of Object.entries(selections)) {
      let definition: MealDefinition | undefined
      if (isKnown(selection)) {
        definition = definitionById.get(selection.mealDefinitionId)
        if (definition?.status !== "established") {
          failures.push({
            code: "unknown_meal_definition",
            day,
            slot: slotId,
            detail: `unknown established meal definition "${selection.mealDefinitionId}"`,
          })
          continue
        }
      } else if (isProvisional(selection)) {
        definition = definitionById.get(selection.provisionalMealId)
        if (definition?.status !== "provisional") {
          failures.push({
            code: "unknown_meal_definition",
            day,
            slot: slotId,
            detail: `unknown provisional meal definition "${selection.provisionalMealId}"`,
          })
          continue
        }
      } else {
        if (!context.profile.allowNewFoods) {
          failures.push({
            code: "new_meal_not_allowed",
            day,
            slot: slotId,
            detail: "new meals are disabled for this household",
          })
          continue
        }
        const invalid = validateProposal(selection.proposedMeal)
        const name = normalized(selection.proposedMeal.name)
        if (invalid) {
          failures.push({ code: "invalid_new_meal", day, slot: slotId, detail: invalid })
          continue
        }
        if (allNames.has(name) || generatedNames.has(name)) {
          failures.push({
            code: "duplicate_meal_selection",
            day,
            slot: slotId,
            detail: `new meal "${selection.proposedMeal.name}" duplicates an existing meal`,
          })
          continue
        }
        definition = definitionFromProposal(selection.proposedMeal, createId())
        generated.push(definition)
        generatedNames.add(name)
      }

      const choices = "ingredientChoices" in selection ? (selection.ingredientChoices ?? []) : []
      const allowed = allowedChoices(definition)
      const seenChoices = new Set<string>()
      const validChoices: string[] = []
      for (const choice of choices) {
        if (seenChoices.has(choice) || !allowed.has(choice)) {
          failures.push({
            code: "invalid_ingredient_choice",
            day,
            slot: slotId,
            detail: `ingredient choice "${choice}" is not permitted by ${definition.id}`,
          })
        } else {
          validChoices.push(choice)
        }
        seenChoices.add(choice)
      }
      const ingredients = [...definition.requiredIngredients, ...validChoices]
      const aliases = selectionAliases(selection)
      const aliasByTarget = new Map<string, string>()
      const usedSources = new Set<string>()
      for (const [source, target] of Object.entries(aliases)) {
        const sourceKey = normalized(source)
        const targetKey = normalized(target)
        const availableSource = availableIngredients.get(sourceKey)
        if (
          !sourceKey ||
          !targetKey ||
          !availableSource ||
          !ingredients.some((ingredient) => normalized(ingredient) === targetKey) ||
          aliasByTarget.has(targetKey) ||
          usedSources.has(sourceKey)
        ) {
          failures.push({
            code: "invalid_ingredient_alias",
            day,
            slot: slotId,
            detail: `ingredient alias "${source}" → "${target}" cannot resolve this meal`,
          })
          continue
        }
        aliasByTarget.set(targetKey, availableSource)
        usedSources.add(sourceKey)
      }
      const resolvedIngredients = ingredients.map((ingredient) => {
        const key = normalized(ingredient)
        const direct = availableIngredients.get(key)
        if (direct) return direct
        const aliased = aliasByTarget.get(key)
        if (aliased) return aliased
        if (unavailableIngredients.has(key) || !availableIngredients.has(key)) {
          failures.push({
            code: "required_ingredient_unavailable",
            day,
            slot: slotId,
            detail: `required ingredient "${ingredient}" is unavailable`,
          })
        }
        return ingredient
      })

      const slot = context.schedule.slots.find((candidate) => candidate.id === slotId)
      if (!definition.suitableSlots.includes(slotId)) {
        failures.push({
          code: "slot_unsuitable",
          day,
          slot: slotId,
          detail: `${definition.name} is not suitable for ${slotId}`,
        })
      }
      if (slot?.packed) {
        if (!definition.packedFood?.suitable || (slot.dry && !definition.packedFood.dry)) {
          failures.push({
            code: "packed_slot_unsuitable",
            day,
            slot: slotId,
            detail: `${definition.name} is not suitable for this packed slot`,
          })
        }
      }

      const priorNightPrep =
        definition.priorNightPrep === "required" ||
        (definition.priorNightPrep === "optional" && selectionUsesPrep(selection))
      cells[slotId] = {
        dish: definition.name,
        vegetarian: true,
        items: resolvedIngredients,
        cookMinutes: definition.typicalCookMinutes,
        priorNightPrep,
      }
    }
  }

  return {
    candidate:
      failures.length === 0
        ? { grid, easyBuys: selectionCandidate.easyBuys, policyOutcomes: selectionCandidate.policyOutcomes }
        : undefined,
    provisionalMealDefinitions: [...inherited, ...generated],
    failures,
  }
}

/**
 * Hydrates only a revision's changed selections, then overlays them on the
 * authoritative active candidate. Omitted cells remain byte-for-byte the
 * existing hydrated MealCells; the model never has to reverse-map them to
 * opaque catalog IDs.
 */
export function hydrateMealPlanPatch(
  patch: MealPlanSelectionPatch,
  base: MealPlanCandidate,
  context: MealPlanContext,
  createId: () => string = () => `provisional_${crypto.randomUUID()}`,
): MealPlanHydrationResult {
  const hydrated = hydrateMealPlan(
    {
      grid: patch.grid,
      easyBuys: patch.easyBuys ?? base.easyBuys,
      policyOutcomes: patch.policyOutcomes ?? base.policyOutcomes,
    },
    context,
    createId,
  )
  if (!hydrated.candidate) return hydrated

  const grid: Record<string, Record<string, MealCell>> = {}
  for (const [day, cells] of Object.entries(base.grid)) grid[day] = { ...cells }
  for (const [day, cells] of Object.entries(hydrated.candidate.grid)) {
    grid[day] = { ...(grid[day] ?? {}), ...cells }
  }
  return {
    ...hydrated,
    candidate: { ...hydrated.candidate, grid },
  }
}
