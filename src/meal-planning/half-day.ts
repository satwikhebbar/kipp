import { legacyHalfDayBehavior } from "./schedule"
import type { MealDefinition, MealPlanContext, MealSlot } from "./types"

export const HALF_DAY_SNACK_SLOT_ID = "snack1"
export const HALF_DAY_SNACK_MAX_COOK_MINUTES = 20

/** Whether a configured day is a recurring or one-off half day. */
export function isHalfDay(context: Pick<MealPlanContext, "schedule" | "weeklyExceptions">, day: string): boolean {
  if (
    context.weeklyExceptions.items.some(
      (exception) => exception.kind === "full_day" && exception.appliesTo?.day === day,
    )
  )
    return false
  return (
    context.schedule.halfDays?.includes(day) === true ||
    context.weeklyExceptions.items.some(
      (exception) => exception.kind === "half_day" && exception.appliesTo?.day === day,
    )
  )
}

/** The configured slots omitted on a half-day. */
export function halfDayDroppedSlotIds(slots: MealSlot[]): string[] {
  return slots
    .filter((slot) => (slot.halfDayBehavior ?? legacyHalfDayBehavior(slot.id)).action === "omit")
    .map((slot) => slot.id)
}

/** Resolves the rules that apply to one slot on one day. */
export function effectiveMealSlot(
  context: Pick<MealPlanContext, "schedule" | "weeklyExceptions">,
  day: string,
  slotId: string,
): MealSlot | undefined {
  const slot = context.schedule.slots.find((candidate) => candidate.id === slotId)
  if (!slot) return undefined
  if (!isHalfDay(context, day)) return slot
  const behavior = slot.halfDayBehavior ?? legacyHalfDayBehavior(slotId)
  if (behavior.action === "omit") return undefined
  if (behavior.action === "quick") {
    return { ...slot, maxCookMinutes: behavior.maxCookMinutes }
  }
  return slot
}

/** A catalog meal's slot eligibility, including the half-day-only snack capability. */
export function mealDefinitionFitsSlot(
  definition: MealDefinition,
  context: Pick<MealPlanContext, "schedule" | "weeklyExceptions">,
  day: string,
  slotId: string,
): boolean {
  const slot = context.schedule.slots.find((candidate) => candidate.id === slotId)
  const behavior = slot?.halfDayBehavior ?? legacyHalfDayBehavior(slotId)
  const halfDayQuickSnack = definition.halfDaySnack === true && isHalfDay(context, day) && behavior.action === "quick"
  if (halfDayQuickSnack) return definition.typicalCookMinutes <= HALF_DAY_SNACK_MAX_COOK_MINUTES
  return definition.suitableSlots.includes(slotId)
}
