import { computeCoverageSet } from "./corpus/load"
import type {
  MealCell,
  MealGrid,
  MealPlanCandidate,
  MealPlanContext,
  MealPlanEvaluation,
  MealPlanFailure,
  MealPlanMeasurements,
  MealSlot,
} from "./types"

const MAX_PRIOR_NIGHT_PREP_PER_DAY = 2
const MAX_PRINCIPAL_INGREDIENT_CELLS = 2
const DEFAULT_URGENT_USE_BY_DAY = "Tue"

interface GridCellRef {
  day: string
  slotId: string
  cell: MealCell
}

function cellsIn(grid: MealGrid): GridCellRef[] {
  const refs: GridCellRef[] = []
  for (const [day, slots] of Object.entries(grid)) {
    for (const [slotId, cell] of Object.entries(slots)) refs.push({ day, slotId, cell })
  }
  return refs
}

function slotById(schedule: MealPlanContext["schedule"], slotId: string): MealSlot | undefined {
  return schedule.slots.find((slot) => slot.id === slotId)
}

function cellsEqual(a: MealCell, b: MealCell): boolean {
  return (
    a.dish === b.dish &&
    a.vegetarian === b.vegetarian &&
    a.cookMinutes === b.cookMinutes &&
    a.priorNightPrep === b.priorNightPrep &&
    a.ingredients.length === b.ingredients.length &&
    a.inventoryItems.length === b.inventoryItems.length &&
    a.ingredients.every((item, index) => item === b.ingredients[index]) &&
    a.inventoryItems.every((item, index) => item === b.inventoryItems[index])
  )
}

function inFeedbackScope(scope: { day?: string; slot?: string }, day: string, slotId: string): boolean {
  if (!scope.day || scope.day !== day) return false
  return scope.slot === undefined || scope.slot === slotId
}

/**
 * Evaluates one structured meal-plan candidate against the household context.
 * Pure, synchronous, deterministic: returns typed failures and measurements,
 * never user-facing prose. Owns only rules with structured, reliable
 * semantics (see the meal-planning evaluation corpus plan, section 6).
 */
