import { evaluateMealPlanSelection, evaluateMealPlanSelectionPatch } from "../meal-planning/evaluation"
import type {
  FailureCode,
  FeedbackItem,
  MealDefinition,
  MealPlanCandidate,
  MealPlanContext,
  MealPlanEvaluation,
  MealPlanSelectionCandidate,
  MealPlanSelectionPatch,
  ResolvedWeekContextUpdate,
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
  mealPlanSelectionCandidateFromWire,
  mealPlanSelectionPatchFromWire,
  needsClarificationInputSchema,
  PROPOSE_JUSTIFICATION_MAX_CHARACTERS,
  proposePlanRevisionWireInputSchema,
  proposePlanWireInputSchema,
  type WeekContextUpdateInput,
  weekContextUpdateInputSchema,
} from "./meal-planning"

export const MEAL_PLANNING_AGENT_PROMPT = `You are a parent's meal-planning agent for school days. Interpret the parent's request and use only the provided actions.

For an initial plan, build one complete school-week grid covering exactly the schedule days listed in the household context, never a day a weekly exception marks as a school holiday. Represent the grid as days: [{ day, cells: [{ slot, selection }] }], not an object keyed by day or slot. For a school_closed exception, omit that day entry entirely. For a revision, the active plan is authoritative: submit a patch containing only the cells you are changing. Never repeat an unchanged cell or reconstruct it from a catalog id. Omit easyBuys and policyOutcomes unless you are replacing either whole value. policyOutcomes is an array of { policyId, outcome, rationale }; outcome is exactly satisfied, trade-off, or needs-clarification — never use a status field. On a normal school day, breakfast, two snacks, packed school lunch, and home lunch are distinct slots: school lunch is packed for school, while home lunch is a separate later meal after the child returns and does not count toward the morning cook budget. On a half-day, remove only the slot named by the exception (normally school-lunch); retain every other listed slot, including both snacks and home lunch. School meals are vegetarian (no meat); packed snacks are dry and not cooked that morning. Respect the household's operating limits supplied in the context: hard dietary exclusions, unavailable weekly inventory, the per-day morning cook budget, and prior-night-prep rules. Plans default to healthy, nutritious meals; the persistent custom policies define any scheduled exceptions. The context also lists the household's persistent custom policies; for every relevant one, record a concise outcome with a short rationale, and never claim certainty when a policy cannot be interpreted confidently.

The context's request.kind tells you whether the request is an initial_plan or a revision. When it is a revision, keep the elapsed days' dishes unchanged unless the feedback explicitly targets them; apply changes from today onward. If a parent reports a concrete week-state fact such as an ingredient running out, a holiday, a half day, or a schedule change, call update_week_context first. It accepts only the affected inventory items and exception additions. Set replan false unless the parent explicitly asks to change the plan too. If replan is true, the workflow will apply the update and start a fresh revision with that context; do not submit a candidate in the same action. Treat every submitted feedback item as the driver: a cell-scoped item must be addressed in that cell, an unbound item against the plan as a whole. If unbound feedback does not identify what should improve — for example, "make this better" — ask one concise clarification about the decision that matters (speed, nutrition, packing dryness, preference, or inventory). Do not make an arbitrary change or treat it as satisfied by a rationale.

Validate the candidate with evaluate_meal_plan, revise objective failures, self-check the free-form policies, then finish with exactly one terminal action. Call propose_plan only when the evaluation passes and every submitted feedback is represented by a feedbackItems entry or an outcome rationale. Include a short justification in propose_plan explaining the plan in plain language. Call needs_clarification when a targeted question is required to plan confidently; include every failure code from the latest evaluation when there is one. Before evaluation, use an empty reasonCodes list unless the clarification is caused directly by a known hard constraint; then include its applicable failure code, such as hard_exclusion. Keep the message concise, in plain language. Never expose opaque ids, credentials, or internal tokens in the message.

Build the initial grid or revision patch from meal selections. The context provides complete structured catalog records: use their listed slots, packing facts, cook minutes, prep requirement, and required ingredients rather than inferring them. Established meals use their mealDefinitionId; ingredientChoices may contain only the permitted choices listed for that definition, and usesPriorNightPrep is meaningful only when prep is optional. If a catalog ingredient and the parent inventory use different names for the same ingredient, explicitly map the inventory spelling to the catalog spelling in ingredientAliasesUsed. Use this only for a genuine semantic match, for example { "Rajma": "Kidney Beans" }; both names must be present in the context. A plan-local provisional meal is reused by its provisionalMealId exactly as listed in the context.

Known selection example: { "mealDefinitionId": "meal_opaque_paratha", "ingredientChoices": ["spinach"], "ingredientAliasesUsed": [{ "availableIngredient": "whole-wheat atta", "definitionIngredient": "wheat flour" }], "usesPriorNightPrep": true }.

When new foods are allowed and no suitable known meal can be selected, submit a structured proposal, for example: { "proposedMeal": { "name": "Carrot rice", "principalIngredients": ["rice", "carrots"], "vegetarian": true, "suitableSlots": ["home-lunch"], "packedFood": { "suitable": false, "dry": false }, "cookMinutes": 20, "priorNightPrep": "optional", "ingredients": ["rice", "carrots"] }, "usesPriorNightPrep": false }. For every proposed meal, keep principalIngredients and ingredients limited to dense, primary, meal-defining ingredients: grains, pulses, flour, dairy, specifically named produce, or prepared components. Do not add vague aggregates such as "vegetables" or "mixed vegetables", and do not add routine pantry seasonings or cooking basics such as salt, oil, turmeric, chilli, cumin, mustard seeds, curry leaves, or generic spices. Those are covered by the pantry baseline and must not create ingredient-availability failures. A new packed meal must travel safely in an ordinary lunchbox, have no likely spill or leak, be independently edible by hand or ordinary spoon, and require no reheating, cooking, assembly, or special equipment; dry slots additionally require dry spill-resistant food.

easyBuys is the short list of ordinary ingredients you are adding this week: staples, all-season vegetables and fruits, and everyday items from a neighborhood grocery. It is not the week's whole shopping list. Do not place a dish name in easyBuys. Unless an inventory entry says otherwise, treat a listed fresh fruit or vegetable as sufficient for one planned meal; do not repeat it in easyBuys just because you use it. Pantry-baseline items are ordinarily stocked staples and may support normal reuse. When a request lists ingredients, ensure they are represented in inventory, pantry baseline, or easyBuys. Favourites may repeat; keep other dishes distinct. A new week's plan should differ from the previous week's cooked mains while a fruit, dry fruit, or dry snack may repeat in a snack slot as a last resort.`

