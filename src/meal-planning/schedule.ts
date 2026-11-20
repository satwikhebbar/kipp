import { z } from "zod"
import type { MealProfile, MealSchedule, MealSlot } from "./types"

export const MEAL_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const
const MAX_HALF_DAY_COOK_MINUTES = 120
const MAX_MEAL_SLOT_NAME_LENGTH = 80
const MAX_MEAL_COOK_MINUTES = 600
const MAX_MEAL_SCHEDULE_SLOTS = 32
const RESERVED_SLOT_IDS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
])

export const halfDayBehaviorSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("keep") }).strict(),
  z.object({ action: z.literal("omit") }).strict(),
  z
    .object({ action: z.literal("quick"), maxCookMinutes: z.number().int().min(1).max(MAX_HALF_DAY_COOK_MINUTES) })
    .strict(),
])

export const mealSlotSchema: z.ZodType<MealSlot> = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
      .refine((id) => !RESERVED_SLOT_IDS.has(id), "slot ID is reserved"),
    name: z.string().trim().min(1).max(MAX_MEAL_SLOT_NAME_LENGTH),
    packed: z.boolean(),
    dry: z.boolean(),
    maxCookMinutes: z.number().int().min(0).max(MAX_MEAL_COOK_MINUTES).nullable(),
    halfDayBehavior: halfDayBehaviorSchema.optional(),
  })
  .strict()

const mealScheduleObjectSchema = z
  .object({
    days: z.array(z.enum(MEAL_WEEKDAYS)).min(1).max(MEAL_WEEKDAYS.length),
    halfDays: z.array(z.enum(MEAL_WEEKDAYS)).optional(),
    slots: z.array(mealSlotSchema).min(1).max(MAX_MEAL_SCHEDULE_SLOTS),
  })
  .strict()
  .superRefine((schedule, context) => {
    if (new Set(schedule.days).size !== schedule.days.length)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["days"], message: "days must be unique" })
    if (schedule.halfDays && new Set(schedule.halfDays).size !== schedule.halfDays.length)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["halfDays"], message: "halfDays must be unique" })
    schedule.halfDays?.forEach((day, index) => {
      if (!schedule.days.includes(day))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["halfDays", index],
          message: "half day must be scheduled",
        })
    })
    const slotIds = schedule.slots.map((slot) => slot.id)
    if (new Set(slotIds).size !== slotIds.length)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["slots"], message: "slot IDs must be unique" })
    if (schedule.slots.every((slot) => slot.halfDayBehavior?.action === "omit"))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slots"],
        message: "a half day must retain at least one slot",
      })
  })

export const mealScheduleSchema: z.ZodType<MealSchedule> = mealScheduleObjectSchema

/** The historic fixed school schedule's half-day rule for schedules saved before slot behavior was explicit. */
export function legacyHalfDayBehavior(slotId: string): NonNullable<MealSlot["halfDayBehavior"]> {
  if (slotId === "snack1") return { action: "quick", maxCookMinutes: 20 }
  if (slotId === "snack2" || slotId === "school-lunch") return { action: "omit" }
  return { action: "keep" }
}

/** Applies legacy Saturday and seed-slot behavior without changing already-normalized schedules. */
export function normalizeLegacyMealSchedule(schedule: MealSchedule): MealSchedule {
  const days = schedule.days
  const halfDays = schedule.halfDays === undefined ? (days.includes("Sat") ? ["Sat"] : []) : schedule.halfDays
  let slotsChanged = false
  const slots = schedule.slots.map((slot) => {
    if (slot.halfDayBehavior) return slot
    slotsChanged = true
    return { ...slot, halfDayBehavior: legacyHalfDayBehavior(slot.id) }
  })
  if (halfDays === schedule.halfDays && !slotsChanged) return schedule
  return { ...schedule, halfDays, slots }
}

/** Returns actionable deterministic configuration failures, including established-meal availability. */
export function validateMealSchedule(schedule: MealSchedule, profile?: MealProfile): string[] {
  const parsed = mealScheduleSchema.safeParse(schedule)
  if (!parsed.success)
    return parsed.error.issues.map((issue) => `${issue.path.join(".") || "schedule"}: ${issue.message}`)
  if (!profile || profile.allowNewFoods) return []
  const established = profile.mealDefinitions?.filter((definition) => definition.status === "established") ?? []
  const errors: string[] = []
  for (const slot of schedule.slots) {
    const fits = (definition: (typeof established)[number], halfDay: boolean) => {
      const behavior = slot.halfDayBehavior ?? legacyHalfDayBehavior(slot.id)
      const eligible =
        definition.suitableSlots.includes(slot.id) ||
        (halfDay && behavior.action === "quick" && definition.halfDaySnack === true)
      const packed =
        !slot.packed || Boolean(definition.packedFood?.suitable && (!slot.dry || definition.packedFood.dry))
      const cookLimit = halfDay && behavior.action === "quick" ? behavior.maxCookMinutes : slot.maxCookMinutes
      const cook = cookLimit === null || definition.typicalCookMinutes <= cookLimit
      return eligible && packed && cook
    }
    const occurrences = schedule.days
      .map((day) => ({ halfDay: schedule.halfDays?.includes(day) === true }))
      .filter(({ halfDay }) => !halfDay || slot.halfDayBehavior?.action !== "omit")
    if (occurrences.some(({ halfDay }) => !fitsAny(established, fits, halfDay)))
      errors.push(
        `${slot.name} (${slot.id}) has no eligible established meals that meet its packing and cook-time requirements`,
      )
  }
  return errors
}

/** Returns whether at least one established meal satisfies a scheduled occurrence. */
function fitsAny<T>(items: T[], fits: (item: T, halfDay: boolean) => boolean, halfDay: boolean): boolean {
  return items.some((item) => fits(item, halfDay))
}
