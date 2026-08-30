import { z } from "zod"
import { establishMealDefinition, validateMealDefinitionProposal } from "../meal-planning/catalog"
import type {
  MealCatalogExpansionInput,
  MealCatalogExpansionResult,
  MealDefinitionProposal,
  MealDefinitionValidationFailure,
} from "../meal-planning/types"
import type { ToolConversationMessage, ToolProviderClient } from "../providers"
import { runTools } from "../runtime/tool-runner"
import type { ToolRegistry } from "../runtime/tools"

const BATCH_SIZE = 5
const MAX_REPAIR_ATTEMPTS = 2
const SUBMIT_DEFINITIONS = "submit_meal_definitions"

const priorNightPrepSchema = z.enum(["none", "optional", "required"])
const proposalSchema = z.object({
  sourceDishName: z.string(),
  name: z.string(),
  principalIngredients: z.array(z.string()),
  vegetarian: z.literal(true),
  suitableSlots: z.array(z.string()),
  packedFood: z.object({ dry: z.boolean() }).strict(),
  typicalCookMinutes: z.number(),
  priorNightPrep: priorNightPrepSchema,
  requiredIngredients: z.array(z.string()),
  optionalIngredients: z.array(z.string()),
  allowedIngredientChoices: z.array(z.string()).optional(),
}).strict()

const submitDefinitionsInputSchema = z.object({ definitions: z.array(proposalSchema) }).strict()
const acceptedOutputSchema = z.object({ accepted: z.literal(true) }).strict()

export const MEAL_CATALOG_EXPANSION_PROMPT = `You expand a parent's named meal repertoire into practical meal definitions. Use only the submit_meal_definitions action.

The supplied names are parent-provided repertoire meals. Treat each as generally suitable for ordinary school-lunchbox transport: do not assess whether it is packable and do not return a packing-suitability field. Classify packedFood.dry only. Set dry true only for dry, spill-resistant food; uncertainty means false. Choose suitable slot ids only from the supplied schedule.

Each definition is a practical meal option, not a fixed recipe. Include every required ingredient in requiredIngredients; optionalIngredients and allowedIngredientChoices are alternatives the planner may choose from. Return exactly one definition for each supplied name. sourceDishName must reproduce that supplied name exactly. You may improve the display name. All meals are vegetarian. typicalCookMinutes is a non-negative integer and priorNightPrep is none, optional, or required.

Example action input:
{"definitions":[{"sourceDishName":"Vegetable paratha","name":"Vegetable paratha","principalIngredients":["wheat flour","vegetables"],"vegetarian":true,"suitableSlots":["breakfast","school-lunch"],"packedFood":{"dry":false},"typicalCookMinutes":20,"priorNightPrep":"optional","requiredIngredients":["wheat flour","vegetables"],"optionalIngredients":["paneer"],"allowedIngredientChoices":["spinach"]}]}`

export interface MealCatalogExpansionOptions {
  /** Lets callers provide a deterministic opaque-id factory in tests. */
  createId?: () => string
}

/**
 * Expands parent-provided dish names in batches of five. Every batch gets one
 * proposal call, then only invalid or missing dishes get up to two focused
 * repair calls. The result is all-or-nothing: callers must not persist any
 * definition when failures remain.
 */
export async function expandMealCatalog(
  provider: ToolProviderClient,
  input: MealCatalogExpansionInput,
  options: MealCatalogExpansionOptions = {},
): Promise<MealCatalogExpansionResult> {
  const parentDishNames = validateInput(input)
  const valid = new Map<string, MealDefinitionProposal>()
  const failures: MealDefinitionValidationFailure[] = []

  for (const batch of chunks(parentDishNames, BATCH_SIZE)) {
    const initial = await requestDefinitions(provider, batch, input, [])
    for (const dishName of batch) {
      let proposal = proposalFor(dishName, initial)
      let dishFailures = proposalFailures(proposal, dishName, input, initial)
      for (let attempt = 0; dishFailures.length > 0 && attempt < MAX_REPAIR_ATTEMPTS; attempt++) {
        const repaired = await requestDefinitions(provider, [dishName], input, dishFailures)
        proposal = proposalFor(dishName, repaired)
        dishFailures = proposalFailures(proposal, dishName, input, repaired)
      }
      if (dishFailures.length > 0) failures.push(...dishFailures)
      else if (proposal) valid.set(dishName, proposal)
    }
  }

  if (failures.length > 0) return { failures }
  const ids = new Set<string>()
  const definitions = parentDishNames.map((dishName) => {
    const id = (options.createId ?? (() => `meal_${crypto.randomUUID()}`))()
    if (!id || ids.has(id)) throw new Error("catalog expansion id factory must return unique opaque ids")
    ids.add(id)
    return establishMealDefinition(valid.get(dishName)!, dishName, id)
  })
  return { definitions, failures: [] }
}

