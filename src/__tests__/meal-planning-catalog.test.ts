import { describe, expect, it } from "vitest"
import { establishMealDefinition, validateMealDefinitionProposal } from "../meal-planning/catalog"
import { SEED_SCHEDULE } from "../meal-planning/store"

describe("meal definition catalog validation", () => {
  const proposal = {
    sourceDishName: "Paratha",
    name: "Whole-wheat paratha",
    principalIngredients: ["wheat flour"],
    vegetarian: true as const,
    suitableSlots: ["breakfast"],
    packedFood: { dry: false },
    typicalCookMinutes: 15,
    priorNightPrep: "optional" as const,
    requiredIngredients: ["wheat flour"],
    optionalIngredients: ["spinach"],
  }

  it("rejects malformed meal facts before a definition can be established", () => {
    const failures = validateMealDefinitionProposal({
      ...proposal,
      sourceDishName: "paratha",
      suitableSlots: ["breakfast", "unknown-slot"],
      requiredIngredients: ["wheat flour", "wheat flour"],
      optionalIngredients: ["wheat flour"],
      typicalCookMinutes: 12.5,
    }, "Paratha", { schedule: SEED_SCHEDULE })
    expect(failures.map((failure) => failure.code)).toEqual([
      "source_name_mismatch",
      "invalid_cook_minutes",
      "duplicate_value",
      "unknown_slot",
      "ingredient_overlap",
    ])
  })

  it("establishes a valid parent dish with a server alias and trusted packing suitability", () => {
    expect(validateMealDefinitionProposal(proposal, "Paratha", { schedule: SEED_SCHEDULE })).toEqual([])
    expect(establishMealDefinition(proposal, "Paratha", "meal_opaque_1")).toMatchObject({
      id: "meal_opaque_1",
      aliases: ["Paratha"],
      status: "established",
      packedFood: { suitable: true, dry: false },
    })
  })
})
