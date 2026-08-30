import { evaluateMealPlanSelection } from "../meal-planning/evaluation"
import type {
  FailureCode,
  FeedbackItem,
  MealPlanCandidate,
  MealPlanContext,
  MealPlanEvaluation,
  MealDefinition,
  WeeklyExceptions,
  WeeklyInventory,
} from "../meal-planning/types"
import type { ToolConversationMessage, ToolProviderClient } from "../providers"
import { type AgentSessionResult, persistableAgentMessages } from "../runtime/agent-session"
import { runTools } from "../runtime/tool-runner"
import { ToolHandlerError, type ToolRegistry } from "../runtime/tools"
import {
  acceptedOutputSchema,
  createEvaluateMealPlanTool,
  MEAL_PLANNING_TOOL,
  needsClarificationInputSchema,
  proposePlanInputSchema,
} from "./meal-planning"

export const MEAL_PLANNING_AGENT_PROMPT = `You are a parent's meal-planning agent for school days. Interpret the parent's request and use only the provided actions.

Build one complete school-week plan covering exactly the schedule days listed in the household context, never a day a weekly exception marks as a school holiday. On a half-day, the child comes home for lunch: do not pack a school lunch that day, and keep the home-lunch slot. The plan must contain a cell for every slot on every open schedule day — never fewer, never a day outside the schedule. School meals are vegetarian (no meat); packed snacks are dry and not cooked that morning. Respect the household's operating limits supplied in the context: hard dietary exclusions, unavailable weekly inventory, the per-day morning cook budget, and prior-night-prep rules. Plans default to healthy, nutritious meals; the persistent custom policies define any scheduled exceptions. The context also lists the household's persistent custom policies; for every relevant one, record a concise satisfied, trade-off, or needs-clarification outcome with a short rationale, and never claim certainty when a policy cannot be interpreted confidently.

The context's request.kind tells you whether the request is an initial_plan or a revision. When it is a revision, keep the elapsed days' dishes unchanged unless the feedback explicitly targets them; apply changes from today onward. Treat every submitted feedback item as the driver: a cell-scoped item must be addressed in that cell, an unbound item against the plan as a whole. If unbound feedback does not identify what should improve — for example, "make this better" — ask one concise clarification about the decision that matters (speed, nutrition, packing dryness, preference, or inventory). Do not make an arbitrary change or treat it as satisfied by a rationale.

Validate the candidate with evaluate_meal_plan, revise objective failures, self-check the free-form policies, then finish with exactly one terminal action. Call propose_plan only when the evaluation passes and every submitted feedback is represented by a feedbackItems entry or an outcome rationale. Include a short justification in propose_plan explaining the plan in plain language. Call needs_clarification when a targeted question is required to plan confidently; include every failure code from the latest evaluation when there is one, otherwise use an empty reasonCodes list, and keep the message concise, in plain language. Never expose opaque ids, credentials, or internal tokens in the message.

Build the candidate grid from meal selections. Established meals use their mealDefinitionId; ingredientChoices may contain only the permitted choices listed for that definition, and usesPriorNightPrep is meaningful only when prep is optional. A plan-local provisional meal is reused by its provisionalMealId exactly as listed in the context.

Known selection example: { "mealDefinitionId": "meal_opaque_paratha", "ingredientChoices": ["spinach"], "usesPriorNightPrep": true }.

When new foods are allowed and no suitable known meal can be selected, submit a structured proposal, for example: { "proposedMeal": { "name": "Vegetable rice", "principalIngredients": ["rice", "vegetables"], "vegetarian": true, "suitableSlots": ["home-lunch"], "packedFood": { "suitable": false, "dry": false }, "cookMinutes": 20, "priorNightPrep": "optional", "ingredients": ["rice", "vegetables"] }, "usesPriorNightPrep": false }. A new packed meal must travel safely in an ordinary lunchbox, have no likely spill or leak, be independently edible by hand or ordinary spoon, and require no reheating, cooking, assembly, or special equipment; dry slots additionally require dry spill-resistant food.

easyBuys is the short list of ordinary ingredients you are adding this week: staples, all-season vegetables and fruits, and everyday items from a neighborhood grocery. It is not the week's whole shopping list. Do not place a dish name in easyBuys. When a request lists ingredients, ensure they are represented in inventory, pantry baseline, or easyBuys. Favourites may repeat; keep other dishes distinct. A new week's plan should differ from the previous week's cooked mains while a fruit, dry fruit, or dry snack may repeat in a snack slot as a last resort.`

