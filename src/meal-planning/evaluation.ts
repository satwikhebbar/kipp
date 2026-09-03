import { computeCoverageSet } from "./coverage"
import { hydrateMealPlan, hydrateMealPlanPatch } from "./hydration"
import { normalizeIngredient } from "./ingredient-normalization"
import type {
  MealCell,
  MealGrid,
  MealPlanCandidate,
  MealPlanContext,
  MealPlanEvaluation,
  MealPlanFailure,
  MealPlanMeasurements,
  MealPlanSelectionCandidate,
  MealPlanSelectionEvaluation,
  MealPlanSelectionPatch,
  MealSlot,
} from "./types"

const MAX_PRIOR_NIGHT_PREP_PER_DAY = 2
const DEFAULT_URGENT_USE_BY_DAY = "Tue"

interface GridCellRef {
  day: string
  slotId: string
  cell: MealCell
}

/**
 * Evaluates the LLM-facing selection contract as one deterministic operation:
 * first validate and hydrate definitions, then apply the existing candidate
 * evaluator. The hydrated candidate is returned only when it is valid enough
 * to be evaluated or persisted.
 */
export function evaluateMealPlanSelection(
  selectionCandidate: MealPlanSelectionCandidate,
  context: MealPlanContext,
): MealPlanSelectionEvaluation {
  const hydration = hydrateMealPlan(selectionCandidate, context)
  if (!hydration.candidate) {
    return {
      ...hydration,
      evaluation: {
        pass: false,
        failures: hydration.failures,
        measurements: {
          morningCookByDay: {},
          morningCookMax: 0,
          priorNightPrepByDay: {},
          priorNightPrepMax: 0,
          dishRepeatCount: 0,
          dishRepeats: [],
          inventoryUsed: [],
          easyBuyCount: selectionCandidate.easyBuys.length,
        },
      },
    }
  }
  return { ...hydration, evaluation: evaluateMealPlan(hydration.candidate, context) }
}

/** Evaluates a revision patch after hydrating and merging it into the active plan. */
export function evaluateMealPlanSelectionPatch(
  patch: MealPlanSelectionPatch,
  base: MealPlanCandidate,
  context: MealPlanContext,
): MealPlanSelectionEvaluation {
  const hydration = hydrateMealPlanPatch(patch, base, context)
  if (!hydration.candidate) {
    return {
      ...hydration,
      evaluation: {
        pass: false,
        failures: hydration.failures,
        measurements: {
          morningCookByDay: {},
          morningCookMax: 0,
          priorNightPrepByDay: {},
          priorNightPrepMax: 0,
          dishRepeatCount: 0,
          dishRepeats: [],
          inventoryUsed: [],
          easyBuyCount: patch.easyBuys?.length ?? base.easyBuys.length,
        },
      },
    }
  }
  return { ...hydration, evaluation: evaluateMealPlan(hydration.candidate, context) }
}

/** Enumerates every (day, slotId, cell) triple in a grid, in insertion order. */
function cellsIn(grid: MealGrid): GridCellRef[] {
  const refs: GridCellRef[] = []
  for (const [day, slots] of Object.entries(grid)) {
    for (const [slotId, cell] of Object.entries(slots)) refs.push({ day, slotId, cell })
  }
  return refs
}

/** Looks up a configured slot by its id. */
function slotById(schedule: MealPlanContext["schedule"], slotId: string): MealSlot | undefined {
  return schedule.slots.find((slot) => slot.id === slotId)
}

/** True when two cells are structurally identical (dish, vegetarian flag, items, cook minutes, prep flag). */
function cellsEqual(a: MealCell, b: MealCell): boolean {
  return (
    a.dish === b.dish &&
    a.vegetarian === b.vegetarian &&
    a.cookMinutes === b.cookMinutes &&
    a.priorNightPrep === b.priorNightPrep &&
    a.items.length === b.items.length &&
    a.items.every((item, index) => item === b.items[index])
  )
}

/** True when a (day, slot) position falls within a feedback scope. */
function inFeedbackScope(scope: { day?: string; slot?: string }, day: string, slotId: string): boolean {
  if (!scope.day || scope.day !== day) return false
  return scope.slot === undefined || scope.slot === slotId
}