export function evaluateMealPlan(candidate: MealPlanCandidate, context: MealPlanContext): MealPlanEvaluation {
  const failures: MealPlanFailure[] = []
  const { schedule, profile, weeklyInventory, request } = context
  const coverage = computeCoverageSet(context)
  const closedDays = new Set(coverage.closedDays)
  const dayIndex = new Map(schedule.days.map((day, index) => [day, index]))
  const morningSlotIds = new Set(
    schedule.slots.filter((slot) => slot.packed || slot.id === "breakfast").map((slot) => slot.id),
  )
  const refs = cellsIn(candidate.grid)
  const refsByDay = new Map<string, GridCellRef[]>()
  for (const ref of refs) {
    const list = refsByDay.get(ref.day) ?? []
    list.push(ref)
    refsByDay.set(ref.day, list)
  }

  const clearExclusionTokens = new Set(
    profile.dietaryExclusions.filter((exclusion) => !exclusion.ambiguous).map((exclusion) => exclusion.token),
  )
  const unavailableItems = new Set(
    weeklyInventory.items.filter((item) => item.status === "unavailable").map((item) => item.name),
  )
  const knownItems = new Set([
    ...weeklyInventory.items.filter((item) => item.status !== "unavailable").map((item) => item.name),
    ...profile.pantryBaseline,
    ...candidate.easyBuys,
  ])
  const recentDishes = new Set(
    Object.values(context.recentPlan ?? {}).flatMap((slots) => Object.values(slots).map((cell) => cell.dish)),
  )
  const repertoire = new Set([...profile.dishRepertoire, ...recentDishes])
  const favourites = new Set(profile.foodPreferences.favourites)
  const requestedRepeats = new Set(context.requestedRepeats ?? [])
  const persistentPolicies = context.customPolicies.filter((policy) => policy.scope === "persistent")

  const presentCells = new Set(refs.map((ref) => `${ref.day}\u0000${ref.slotId}`))
  for (const cell of coverage.required) {
    if (!presentCells.has(`${cell.day}\u0000${cell.slotId}`)) {
      failures.push({
        code: "missing_slot",
        day: cell.day,
        slot: cell.slotId,
        detail: `no cell for ${cell.day} ${cell.slotId}`,
      })
    }
  }

  for (const ref of refs) {
    const { day, slotId, cell } = ref
    if (closedDays.has(day)) {
      failures.push({ code: "extra_slot_for_closed_day", day, slot: slotId, detail: `cell on closed day ${day}` })
    }
    for (const token of cell.ingredients) {
      if (clearExclusionTokens.has(token)) {
        failures.push({ code: "hard_exclusion", day, slot: slotId, detail: `ingredient "${token}" is excluded` })
      }
    }
    if (dayIndex.has(day) && !closedDays.has(day) && !cell.vegetarian) {
      failures.push({
        code: "non_vegetarian_school_meal",
        day,
        slot: slotId,
        detail: "non-vegetarian cell on a school day",
      })
    }
    const slot = slotById(schedule, slotId)
    if (slot?.maxCookMinutes != null && cell.cookMinutes > slot.maxCookMinutes) {
      failures.push({
        code: "slot_unsuitable",
        day,
        slot: slotId,
        detail: `cookMinutes ${cell.cookMinutes} exceeds slot maximum ${slot.maxCookMinutes}`,
      })
    }
    if (!profile.priorNightPrepAllowed && cell.priorNightPrep) {
      failures.push({
        code: "prior_night_prep_not_allowed",
        day,
        slot: slotId,
        detail: "prior-night prep is not allowed",
      })
    }
    for (const item of cell.inventoryItems) {
      if (unavailableItems.has(item)) {
        failures.push({
          code: "inventory_item_unavailable",
          day,
          slot: slotId,
          detail: `item "${item}" is unavailable`,
        })
      } else if (!knownItems.has(item)) {
        failures.push({
          code: "inventory_item_unknown",
          day,
          slot: slotId,
          detail: `item "${item}" is not in inventory, pantry, or easy buys`,
        })
      }
    }
    if (!profile.allowNewFoods && !repertoire.has(cell.dish)) {
      failures.push({
        code: "unfamiliar_dish_not_allowed",
        day,
        slot: slotId,
        detail: `dish "${cell.dish}" is not in the repertoire`,
      })
    }
  }

  const morningCookByDay: Record<string, number> = {}
  const priorNightPrepByDay: Record<string, number> = {}
  for (const day of schedule.days) {
    if (closedDays.has(day)) continue
    const dayRefs = refsByDay.get(day) ?? []
    const morningCook = dayRefs.reduce(
      (sum, ref) => (morningSlotIds.has(ref.slotId) ? sum + ref.cell.cookMinutes : sum),
      0,
    )
    const prepCount = dayRefs.filter((ref) => ref.cell.priorNightPrep).length
    morningCookByDay[day] = morningCook
    priorNightPrepByDay[day] = prepCount
    if (morningCook > profile.morningCookingBudgetMinutes) {
      failures.push({
        code: "morning_capacity_exceeded",
        day,
        detail: `morning cook ${morningCook} exceeds budget ${profile.morningCookingBudgetMinutes}`,
      })
    }
    if (prepCount > MAX_PRIOR_NIGHT_PREP_PER_DAY) {
      failures.push({
        code: "prior_night_prep_limit",
        day,
        detail: `${prepCount} prior-night-prep cells exceed the daily limit of ${MAX_PRIOR_NIGHT_PREP_PER_DAY}`,
      })
    }
  }

  const weekDishCounts = new Map<string, number>()
  const candidateDishes = new Set<string>()
  for (const ref of refs) {
    candidateDishes.add(ref.cell.dish)
    weekDishCounts.set(ref.cell.dish, (weekDishCounts.get(ref.cell.dish) ?? 0) + 1)
  }
  const repeatedDishes = new Set<string>()
  for (const [dish, count] of weekDishCounts) {
    if (count > 1) repeatedDishes.add(dish)
  }
  for (const dish of recentDishes) {
    if (request.kind !== "revision" && candidateDishes.has(dish)) repeatedDishes.add(dish)
  }
  const dishRepeats = [...repeatedDishes].filter((dish) => !favourites.has(dish) && !requestedRepeats.has(dish)).sort()
  for (const dish of dishRepeats) {
    failures.push({
      code: "dish_repeated",
      detail: `dish "${dish}" is repeated without a favourite or requested-repeat exemption`,
    })
  }

  const ingredientCellCounts = new Map<string, number>()
  for (const ref of refs) {
    for (const ingredient of ref.cell.ingredients) {
      ingredientCellCounts.set(ingredient, (ingredientCellCounts.get(ingredient) ?? 0) + 1)
    }
  }
  let principalIngredientMax = 0
  const principalIngredientOverused: string[] = []
  for (const [ingredient, count] of ingredientCellCounts) {
    if (profile.allowFrequentIngredients.includes(ingredient)) continue
    principalIngredientMax = Math.max(principalIngredientMax, count)
    if (count > MAX_PRINCIPAL_INGREDIENT_CELLS && !requestedRepeats.has(ingredient)) {
      principalIngredientOverused.push(ingredient)
      failures.push({
        code: "principal_ingredient_overused",
        detail: `ingredient "${ingredient}" appears in ${count} cells`,
      })
    }
  }
  principalIngredientOverused.sort()

  if (profile.allowNewFoods) {
    for (const ref of refs) {
      if (repertoire.has(ref.cell.dish)) continue
      const dayHasFamiliar = (refsByDay.get(ref.day) ?? []).some((other) => repertoire.has(other.cell.dish))
      if (!dayHasFamiliar) {
        failures.push({
          code: "unpaired_new_dish",
          day: ref.day,
          slot: ref.slotId,
          detail: `new dish "${ref.cell.dish}" is not paired with a familiar dish`,
        })
      }
    }
  }

  if (context.requireUrgentUseEarly) {
    const urgentUseByDay = context.urgentUseByDay ?? DEFAULT_URGENT_USE_BY_DAY
    const urgentIndex = dayIndex.get(urgentUseByDay) ?? schedule.days.length
    for (const item of weeklyInventory.items.filter((entry) => entry.useNote === "use early")) {
      const useIndexes = refs
        .filter((ref) => ref.cell.inventoryItems.includes(item.name))
        .map((ref) => dayIndex.get(ref.day) ?? Number.POSITIVE_INFINITY)
      const firstUseIndex = Math.min(...useIndexes)
      if (firstUseIndex > urgentIndex) {
        failures.push({
          code: "use_early_ignored",
          detail: `use-early item "${item.name}" is first used after ${urgentUseByDay}`,
        })
      }
    }
  }

  for (const policy of persistentPolicies) {
    if (!candidate.policyOutcomes[policy.id]) {
      failures.push({
        code: "missing_policy_outcome",
        detail: `no recorded outcome for persistent policy "${policy.id}"`,
      })
    }
  }

  const feedbackItems = context.feedbackItems ?? []
  if (request.kind === "revision" && context.recentPlan) {
    const recent = context.recentPlan
    const positions = new Set<string>([
      ...Object.keys(candidate.grid).flatMap((day) =>
        Object.keys(candidate.grid[day] ?? {}).map((slotId) => `${day}\u0000${slotId}`),
      ),
      ...Object.keys(recent).flatMap((day) => Object.keys(recent[day] ?? {}).map((slotId) => `${day}\u0000${slotId}`)),
    ])
    const changedCells: Array<{ day: string; slotId: string }> = []
    for (const position of positions) {
      const [day, slotId] = position.split("\u0000") as [string, string]
      const before = recent[day]?.[slotId]
      const after = candidate.grid[day]?.[slotId]
      if (before === undefined || after === undefined || !cellsEqual(before, after)) changedCells.push({ day, slotId })
    }
    for (const { day, slotId } of changedCells) {
      const scoped = feedbackItems.some((item) => item.scope && inFeedbackScope(item.scope, day, slotId))
      if (!scoped) {
        failures.push({
          code: "unscoped_cell_changed",
          day,
          slot: slotId,
          detail: "cell changed outside feedback scope",
        })
      }
    }
    for (const item of feedbackItems) {
      const addressedByCell = changedCells.some(
        ({ day, slotId }) => item.scope && inFeedbackScope(item.scope, day, slotId),
      )
      const addressedByRationale = Object.values(candidate.policyOutcomes).some((outcome) =>
        outcome.rationale.includes(item.id),
      )
      if (!addressedByCell && !addressedByRationale) {
        failures.push({
          code: "unaddressed_feedback",
          day: item.scope?.day,
          detail: `feedback "${item.id}" is not addressed by a changed cell or outcome rationale`,
        })
      }
    }
  }

  const inventoryUsed = [...new Set(refs.flatMap((ref) => ref.cell.inventoryItems))].sort()
  const measurements: MealPlanMeasurements = {
    morningCookByDay,
    morningCookMax: Object.values(morningCookByDay).reduce((max, value) => Math.max(max, value), 0),
    priorNightPrepByDay,
    priorNightPrepMax: Object.values(priorNightPrepByDay).reduce((max, value) => Math.max(max, value), 0),
    dishRepeatCount: dishRepeats.length,
    dishRepeats,
    principalIngredientMax,
    principalIngredientOverused,
    inventoryUsed,
    easyBuyCount: candidate.easyBuys.length,
  }
  if (context.requireUrgentUseEarly) {
    const useIndexes = weeklyInventory.items
      .filter((item) => item.useNote === "use early")
      .flatMap((item) =>
        refs
          .filter((ref) => ref.cell.inventoryItems.includes(item.name))
          .map((ref) => dayIndex.get(ref.day) ?? Number.POSITIVE_INFINITY),
      )
    const earliest = Math.min(...useIndexes)
    if (Number.isFinite(earliest)) measurements.urgentUseByDay = schedule.days[earliest]
  }

  failures.sort((a, b) => {
    const byCode = a.code.localeCompare(b.code)
    if (byCode !== 0) return byCode
    const byDay = (a.day ?? "").localeCompare(b.day ?? "")
    if (byDay !== 0) return byDay
    return (a.slot ?? "").localeCompare(b.slot ?? "")
  })

  return { pass: failures.length === 0, failures, measurements }
}