export interface MealPlanningAgentSessionOptions {
  context: MealPlanContext
  /** Debug aid: keep provider reasoning in the returned transcript. */
  retainReasoning?: boolean
}

export type MealPlanningTerminalOutcome =
  | {
      kind: "propose_plan"
      candidate: MealPlanCandidate
      provisionalMealDefinitions: MealDefinition[]
      weeklyInventory: WeeklyInventory
      weeklyExceptions: WeeklyExceptions
      feedbackItems?: FeedbackItem[]
      evaluation: MealPlanEvaluation
      /** Debug aid: the model's own explanation of the proposed plan. */
      justification?: string
    }
  | { kind: "needs_clarification"; message: string; reasonCodes: FailureCode[] }

export type MealPlanningAgentSessionResult = AgentSessionResult<MealPlanningTerminalOutcome>

/** Runs one capped meal-planning agent session with deterministic evaluator-gated persistence handoffs. */
export async function runMealPlanningAgentSession(
  provider: ToolProviderClient,
  initialMessages: ToolConversationMessage[],
  options: MealPlanningAgentSessionOptions,
): Promise<MealPlanningAgentSessionResult> {
  let terminal: MealPlanningTerminalOutcome | null = null
  let latestEvaluation: MealPlanEvaluation | null = null
  const evaluationTool = createEvaluateMealPlanTool(options.context)
  const registry: ToolRegistry = {
    [MEAL_PLANNING_TOOL.EVALUATE]: {
      ...evaluationTool,
      handler: async (candidate) => {
        const result = (await evaluationTool.handler(candidate)) as MealPlanEvaluation
        latestEvaluation = result
        return result
      },
    },
    [MEAL_PLANNING_TOOL.PROPOSE]: {
      name: MEAL_PLANNING_TOOL.PROPOSE,
      description: "Hand the evaluated candidate to the workflow for deterministic re-validation and persistence.",
      input: proposePlanInputSchema,
      output: acceptedOutputSchema,
      privacy: "private",
      batching: "isolated",
      handler: async (input) => {
        const authoritative = options.context.feedbackItems ?? []
        const submitted: FeedbackItem[] = input.feedbackItems ?? []
        // The model never needs to echo feedback items back: scoped items are
        // covered by the authoritative set alone. A submission may only attach
        // a scope interpretation to a free-text item (one that has no parsed
        // scope), and only by its exact text — never by inventing or rewriting.
        assertInterpretationsOnly(authoritative, submitted)
        const submittedByText = new Map(submitted.map((item) => [item.text, item]))
        const evaluationFeedback = authoritative.map((raw) => {
          if (raw.scope) return raw
          const interpretation = submittedByText.get(raw.text)
          return interpretation?.scope ? { ...raw, scope: interpretation.scope } : raw
        })
        // Re-validate against the authoritative week state plus the candidate's
        // easy-buys, exactly as evaluate_meal_plan did — never against a
        // re-emitted echo the model may have drifted from the source of truth.
        // Every authoritative item is in the evaluation set, so the evaluator's
        // `unaddressed_feedback` check is the coverage gate (with codes the
        // model can act on), replacing any session-side echo requirement.
        const selectionEvaluation = evaluateMealPlanSelection(input.candidate, {
          ...options.context,
          feedbackItems: evaluationFeedback,
        })
        if (!selectionEvaluation.candidate)
          throw new ToolHandlerError(
            "proposed plan could not be hydrated",
            "invalid-state",
            undefined,
            selectionEvaluation.evaluation.failures.map((failure) => failure.code),
          )
        const evaluation = selectionEvaluation.evaluation
        if (!evaluation.pass)
          throw new ToolHandlerError(
            "proposed plan did not pass evaluation",
            "invalid-state",
            undefined,
            evaluation.failures.map((failure) => failure.code),
          )
        terminal = {
          kind: "propose_plan",
          candidate: selectionEvaluation.candidate,
          provisionalMealDefinitions: selectionEvaluation.provisionalMealDefinitions,
          weeklyInventory: input.weeklyInventory ?? options.context.weeklyInventory,
          weeklyExceptions: input.weeklyExceptions ?? options.context.weeklyExceptions,
          ...(evaluationFeedback.length ? { feedbackItems: evaluationFeedback } : {}),
          ...(input.justification ? { justification: input.justification } : {}),
          evaluation,
        }
        return { accepted: true as const }
      },
    },
    [MEAL_PLANNING_TOOL.CLARIFY]: {
      name: MEAL_PLANNING_TOOL.CLARIFY,
      description: "Return one concise human-facing question when more information is needed to plan confidently.",
      input: needsClarificationInputSchema,
      output: acceptedOutputSchema,
      privacy: "private",
      batching: "isolated",
      handler: async ({ message, reasonCodes }) => {
        enforceCompleteClarification(latestEvaluation, reasonCodes, message, options.context.feedbackItems ?? [])
        terminal = { kind: "needs_clarification", message, reasonCodes }
        return { accepted: true as const }
      },
    },
  }
  const initialAllowedTools = [MEAL_PLANNING_TOOL.EVALUATE, MEAL_PLANNING_TOOL.CLARIFY]
  const terminalTools = [MEAL_PLANNING_TOOL.PROPOSE, MEAL_PLANNING_TOOL.CLARIFY]
  const result = await runTools(
    provider,
    registry,
    {
      allowedTools: initialAllowedTools,
      handoffTools: terminalTools,
      requireHandoff: true,
      toolChoice: "auto",
      reasoning: "high",
      nextAllowedTools: (executedTools) =>
        executedTools.includes(MEAL_PLANNING_TOOL.EVALUATE)
          ? [MEAL_PLANNING_TOOL.EVALUATE, ...terminalTools]
          : initialAllowedTools,
      // A full Mon–Sat candidate is a large nested schema; the model often needs
      // an extra evaluate-revise turn, so grant more turns than the default
      // shared budget without changing other workflows.
      maxProviderTurns: 8,
      maxToolCalls: 12,
    },
    initialMessages[0]?.role === "system"
      ? initialMessages
      : [{ role: "system", text: MEAL_PLANNING_AGENT_PROMPT }, ...initialMessages],
  )
  return {
    terminal: result.completed ? terminal : null,
    messages: options.retainReasoning ? result.messages : persistableAgentMessages(result.messages),
    completed: result.completed,
    ...(result.failureReason ? { failureReason: result.failureReason } : {}),
    providerTurns: result.providerTurns,
    toolCallCount: result.toolCallCount,
    toolNames: result.toolNames,
    toolExecutions: result.toolExecutions,
    usage: result.usage,
  }
}

