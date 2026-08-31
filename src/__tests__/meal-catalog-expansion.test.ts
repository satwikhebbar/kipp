import { describe, expect, it, vi } from "vitest"
import { expandMealCatalog, MEAL_CATALOG_EXPANSION_PROMPT } from "../agent/meal-catalog-expansion"
import { SEED_SCHEDULE } from "../meal-planning/store"
import type { MealDefinitionProposal } from "../meal-planning/types"
import type { ToolProviderClient } from "../providers"

function providerWith(...responses: Awaited<ReturnType<ToolProviderClient["generate"]>>[]): ToolProviderClient {
  return { generate: vi.fn().mockImplementation(async () => responses.shift()) }
}

function catalogProposal(
  sourceDishName: string,
  overrides: Partial<MealDefinitionProposal> = {},
): MealDefinitionProposal {
  return {
    sourceDishName,
    name: sourceDishName,
    principalIngredients: ["wheat flour"],
    vegetarian: true,
    suitableSlots: ["breakfast"],
    packedFood: { dry: false },
    typicalCookMinutes: 15,
    priorNightPrep: "none",
    requiredIngredients: ["wheat flour"],
    optionalIngredients: [],
    ...overrides,
  }
}

function catalogResponse(definitions: MealDefinitionProposal[]) {
  return {
    toolCalls: [{ id: "catalog", name: "submit_meal_definitions", input: { definitions } }],
    usage: { inputTokens: 0, outputTokens: 0 },
  }
}

describe("meal catalog expansion session", () => {
  it("expands parent dishes in batches of five and applies server-owned metadata", async () => {
    const names = ["paratha", "poha", "idli", "upma", "dosa", "banana"]
    const provider = providerWith(
      catalogResponse(names.slice(0, 5).map((name) => catalogProposal(name))),
      catalogResponse([
        catalogProposal("banana", { packedFood: { dry: true }, suitableSlots: ["snack1"], typicalCookMinutes: 0 }),
      ]),
    )
    let sequence = 0
    const result = await expandMealCatalog(
      provider,
      { parentDishNames: names, schedule: SEED_SCHEDULE },
      {
        createId: () => `meal_generated_${++sequence}`,
      },
    )

    expect(result.failures).toEqual([])
    expect(result.definitions).toHaveLength(6)
    expect(result.definitions?.[0]).toMatchObject({
      id: "meal_generated_1",
      aliases: ["paratha"],
      status: "established",
      packedFood: { suitable: true, dry: false },
    })
    expect(result.definitions?.[5]?.packedFood).toEqual({ suitable: true, dry: true })
    expect(provider.generate).toHaveBeenCalledTimes(2)
    expect(vi.mocked(provider.generate).mock.calls[0]?.[0].messages[1]).toMatchObject({
      role: "user",
      text: expect.stringContaining("paratha | poha | idli | upma | dosa"),
    })
  })

  it("repairs only failed dishes with deterministic validation feedback", async () => {
    const provider = providerWith(
      catalogResponse([catalogProposal("paratha"), catalogProposal("poha", { typicalCookMinutes: -1 })]),
      catalogResponse([catalogProposal("poha", { name: "Flattened rice" })]),
    )
    const result = await expandMealCatalog(
      provider,
      { parentDishNames: ["paratha", "poha"], schedule: SEED_SCHEDULE },
      {
        createId: (() => {
          let index = 0
          return () => `meal_repaired_${++index}`
        })(),
      },
    )

    expect(result.failures).toEqual([])
    expect(result.definitions?.map((definition) => definition.name)).toEqual(["paratha", "Flattened rice"])
    expect(provider.generate).toHaveBeenCalledTimes(2)
    const repair = vi.mocked(provider.generate).mock.calls[1]?.[0].messages[1]
    expect(repair).toMatchObject({ role: "user", text: expect.stringContaining("Dish names: poha") })
    expect((repair as { text: string }).text).toContain("invalid_cook_minutes")
  })

  it("repairs a cooked meal that incorrectly advertises a no-cook snack slot", async () => {
    const provider = providerWith(
      catalogResponse([catalogProposal("poha", { suitableSlots: ["snack1"] })]),
      catalogResponse([catalogProposal("poha", { suitableSlots: ["breakfast"] })]),
    )
    const result = await expandMealCatalog(provider, { parentDishNames: ["poha"], schedule: SEED_SCHEDULE })

    expect(result.failures).toEqual([])
    expect(result.definitions?.[0]?.suitableSlots).toEqual(["breakfast"])
    const repair = vi.mocked(provider.generate).mock.calls[1]?.[0].messages[1]
    expect((repair as { text: string }).text).toContain("slot_cook_time_exceeded")
  })

  it("returns no definitions when a dish remains invalid after two focused repairs", async () => {
    const invalid = catalogProposal("poha", { suitableSlots: ["not-a-slot"] })
    const provider = providerWith(catalogResponse([invalid]), catalogResponse([invalid]), catalogResponse([invalid]))
    const result = await expandMealCatalog(provider, { parentDishNames: ["poha"], schedule: SEED_SCHEDULE })

    expect(result.definitions).toBeUndefined()
    expect(result.failures).toMatchObject([{ dishName: "poha", code: "unknown_slot" }])
    expect(provider.generate).toHaveBeenCalledTimes(3)
  })

  it("includes a structured action example in the static prompt", () => {
    expect(MEAL_CATALOG_EXPANSION_PROMPT).toContain('"definitions"')
    expect(MEAL_CATALOG_EXPANSION_PROMPT).toContain('"sourceDishName"')
    expect(MEAL_CATALOG_EXPANSION_PROMPT).toContain("idli batter")
    expect(MEAL_CATALOG_EXPANSION_PROMPT).toContain("sambar")
    expect(MEAL_CATALOG_EXPANSION_PROMPT).toContain("overnight soaking")
    expect(MEAL_CATALOG_EXPANSION_PROMPT).toContain("whole fruit")
    expect(MEAL_CATALOG_EXPANSION_PROMPT).toContain("raw vegetable salad")
  })
})
