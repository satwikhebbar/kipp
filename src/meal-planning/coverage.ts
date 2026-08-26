import type { MealPlanContext, MealSlot } from "./types"

export interface CoverageSet {
  /** The required (day, slotId) cells the evaluator checks, minus closed days and half-day-dropped slots. */
  required: Array<{ day: string; slotId: string }>
  /** Days marked `school_closed`; no cells are allowed on these days. */
  closedDays: string[]
  /** Slot cells removed from the required set by `half_day` exceptions. */
  droppedSlots: Array<{ day: string; slotId: string }>
}

/** Resolves an entry to a configured slot id by exact id, then exact name. */
export function resolveSlotId(entry: string, slots: MealSlot[]): string | undefined {
  return slots.find((slot) => slot.id === entry)?.id ?? slots.find((slot) => slot.name === entry)?.id
}

/** Resolves an exception's meal-slot reference to configured slot ids. */
export function resolveMealSlots(mealSlots: string[] | undefined, slots: MealSlot[]): string[] {
  if (!mealSlots) return []
  const resolved: string[] = []
  for (const entry of mealSlots) {
    const slotId = resolveSlotId(entry, slots)
    if (slotId) resolved.push(slotId)
  }
  return resolved
}

/**
 * Computes the effective coverage set: configured days minus `school_closed`
 * days and minus slots dropped by `half_day` exceptions. This is the source
 * of truth for `missing_slot` / `extra_slot_for_closed_day` in the evaluator.
 */
export function computeCoverageSet(context: MealPlanContext): CoverageSet {
  const { schedule, weeklyExceptions } = context
  const closedDays = weeklyExceptions.items
    .filter((exception) => exception.kind === "school_closed" && exception.appliesTo?.day)
    .map((exception) => exception.appliesTo?.day as string)
  const closed = new Set(closedDays)

  const droppedSlots: Array<{ day: string; slotId: string }> = []
  for (const exception of weeklyExceptions.items) {
    const day = exception.appliesTo?.day
    if (exception.kind !== "half_day" || !day) continue
    for (const slotId of resolveMealSlots(exception.appliesTo?.mealSlots, schedule.slots)) {
      if (!closed.has(day)) droppedSlots.push({ day, slotId })
    }
  }
  const dropped = new Set(droppedSlots.map((drop) => `${drop.day}\u0000${drop.slotId}`))

  const required: Array<{ day: string; slotId: string }> = []
  for (const day of schedule.days) {
    if (closed.has(day)) continue
    for (const slot of schedule.slots) {
      if (dropped.has(`${day}\u0000${slot.id}`)) continue
      required.push({ day, slotId: slot.id })
    }
  }
  return { required, closedDays, droppedSlots }
}