/**
 * Rejects a feedback submission that invents or rewrites items: each submitted
 * item must match an authoritative item's text exactly, must not be a
 * duplicate, and must not alter or drop an authoritative scope (a scope may be
 * attached only when the authoritative item carries none).
 */
function assertInterpretationsOnly(authoritative: FeedbackItem[], submitted: FeedbackItem[]): void {
  const seen = new Set<string>()
  for (const item of submitted) {
    const raw = authoritative.find((candidate) => candidate.text === item.text)
    if (!raw || seen.has(item.text))
      throw new ToolHandlerError(
        "proposed feedback items must match the authoritative feedback text exactly",
        "invalid-state",
      )
    seen.add(item.text)
    if (raw.scope && (!item.scope || !scopeEqual(raw.scope, item.scope)))
      throw new ToolHandlerError("proposed feedback items must keep the authoritative scope unchanged", "invalid-state")
  }
}

/** True when two feedback scopes are equal (either both unset, or same day and slot). */
function scopeEqual(a: FeedbackItem["scope"], b: FeedbackItem["scope"]): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.day === b.day && a.slot === b.slot
}

/** Ensures the clarification surfaces every evaluator failure and never exposes opaque feedback ids. */
function enforceCompleteClarification(
  evaluation: MealPlanEvaluation | null,
  reasonCodes: FailureCode[],
  message: string,
  feedbackItems: FeedbackItem[],
): void {
  if (evaluation) {
    const submitted = new Set(reasonCodes)
    if (evaluation.failures.some((failure) => !submitted.has(failure.code)))
      throw new ToolHandlerError("planning failures were omitted from the clarification", "invalid-state")
  }
  const opaqueIds = feedbackItems.map((item) => item.id)
  if (opaqueIds.some((id) => message.includes(id)))
    throw new ToolHandlerError("opaque feedback id was exposed in user-facing text", "invalid-state")
}
