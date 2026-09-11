import type { MealDefinition, MealPlanContext, MealSlot } from "./types"

export const HALF_DAY_SNACK_SLOT_ID = "snack1"
export const HALF_DAY_SNACK_MAX_COOK_MINUTES = 20

const HALF_DAY_DROPPED_SLOT_IDS = ["snack2", "school-lunch"]

/** Whether a configured day has the standard half-day schedule. */
export function isHalfDay(context: Pick<MealPlanContext, "weeklyExceptions">, day: string): boolean {
  return context.weeklyExceptions.items.some(
    (exception) => exception.kind === "half_day" && exception.appliesTo?.day === day,
  )
}

/** The slots omitted by every half-day. `mealSlots` is legacy detail, not an override of the standard schedule. */
export function halfDayDroppedSlotIds(slots: MealSlot[]): string[] {
  const configured = new Set(slots.map((slot) => slot.id))
  return HALF_DAY_DROPPED_SLOT_IDS.filter((slotId) => configured.has(slotId))
}

/** Resolves the rules that apply to one slot on one day. */
export function effectiveMealSlot(
  context: Pick<MealPlanContext, "schedule" | "weeklyExceptions">,
  day: string,
  slotId: string,
): MealSlot | undefined {
  const slot = context.schedule.slots.find((candidate) => candidate.id === slotId)
  if (!slot) return undefined
  if (isHalfDay(context, day) && slotId === HALF_DAY_SNACK_SLOT_ID)
    return { ...slot, maxCookMinutes: HALF_DAY_SNACK_MAX_COOK_MINUTES }
  return slot
}

/** A catalog meal's slot eligibility, including the half-day-only snack capability. */
export function mealDefinitionFitsSlot(
  definition: MealDefinition,
  context: Pick<MealPlanContext, "schedule" | "weeklyExceptions">,
  day: string,
  slotId: string,
): boolean {
  return (
    definition.suitableSlots.includes(slotId) ||
    (definition.halfDaySnack === true && isHalfDay(context, day) && slotId === HALF_DAY_SNACK_SLOT_ID)
  )
}