function validateInput(input: MealCatalogExpansionInput): string[] {
  if (input.parentDishNames.length === 0) throw new Error("at least one parent dish name is required")
  const seen = new Set<string>()
  for (const name of input.parentDishNames) {
    const key = normalized(name)
    if (!key) throw new Error("parent dish names cannot be blank")
    if (seen.has(key)) throw new Error("parent dish names must be unique")
    seen.add(key)
  }
  return input.parentDishNames
}

function chunks<T>(values: T[], size: number): T[][] {
  const batches: T[][] = []
  for (let index = 0; index < values.length; index += size) batches.push(values.slice(index, index + size))
  return batches
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function proposalFor(dishName: string, proposals: MealDefinitionProposal[]): MealDefinitionProposal | undefined {
  const matches = proposals.filter((proposal) => normalized(proposal.sourceDishName) === normalized(dishName))
  return matches.length === 1 ? matches[0] : undefined
}

function proposalFailures(
  proposal: MealDefinitionProposal | undefined,
  dishName: string,
  input: MealCatalogExpansionInput,
  proposals: MealDefinitionProposal[],
): MealDefinitionValidationFailure[] {
  const matches = proposals.filter((candidate) => normalized(candidate.sourceDishName) === normalized(dishName))
  if (matches.length > 1)
    return [{ dishName, code: "duplicate_definition", detail: "exactly one definition must be returned for this dish" }]
  return validateMealDefinitionProposal(proposal, dishName, input)
}

async function requestDefinitions(
  provider: ToolProviderClient,
  dishNames: string[],
  input: MealCatalogExpansionInput,
  repairFailures: MealDefinitionValidationFailure[],
): Promise<MealDefinitionProposal[]> {
  let submitted: MealDefinitionProposal[] | undefined
  const registry: ToolRegistry = {
    [SUBMIT_DEFINITIONS]: {
      name: SUBMIT_DEFINITIONS,
      description: "Submit exactly one structured meal definition proposal for each requested parent dish name.",
      input: submitDefinitionsInputSchema,
      output: acceptedOutputSchema,
      privacy: "private",
      batching: "isolated",
      handler: async ({ definitions }) => {
        submitted = definitions
        return { accepted: true }
      },
    },
  }
  const repairContext = repairFailures.length
    ? `Repair feedback for this dish:\n${repairFailures.map((failure) => `- ${failure.code}: ${failure.detail}`).join("\n")}\nReturn a corrected replacement definition.`
    : "Generate the initial definitions."
  const messages: ToolConversationMessage[] = [
    { role: "system", text: MEAL_CATALOG_EXPANSION_PROMPT },
    {
      role: "user",
      text: [
        `Dish names: ${dishNames.join(" | ")}`,
        `Schedule slots: ${input.schedule.slots.map((slot) => `${slot.id} (${slot.name}; packed=${slot.packed}; dry=${slot.dry})`).join(" | ")}`,
        repairContext,
      ].join("\n"),
    },
  ]
  const result = await runTools(
    provider,
    registry,
    {
      allowedTools: [SUBMIT_DEFINITIONS],
      handoffTools: [SUBMIT_DEFINITIONS],
      requireHandoff: true,
      toolChoice: "required",
      reasoning: "low",
      maxProviderTurns: 2,
      maxToolCalls: 2,
    },
    messages,
  )
  return result.completed && submitted ? submitted : []
}
