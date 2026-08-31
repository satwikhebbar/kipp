import type {
  MealCatalogExpansionInput,
  MealDefinition,
  MealDefinitionProposal,
  MealDefinitionValidationFailure,
} from "./types"

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function invalid(dishName: string, code: string, detail: string): MealDefinitionValidationFailure {
  return { dishName, code, detail }
}

function validateNames(
  dishName: string,
  field: string,
  values: string[],
  required: boolean,
): MealDefinitionValidationFailure[] {
  const failures: MealDefinitionValidationFailure[] = []
  if (required && values.length === 0) failures.push(invalid(dishName, "missing_field", `${field} is required`))
  const seen = new Set<string>()
  for (const value of values) {
    const key = normalized(value)
    if (!key) failures.push(invalid(dishName, "blank_value", `${field} cannot contain a blank value`))
    else if (seen.has(key))
      failures.push(invalid(dishName, "duplicate_value", `${field} cannot contain duplicate values`))
    seen.add(key)
  }
  return failures
}

/** Validates a model proposal before it can become a household-owned definition. */
export function validateMealDefinitionProposal(
  proposal: MealDefinitionProposal | undefined,
  expectedDishName: string,
  input: Pick<MealCatalogExpansionInput, "schedule">,
): MealDefinitionValidationFailure[] {
  if (!proposal) return [invalid(expectedDishName, "missing_definition", "no definition was returned for this dish")]
  const failures: MealDefinitionValidationFailure[] = []
  if (proposal.sourceDishName !== expectedDishName)
    failures.push(
      invalid(expectedDishName, "source_name_mismatch", "sourceDishName must match the supplied parent dish name"),
    )
  if (!proposal.name.trim()) failures.push(invalid(expectedDishName, "missing_field", "name is required"))
  if (!proposal.vegetarian)
    failures.push(invalid(expectedDishName, "invalid_vegetarian", "school meal definitions must be vegetarian"))
  if (!Number.isInteger(proposal.typicalCookMinutes) || proposal.typicalCookMinutes < 0)
    failures.push(
      invalid(expectedDishName, "invalid_cook_minutes", "typicalCookMinutes must be a non-negative integer"),
    )
  if (!["none", "optional", "required"].includes(proposal.priorNightPrep))
    failures.push(
      invalid(expectedDishName, "invalid_prior_night_prep", "priorNightPrep must be none, optional, or required"),
    )
  failures.push(...validateNames(expectedDishName, "principalIngredients", proposal.principalIngredients, true))
  failures.push(...validateNames(expectedDishName, "suitableSlots", proposal.suitableSlots, true))
  failures.push(...validateNames(expectedDishName, "requiredIngredients", proposal.requiredIngredients, true))
  failures.push(...validateNames(expectedDishName, "optionalIngredients", proposal.optionalIngredients, false))
  failures.push(
    ...validateNames(expectedDishName, "allowedIngredientChoices", proposal.allowedIngredientChoices ?? [], false),
  )
  const slotById = new Map(input.schedule.slots.map((slot) => [slot.id, slot]))
  for (const slot of proposal.suitableSlots) {
    const scheduleSlot = slotById.get(slot)
    if (!scheduleSlot) {
      failures.push(invalid(expectedDishName, "unknown_slot", `suitableSlots contains unknown slot "${slot}"`))
    } else if (
      Number.isInteger(proposal.typicalCookMinutes) &&
      proposal.typicalCookMinutes >= 0 &&
      scheduleSlot.maxCookMinutes !== null &&
      proposal.typicalCookMinutes > scheduleSlot.maxCookMinutes
    ) {
      failures.push(
        invalid(
          expectedDishName,
          "slot_cook_time_exceeded",
          `${proposal.typicalCookMinutes} cook minutes exceeds ${slot}'s ${scheduleSlot.maxCookMinutes}-minute limit`,
        ),
      )
    }
  }
  const required = new Set(proposal.requiredIngredients.map(normalized))
  for (const ingredient of [...proposal.optionalIngredients, ...(proposal.allowedIngredientChoices ?? [])]) {
    if (required.has(normalized(ingredient)))
      failures.push(
        invalid(expectedDishName, "ingredient_overlap", "required ingredients cannot also be optional choices"),
      )
  }
  return failures
}

/** Adds server-owned identity, status, alias, and trusted packing suitability to a validated proposal. */
export function establishMealDefinition(
  proposal: MealDefinitionProposal,
  parentDishName: string,
  id: string,
): MealDefinition {
  return {
    id,
    name: proposal.name.trim(),
    aliases: [parentDishName],
    principalIngredients: proposal.principalIngredients.map((value) => value.trim()),
    vegetarian: true,
    suitableSlots: proposal.suitableSlots,
    packedFood: { suitable: true, dry: proposal.packedFood.dry },
    typicalCookMinutes: proposal.typicalCookMinutes,
    priorNightPrep: proposal.priorNightPrep,
    requiredIngredients: proposal.requiredIngredients.map((value) => value.trim()),
    optionalIngredients: proposal.optionalIngredients.map((value) => value.trim()),
    ...(proposal.allowedIngredientChoices
      ? { allowedIngredientChoices: proposal.allowedIngredientChoices.map((value) => value.trim()) }
      : {}),
    status: "established",
  }
}
