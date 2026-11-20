import { z } from "zod"
import { HALF_DAY_SNACK_MAX_COOK_MINUTES, halfDayDroppedSlotIds, isHalfDay } from "./half-day"
import type { ActivePlanRecord } from "./store"
import type { MealDefinition, MealProfile } from "./types"

const nonblank = z.string().refine((value) => value.trim().length > 0)
const namesSchema = z.array(nonblank)
const definitionSchema = z
  .object({
    id: nonblank,
    name: nonblank,
    aliases: namesSchema.optional(),
    principalIngredients: namesSchema.min(1),
    vegetarian: z.literal(true),
    suitableSlots: namesSchema,
    halfDaySnack: z.boolean().optional(),
    packedFood: z.object({ suitable: z.boolean(), dry: z.boolean() }).optional(),
    typicalCookMinutes: z.number().finite().nonnegative(),
    priorNightPrep: z.enum(["none", "optional", "required"]),
    requiredIngredients: namesSchema.min(1),
    optionalIngredients: namesSchema,
    allowedIngredientChoices: namesSchema.optional(),
    status: z.literal("provisional"),
  })
  .refine((entry) => entry.suitableSlots.length > 0 || entry.halfDaySnack === true)
  .refine(
    (entry) =>
      !entry.halfDaySnack ||
      (entry.packedFood?.suitable &&
        entry.packedFood.dry &&
        entry.typicalCookMinutes <= HALF_DAY_SNACK_MAX_COOK_MINUTES),
  )

export type CompletionCounts = { added: number; skipped: number; invalid: number }

/** Returns the normalized catalog names that identify a dish. */
function names(definition: Pick<MealDefinition, "name" | "aliases">): string[] {
  return [definition.name, ...(definition.aliases ?? [])].map(normalizeName)
}

/** Uses the same case and whitespace normalization as the evaluator. */
function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ")
}

/** Converts referenced, eligible provisional definitions while preserving their planning attributes. */
export function completionAdditions(record: ActivePlanRecord, profile: MealProfile) {
  const { plan, version } = record
  const weeklyExceptions = plan.weeklyExceptions
  const closed = new Set(
    weeklyExceptions.items.filter((item) => item.kind === "school_closed").map((item) => item.appliesTo?.day),
  )
  const schedule = { days: [], slots: [] }
  const referenced = new Set<string>()
  for (const [day, cells] of Object.entries(version.candidate.grid)) {
    if (closed.has(day)) continue
    const dropped = isHalfDay({ schedule, weeklyExceptions }, day)
      ? halfDayDroppedSlotIds(Object.keys(cells).map((id) => ({ id })))
      : []
    for (const [slot, cell] of Object.entries(cells)) {
      if (!dropped.includes(slot)) referenced.add(normalizeName(cell.dish))
    }
  }
  const counts: CompletionCounts = { added: 0, skipped: 0, invalid: 0 }
  const catalog = profile.mealDefinitions ?? []
  const known = catalog.filter((entry) => entry.status === "established")
  const knownNames = new Set(known.flatMap(names))
  const knownIds = new Set(known.map((entry) => entry.id))
  const rejected = new Set(plan.rejectedMealIds)
  const byName = new Map<string, Set<MealDefinition>>()
  for (const entry of version.provisionalMealDefinitions) {
    if (!entry || typeof entry.name !== "string") {
      counts.invalid++
      continue
    }
    const aliases = Array.isArray(entry.aliases) ? entry.aliases.filter((alias) => typeof alias === "string") : []
    for (const name of names({ name: entry.name, aliases })) {
      const entries = byName.get(name) ?? new Set<MealDefinition>()
      entries.add(entry)
      byName.set(name, entries)
    }
  }
  const additions: MealDefinition[] = []
  const seen = new Set<MealDefinition>()
  for (const dish of referenced) {
    if (knownNames.has(dish)) continue
    const entries = byName.get(dish)
    const entry = entries?.values().next().value
    if (entries?.size !== 1 || !entry) {
      counts.invalid++
      continue
    }
    if (seen.has(entry)) continue
    seen.add(entry)
    if (!definitionSchema.safeParse(entry).success) {
      counts.invalid++
      continue
    }
    const entryNames = names(entry)
    if (rejected.has(entry.id) || knownIds.has(entry.id) || entryNames.some((name) => knownNames.has(name))) {
      counts.skipped++
      continue
    }
    additions.push({ ...entry, status: "established" })
    knownIds.add(entry.id)
    for (const name of entryNames) knownNames.add(name)
  }
  counts.added = additions.length
  return { additions, counts }
}