/** Locale-independent total ordering for two optional strings (empty sorts first). */
function compareOptional(a: string | undefined, b: string | undefined): number {
  const left = a ?? ""
  const right = b ?? ""
  return left < right ? -1 : left > right ? 1 : 0
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

  const clearExclusionTokens = new Set(profile.dietaryExclusions.map(normalizeIngredient))
  const unavailableItems = new Set(
    weeklyInventory.items.filter((item) => item.status === "unavailable").map((item) => normalizeIngredient(item.name)),
  )
  const knownItems = new Set([
    ...weeklyInventory.items
      .filter((item) => item.status !== "unavailable")
      .map((item) => normalizeIngredient(item.name)),
    ...profile.pantryBaseline.map(normalizeIngredient),
    ...candidate.easyBuys.map(normalizeIngredient),
  ])
  const recentDishes = new Set(
    Object.values(context.recentPlan ?? {}).flatMap((slots) => Object.values(slots).map((cell) => cell.dish)),
  )
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
    for (const token of cell.items) {
      if (clearExclusionTokens.has(normalizeIngredient(token))) {
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
    for (const item of cell.items) {
      if (unavailableItems.has(normalizeIngredient(item))) {
        failures.push({
          code: "inventory_item_unavailable",
          day,
          slot: slotId,
          detail: `item "${item}" is unavailable`,
        })
      } else if (!knownItems.has(normalizeIngredient(item))) {
        failures.push({
          code: "inventory_item_unknown",
          day,
          slot: slotId,
          detail: `item "${item}" is not in inventory, pantry, or easy buys`,
        })
      }
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

  const revisionChangedCells: Array<{ day: string; slotId: string }> = []
  const revisionDishChangedCells: Array<{ day: string; slotId: string }> = []
  if (request.kind === "revision" && context.recentPlan) {
    const recent = context.recentPlan
    const positions = new Set<string>([
      ...Object.keys(candidate.grid).flatMap((day) =>
        Object.keys(candidate.grid[day] ?? {}).map((slotId) => `${day}\u0000${slotId}`),
      ),
      ...Object.keys(recent).flatMap((day) => Object.keys(recent[day] ?? {}).map((slotId) => `${day}\u0000${slotId}`)),
    ])
    for (const position of positions) {
      const [day, slotId] = position.split("\u0000") as [string, string]
      const before = recent[day]?.[slotId]
      const after = candidate.grid[day]?.[slotId]
      if (before === undefined || after === undefined || !cellsEqual(before, after)) {
        revisionChangedCells.push({ day, slotId })
      }
      if (after && (before === undefined || before.dish !== after.dish)) {
        revisionDishChangedCells.push({ day, slotId })
      }
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
  const recentRepeatDishes = new Set<string>()
  if (request.kind === "revision") {
    for (const { day, slotId } of revisionDishChangedCells) {
      const after = candidate.grid[day]?.[slotId]
      if (after) recentRepeatDishes.add(after.dish)
    }
  } else {
    for (const dish of candidateDishes) recentRepeatDishes.add(dish)
  }
  // Escape hatch for cross-week variety: a fruit or dry snack that appears only in snack slots may
  // repeat from the previous week. This is deliberately narrow (snack slots only, cross-week only):
  // within-week distinctness and cooked-meal repeats are still enforced, so the model is not nudged
  // toward leaning on fruit snacks over introducing new ones.
  const snackSlotIds = new Set(schedule.slots.filter((slot) => slot.dry).map((slot) => slot.id))
  const snackOnlyDishes = new Set<string>()
  for (const ref of refs) {
    if (!snackSlotIds.has(ref.slotId)) snackOnlyDishes.delete(ref.cell.dish)
    else snackOnlyDishes.add(ref.cell.dish)
  }
  for (const dish of recentDishes) {
    if (recentRepeatDishes.has(dish) && !snackOnlyDishes.has(dish)) repeatedDishes.add(dish)
  }
  const dishRepeats = [...repeatedDishes].filter((dish) => !favourites.has(dish) && !requestedRepeats.has(dish)).sort()
  for (const dish of dishRepeats) {
    failures.push({
      code: "dish_repeated",
      detail: `dish "${dish}" is repeated without a favourite or requested-repeat exemption`,
    })
  }

  if (context.requireUrgentUseEarly) {
    const urgentUseByDay = context.urgentUseByDay ?? DEFAULT_URGENT_USE_BY_DAY
    const urgentIndex = dayIndex.get(urgentUseByDay) ?? schedule.days.length
    for (const item of weeklyInventory.items.filter((entry) => entry.useNote === "use early")) {
      const useIndexes = refs
        .filter((ref) => ref.cell.items.some((value) => normalizeIngredient(value) === normalizeIngredient(item.name)))
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
    for (const { day, slotId } of revisionChangedCells) {
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
      const addressedByCell = revisionChangedCells.some(
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

  const inventoryUsed = [...new Set(refs.flatMap((ref) => ref.cell.items))].sort()
  const measurements: MealPlanMeasurements = {
    morningCookByDay,
    morningCookMax: Object.values(morningCookByDay).reduce((max, value) => Math.max(max, value), 0),
    priorNightPrepByDay,
    priorNightPrepMax: Object.values(priorNightPrepByDay).reduce((max, value) => Math.max(max, value), 0),
    dishRepeatCount: dishRepeats.length,
    dishRepeats,
    inventoryUsed,
    easyBuyCount: candidate.easyBuys.length,
  }
  if (context.requireUrgentUseEarly) {
    const useIndexes = weeklyInventory.items
      .filter((item) => item.useNote === "use early")
      .flatMap((item) =>
        refs
          .filter((ref) =>
            ref.cell.items.some((value) => normalizeIngredient(value) === normalizeIngredient(item.name)),
          )
          .map((ref) => dayIndex.get(ref.day) ?? Number.POSITIVE_INFINITY),
      )
    const earliest = Math.min(...useIndexes)
    if (Number.isFinite(earliest)) measurements.urgentUseByDay = schedule.days[earliest]
  }

  failures.sort((a, b) => {
    const byCode = compareOptional(a.code, b.code)
    if (byCode !== 0) return byCode
    const byDay = compareOptional(a.day, b.day)
    if (byDay !== 0) return byDay
    const bySlot = compareOptional(a.slot, b.slot)
    if (bySlot !== 0) return bySlot
    return compareOptional(a.detail, b.detail)
  })

  return { pass: failures.length === 0, failures, measurements }
}
