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
const proposalSchema = z
  .object({
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
  })
  .strict()

const submitDefinitionsInputSchema = z.object({ definitions: z.array(proposalSchema) }).strict()
const acceptedOutputSchema = z.object({ accepted: z.literal(true) }).strict()
export const MEAL_INGREDIENT_LOCALE_DEFAULT = "India"

/** Meal catalog expansion prompt. */
export function mealCatalogExpansionPrompt(locale = MEAL_INGREDIENT_LOCALE_DEFAULT): string {
  return `You expand a parent's named meal repertoire into practical meal definitions. Use only the submit_meal_definitions action.

The supplied names are parent-provided repertoire meals. Treat each as generally suitable for ordinary school-lunchbox transport: do not assess whether it is packable and do not return a packing-suitability field. Classify packedFood.dry only. Here dry means non-leaking and spill-resistant, not dehydrated: whole fruit and raw vegetable salad count as dry. Set dry false for food likely to spill or leak; uncertainty means false. Choose suitable slot ids only from the supplied schedule.

Each supplied name is the parent's complete meal label — for example, "Idli Chutney", "Rajma Chawal", or "Puri + Aloo Sabji". Preserve its meal scope: do not add, remove, or infer an accompaniment in the display name. sourceDishName must reproduce that supplied name exactly. You may normalize presentation only.

Each definition is a practical meal option, not a fixed recipe. Focus requiredIngredients on the meal's dense, primary, meal-defining ingredients: grains, pulses, flour, dairy, eggs, specifically named vegetables or fruit, and prepared components such as idli batter. Every required ingredient must be a concrete, purchasable item or prepared component that the planner can match to inventory; do not use vague aggregate tokens such as "mixed vegetables", "vegetables", "mixed spices", or "seasoning" in requiredIngredients. If a dish permits interchangeable produce, keep the generic category optional or describe concrete choices in optionalIngredients/allowedIngredientChoices instead. Do not list ordinary pantry seasonings or cooking basics—salt, turmeric, chilli, cumin, mustard seeds, curry leaves, oil, and similar spices are assumed to be available and should not cause an ingredient-availability failure. Add a seasoning to requiredIngredients only when it is unusually central to the named meal and not a normal pantry staple. optionalIngredients and allowedIngredientChoices are alternatives the planner may choose from. Use prepared ingredient states when lengthy work happens before the meal: for example, use "idli batter" rather than rice and urad dal when grinding and fermentation are prior-night work. Mandatory soaking, fermentation, grinding, or marination means priorNightPrep is required: dried kidney beans (rajma), chickpeas, and similar legumes need overnight soaking before morning cooking. Keep the purchasable ingredient token in the household's locale (${locale}); for India, use familiar local names such as "chana" rather than "chickpea", "toor dal" rather than "pigeon pea", and "sabudana" rather than "tapioca pearl". The same localized token must be used consistently across required and optional ingredients. Make typicalCookMinutes the day-of cooking and serving time after any required preparation. All meals are vegetarian. typicalCookMinutes is a non-negative integer and priorNightPrep is none, optional, or required.

Write every ingredient token in singular canonical form (for example, "apple", "onion", "tomato", and "potato", not their plural forms). Apply this consistently to principalIngredients, requiredIngredients, optionalIngredients, and allowedIngredientChoices; do not rely on the planner to correct the definition later.

For a packed suitable slot, the whole named meal and its required components must travel safely in an ordinary lunchbox. Do not make a pourable accompaniment such as sambar a component of a packed meal; choose a thick, non-pourable accompaniment instead, or omit packed slots from suitableSlots.

Include a slot in suitableSlots only when typicalCookMinutes fits that slot's maxCookMinutes. A slot with maxCookMinutes 0 is for no-cook food only. Prior-night preparation does not make a cooked meal eligible for that slot.

Suitable slots must also reflect the meal's role, not merely whether it needs cooking. A light standalone snack such as whole fruit or roasted chana belongs only in snack slots; do not advertise it as breakfast, school lunch, or home lunch. Conversely, a substantial meal may use meal slots but must not claim snack slots unless it is genuinely a no-cook snack.

Example action input:
{"definitions":[{"sourceDishName":"Idli Chutney","name":"Idli Chutney","principalIngredients":["idli batter","coconut"],"vegetarian":true,"suitableSlots":["breakfast","school-lunch","home-lunch"],"packedFood":{"dry":false},"typicalCookMinutes":12,"priorNightPrep":"required","requiredIngredients":["idli batter","thick coconut chutney"],"optionalIngredients":["coriander"],"allowedIngredientChoices":[]}]}`
}

export const MEAL_CATALOG_EXPANSION_PROMPT = mealCatalogExpansionPrompt()

export interface MealCatalogExpansionOptions {
  /** Lets callers provide a deterministic opaque-id factory in tests. */
  createId?: () => string
  /** Ingredient naming locale; defaults to India. */
  locale?: string
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
    const initial = await requestDefinitions(provider, batch, input, [], options.locale)
    for (const dishName of batch) {
      let proposal = proposalFor(dishName, initial)
      let dishFailures = proposalFailures(proposal, dishName, input, initial)
      for (let attempt = 0; dishFailures.length > 0 && attempt < MAX_REPAIR_ATTEMPTS; attempt++) {
        const repaired = await requestDefinitions(provider, [dishName], input, dishFailures, options.locale)
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
    const proposal = valid.get(dishName)
    if (!proposal) throw new Error("validated meal proposal missing")
    return establishMealDefinition(proposal, dishName, id)
  })
  return { definitions, failures: [] }
}

/** Validate input. */
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

/** Chunks. */
function chunks<T>(values: T[], size: number): T[][] {
  const batches: T[][] = []
  for (let index = 0; index < values.length; index += size) batches.push(values.slice(index, index + size))
  return batches
}

/** Normalized. */
function normalized(value: string): string {
  return value.trim().toLocaleLowerCase()
}

/** Proposal for. */
function proposalFor(dishName: string, proposals: MealDefinitionProposal[]): MealDefinitionProposal | undefined {
  const matches = proposals.filter((proposal) => normalized(proposal.sourceDishName) === normalized(dishName))
  return matches.length === 1 ? matches[0] : undefined
}

/** Proposal failures. */
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

/** Request definitions. */
async function requestDefinitions(
  provider: ToolProviderClient,
  dishNames: string[],
  input: MealCatalogExpansionInput,
  repairFailures: MealDefinitionValidationFailure[],
  locale = MEAL_INGREDIENT_LOCALE_DEFAULT,
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
    { role: "system", text: mealCatalogExpansionPrompt(locale) },
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
      // DeepSeek v4 rejects tool_choice while thinking is enabled. This task is
      // a one-shot structured extraction, so reasoning is neither needed nor
      // worth compromising the required terminal tool handoff.
      reasoning: "disabled",
      maxProviderTurns: 2,
      maxToolCalls: 2,
    },
    messages,
  )
  return result.completed && submitted ? submitted : []
}