export interface MealPlanningAgentSessionOptions {
  context: MealPlanContext
  /** Active hydrated candidate retained by server while a revision is patched. */
  revisionBaseCandidate?: MealPlanCandidate
  /** Disabled after a context update is persisted before the follow-up replan session. */
  allowWeekContextUpdate?: boolean
  /** Debug aid: keep provider reasoning in the returned transcript. */
  retainReasoning?: boolean
  /** Development-only diagnostics for provider turns. */
  onProviderTurnStart?: (turn: number, messages: readonly ToolConversationMessage[]) => void
  onProviderTurn?: (turn: number, messages: readonly ToolConversationMessage[], durationMs: number) => void
  onProviderTurnFailure?: (turn: number, durationMs: number, error: unknown) => void
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
  | { kind: "update_week_context"; update: ResolvedWeekContextUpdate }
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
  // The workflow always supplies this for revisions. Keeping the session's
  // low-level test harness usable without persisted state preserves existing
  // full-candidate callers, while production revisions always use patches.
  const isRevisionPatch = options.context.request.kind === "revision" && options.revisionBaseCandidate !== undefined
  const canUpdateWeekContext = options.context.request.kind === "revision" && options.allowWeekContextUpdate !== false
  const evaluationTool = createEvaluateMealPlanTool(options.context, options.revisionBaseCandidate)
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
      description:
        "Terminal action after a passing evaluation. Submit the candidate, optional feedback scope interpretations, and optional short justification; the workflow supplies inventory and exceptions.",
      input: isRevisionPatch ? proposePlanRevisionWireInputSchema : proposePlanWireInputSchema,
      output: acceptedOutputSchema,
      privacy: "private",
      batching: "isolated",
      handler: async (input) => {
        const policyIds = options.context.customPolicies.map((policy) => policy.id)
        const candidate = isRevisionPatch
          ? mealPlanSelectionPatchFromWire(input.candidate, policyIds)
          : mealPlanSelectionCandidateFromWire(input.candidate, policyIds)
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
        const evaluationContext = { ...options.context, feedbackItems: evaluationFeedback }
        const selectionEvaluation =
          isRevisionPatch && options.revisionBaseCandidate
            ? evaluateMealPlanSelectionPatch(
                candidate as MealPlanSelectionPatch,
                options.revisionBaseCandidate,
                evaluationContext,
              )
            : evaluateMealPlanSelection(candidate as MealPlanSelectionCandidate, evaluationContext)
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
          weeklyInventory: options.context.weeklyInventory,
          weeklyExceptions: options.context.weeklyExceptions,
          ...(evaluationFeedback.length ? { feedbackItems: evaluationFeedback } : {}),
          ...(input.justification
            ? { justification: input.justification.slice(0, PROPOSE_JUSTIFICATION_MAX_CHARACTERS) }
            : {}),
          evaluation,
        }
        return { accepted: true as const }
      },
    },
    [MEAL_PLANNING_TOOL.UPDATE_WEEK_CONTEXT]: {
      name: MEAL_PLANNING_TOOL.UPDATE_WEEK_CONTEXT,
      description:
        "Terminal action for a parent-reported inventory or calendar fact. It updates only the active week's context; set replan true only when the parent explicitly requests a plan revision too.",
      input: weekContextUpdateInputSchema,
      output: acceptedOutputSchema,
      privacy: "private",
      batching: "isolated",
      handler: async (input) => {
        if (!canUpdateWeekContext)
          throw new ToolHandlerError("week context can only be updated from an active-plan revision", "invalid-state")
        terminal = { kind: "update_week_context", update: resolveWeekContextUpdate(options.context, input) }
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
  const initialAllowedTools = [
    MEAL_PLANNING_TOOL.EVALUATE,
    ...(canUpdateWeekContext ? [MEAL_PLANNING_TOOL.UPDATE_WEEK_CONTEXT] : []),
    MEAL_PLANNING_TOOL.CLARIFY,
  ]
  const terminalTools = [MEAL_PLANNING_TOOL.PROPOSE, MEAL_PLANNING_TOOL.CLARIFY]
  const handoffTools = [...terminalTools, ...(canUpdateWeekContext ? [MEAL_PLANNING_TOOL.UPDATE_WEEK_CONTEXT] : [])]
  const result = await runTools(
    provider,
    registry,
    {
      allowedTools: initialAllowedTools,
      handoffTools,
      requireHandoff: true,
      // DeepSeek rejects required tool choice when thinking mode is enabled.
      // The terminal-only allowlist and explicit post-evaluation instruction
      // still make the handoff unambiguous while preserving reasoning mode.
      toolChoice: "auto",
      reasoning: "high",
      nextAllowedTools: (executedTools) =>
        executedTools.includes(MEAL_PLANNING_TOOL.EVALUATE)
          ? latestEvaluation?.pass
            ? terminalTools
            : [MEAL_PLANNING_TOOL.EVALUATE, ...terminalTools]
          : initialAllowedTools,
      nextInstruction: (executedTools) =>
        executedTools.includes(MEAL_PLANNING_TOOL.EVALUATE) && latestEvaluation?.pass
          ? "Evaluation passed. Call exactly one terminal tool now: propose_plan to submit the evaluated candidate, or needs_clarification only if a real unresolved decision remains. Do not answer with prose. propose_plan receives candidate, optional feedback scope interpretations, and an optional short justification; inventory and exceptions are already held by the workflow."
          : undefined,
      // A full Mon–Sat candidate is a large nested schema; the model often needs
      // an extra evaluate-revise turn, so grant more turns than the default
      // shared budget without changing other workflows.
      maxProviderTurns: 8,
      maxToolCalls: 12,
      onProviderTurnStart: options.onProviderTurnStart,
      onProviderTurn: options.onProviderTurn,
      onProviderTurnFailure: options.onProviderTurnFailure,
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

/** Applies restricted, parent-reported week-state facts without allowing a model to replace the whole context. */
export function resolveWeekContextUpdate(
  context: MealPlanContext,
  input: WeekContextUpdateInput,
): ResolvedWeekContextUpdate {
  if (input.inventoryChanges.length === 0 && input.exceptionAdds.length === 0)
    throw new ToolHandlerError("week context update must contain at least one change", "invalid-state")

  const normalized = (value: string) => value.trim().toLocaleLowerCase()
  const inventory = new Map(context.weeklyInventory.items.map((item) => [normalized(item.name), item]))
  const changedNames = new Set<string>()
  for (const item of input.inventoryChanges) {
    const key = normalized(item.name)
    if (!key || changedNames.has(key))
      throw new ToolHandlerError("inventory changes must have distinct non-empty names", "invalid-state")
    changedNames.add(key)
    inventory.set(key, { ...item, name: item.name.trim() })
  }

  const days = new Set(context.schedule.days)
  const slots = new Set(context.schedule.slots.map((slot) => slot.id))
  const exceptionKey = (exception: (typeof context.weeklyExceptions.items)[number]) =>
    JSON.stringify({
      kind: exception.kind,
      day: exception.appliesTo?.day,
      mealSlots: [...(exception.appliesTo?.mealSlots ?? [])].sort(),
    })
  const existingExceptions = new Set(context.weeklyExceptions.items.map(exceptionKey))
  const addedExceptions = new Set<string>()
  for (const exception of input.exceptionAdds) {
    const day = exception.appliesTo?.day
    if (day && !days.has(day)) throw new ToolHandlerError(`unknown exception day ${day}`, "invalid-state")
    if (exception.appliesTo?.mealSlots?.some((slot) => !slots.has(slot)))
      throw new ToolHandlerError("exception references an unknown meal slot", "invalid-state")
    if (exception.kind === "school_closed" && !day)
      throw new ToolHandlerError("school_closed requires an applicable day", "invalid-state")
    const key = exceptionKey(exception)
    if (existingExceptions.has(key) || addedExceptions.has(key))
      throw new ToolHandlerError("week context update duplicates an existing exception", "invalid-state")
    addedExceptions.add(key)
  }

  return {
    weeklyInventory: { ...context.weeklyInventory, items: [...inventory.values()] },
    weeklyExceptions: { items: [...context.weeklyExceptions.items, ...input.exceptionAdds] },
    replan: input.replan,
  }
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
