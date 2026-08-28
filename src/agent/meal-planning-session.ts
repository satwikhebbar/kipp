import { evaluateMealPlan } from "../meal-planning/evaluation"
import type {
  FailureCode,
  FeedbackItem,
  MealPlanCandidate,
  MealPlanContext,
  MealPlanEvaluation,
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

const MEAL_PLANNING_AGENT_PROMPT = `You are a parent's meal-planning agent for school days. Interpret the parent's request and use only the provided actions.

Build one complete Monday–Saturday school-week plan. School meals are vegetarian (no meat); packed snacks are dry and not cooked that morning. Respect the household's operating limits supplied in the context: hard dietary exclusions, unavailable weekly inventory, the per-day morning cook budget, and prior-night-prep rules. Plans default to healthy, nutritious meals; the persistent custom policies define any scheduled exceptions. The context also lists the household's persistent custom policies; for every relevant one, record a concise satisfied, trade-off, or needs-clarification outcome with a short rationale, and never claim certainty when a policy cannot be interpreted confidently.

The context's request.kind tells you whether the request is an initial_plan or a revision. When it is a revision, keep the elapsed days' dishes unchanged unless the feedback explicitly targets them; apply changes from today onward. Treat every submitted feedback item as the driver: a cell-scoped item must be addressed in that cell, an unbound item against the plan as a whole.

Validate the candidate with evaluate_meal_plan, revise objective failures, self-check the free-form policies, then finish with exactly one terminal action. Call propose_plan only when the evaluation passes and every submitted feedback is represented by a feedbackItems entry or an outcome rationale. Call needs_clarification when a targeted question is required to plan confidently; include every failure code from the latest evaluation and keep the message concise, in plain language. Never expose opaque ids, credentials, or internal tokens in the message.

A cell's items are the dish's ingredient tokens, drawn only from the weekly inventory, the pantry baseline, or the easy-buys list (the short list of ordinary ingredients you are adding). Never put a dish name itself in items or easyBuys. When the request lists ingredients, add them to easyBuys so the evaluator accepts them.

Example of one day's cells:
Mon: breakfast { "dish": "paratha", "vegetarian": true, "items": ["wheat flour"], "cookMinutes": 15, "priorNightPrep": false }
     snack1 { "dish": "banana", "vegetarian": true, "items": ["banana"], "cookMinutes": 0, "priorNightPrep": false }
     snack2 { "dish": "roasted chana", "vegetarian": true, "items": ["chana"], "cookMinutes": 0, "priorNightPrep": false }
     school-lunch { "dish": "bottle gourd dal", "vegetarian": true, "items": ["bottle gourd", "moong dal"], "cookMinutes": 20, "priorNightPrep": false }
     home-lunch { "dish": "rice and beans", "vegetarian": true, "items": ["rice", "beans"], "cookMinutes": 20, "priorNightPrep": false }
with easyBuys = ["banana", "chana", "bottle gourd", "beans"] when those are not already in inventory. Other days follow the same shape with the same five slots.`

export interface MealPlanningAgentSessionOptions {
  context: MealPlanContext
}

export type MealPlanningTerminalOutcome =
  | {
      kind: "propose_plan"
      candidate: MealPlanCandidate
      weeklyInventory: WeeklyInventory
      weeklyExceptions: WeeklyExceptions
      feedbackItems?: FeedbackItem[]
      evaluation: MealPlanEvaluation
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
        const context = {
          ...options.context,
          weeklyInventory: input.weeklyInventory,
          weeklyExceptions: input.weeklyExceptions,
        }
        const rawFeedback = options.context.feedbackItems ?? []
        const submittedFeedback: FeedbackItem[] = input.feedbackItems ?? []
        // The model-controlled submission cannot redefine feedback: ids and text
        // must match the authoritative items exactly, and an explicit
        // authoritative scope cannot be altered or dropped. Free-text feedback
        // carries no parsed scope, so the model may attach the interpretation it
        // actually plans against — that is what the evaluator's scope checks need.
        assertAuthoritativeFeedback(rawFeedback, submittedFeedback)
        // Evaluation must always see every authoritative scoped item, even when
        // the model omits it from the submission — otherwise a scoped item that
        // only appears in a policy rationale is never checked against its target
        // cell. Submitted feedback may only supply the model's interpretation for
        // authoritative items that carry no parsed scope.
        const authoritativeByScope = new Map(rawFeedback.map((item) => [item.id, item]))
        const evaluationFeedback = [
          ...rawFeedback.filter((item) => item.scope),
          ...submittedFeedback.filter((item) => authoritativeByScope.get(item.id)?.scope === undefined),
        ]
        const evaluation = evaluateMealPlan(input.candidate, {
          ...context,
          feedbackItems: evaluationFeedback,
        })
        if (!evaluation.pass) throw new ToolHandlerError("proposed plan did not pass evaluation", "invalid-state")
        enforceFeedbackCoverage(rawFeedback, submittedFeedback, input.candidate)
        terminal = {
          kind: "propose_plan",
          candidate: input.candidate,
          weeklyInventory: input.weeklyInventory,
          weeklyExceptions: input.weeklyExceptions,
          ...(submittedFeedback.length ? { feedbackItems: submittedFeedback } : {}),
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
      toolChoice: "required",
      reasoning: "disabled",
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
    messages: persistableAgentMessages(result.messages),
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
 * Rejects a model-controlled feedback submission that invents or alters an
 * item: each submitted item must match an authoritative raw item's id and text
 * exactly, and must not drop or change an explicit authoritative scope (a scope
 * may be attached only when the raw item carries none).
 */
function assertAuthoritativeFeedback(rawFeedback: FeedbackItem[], submittedFeedback: FeedbackItem[]): void {
  const authoritative = new Map(rawFeedback.map((item) => [item.id, item]))
  for (const item of submittedFeedback) {
    const raw = authoritative.get(item.id)
    if (!raw || raw.text !== item.text || (raw.scope && !scopeEqual(raw.scope, item.scope)))
      throw new ToolHandlerError(
        "proposed feedback items must match the authoritative feedback exactly",
        "invalid-state",
      )
  }
}

/** True when two feedback scopes are equal (either both unset, or same day and slot). */
function scopeEqual(a: FeedbackItem["scope"], b: FeedbackItem["scope"]): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.day === b.day && a.slot === b.slot
}

/**
 * Enforces that every raw feedback item driving a revision is represented in
 * the submitted payload or an outcome rationale — the session-side mirror of
 * the evaluator's `unaddressed_feedback`.
 */
function enforceFeedbackCoverage(
  rawFeedback: FeedbackItem[],
  submittedFeedback: FeedbackItem[],
  candidate: MealPlanCandidate,
): void {
  const submittedIds = new Set(submittedFeedback.map((item) => item.id))
  for (const raw of rawFeedback) {
    const inSubmitted = submittedIds.has(raw.id)
    const inRationale = Object.values(candidate.policyOutcomes).some(
      (outcome) => outcome.rationale.includes(raw.id) || outcome.rationale.includes(raw.text),
    )
    if (!inSubmitted && !inRationale)
      throw new ToolHandlerError("proposed plan did not address all submitted feedback", "invalid-state")
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
