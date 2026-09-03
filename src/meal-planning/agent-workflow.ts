import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers"
import { acceptedOutputSchema, weekContextExtractionInputSchema } from "../agent/meal-planning"
import {
  type MealPlanningAgentSessionResult,
  type MealPlanningTerminalOutcome,
  resolveWeekContextUpdate,
  runMealPlanningAgentSession,
} from "../agent/meal-planning-session"
import { createInteractionRouter, type InteractionRegistration } from "../core/interaction-router-client"
import { type Env, INTERACTION_KIND, type WorkflowInteractionKind } from "../core/types"
import { createTelegramClient } from "../integrations/telegram"
import { createToolProvider, type ToolConversationMessage, type ToolProviderRequestEvent } from "../providers"
import { logRuntime } from "../runtime/logging"
import { stripNullProperties } from "../runtime/tool-runner"
import { computeCoverageSet } from "./coverage"
import { normalizeIngredient } from "./ingredient-normalization"
import {
  MEAL_AGENT_UNAVAILABLE,
  MEAL_FEEDBACK_NOT_APPLIED,
  MEAL_NO_CHANGES,
  MEAL_OPEN_FEEDBACK_PROMPT,
  MEAL_PLANNING_CANCELED,
  MEAL_STALE_PLAN,
  renderPlanLaunchMessage,
} from "./messages"
import {
  type ActivePlanRecord,
  createMealPlanningStore,
  type FeedbackBatchRecord,
  type MealPlanningStore,
  type MealPlanRecord,
  type MealPlanVersionRecord,
  type StoredMealProfile,
} from "./store"
import { coerceSubmission, type Submission } from "./submissions"
import type { FeedbackItem, FeedbackTarget, MealDefinition, MealPlanCandidate, MealPlanContext } from "./types"
import { enrichLunchVideos } from "./video"
import { resolvePlanningWeek } from "./week"
import type { MealPlanningWorkflowParams } from "./workflow"

const MEAL_PLANNING_TIMEZONE_DEFAULT = "Asia/Kolkata"
const MEAL_PLANNING_TTL_MS = 1_800_000 // 30 minutes: one bounded planning session
const MEAL_CLARIFICATION_TTL_MS = 900_000 // 15 minutes: clarification prompt lifetime
const MEAL_FEEDBACK_REPLY_TTL_MS = 900_000 // 15 minutes: feedback prompt lifetime
const MEAL_PLANNING_GROUP = "meal-planning"
const MEAL_LIVE_WAIT_CHUNK_MS = 86_400_000 // 24 hours: parked live-loop re-wait chunk
const MEAL_MAX_SESSION_TURNS = 10
const MILLISECONDS_PER_SECOND = 1_000
const TRANSCRIPT_TEXT_MAX_CHARACTERS = 4_000
const MEAL_PLANNER_PROVIDER = "openrouter"
const MEAL_PLANNER_MODEL = "openai/gpt-5.6-luna"
const WEEK_CONTEXT_EXTRACTION_PROMPT = `Extract only concrete week-scoped facts from the parent's message. Return inventoryChanges for ingredients the parent says they have or do not have, using status available or unavailable, and exceptionAdds for explicit holidays, half-days, or schedule changes. Ignore whether the parent used a singular or plural spelling: always force every ingredient name into its singular canonical form (for example, output "carrot" even when the parent says "carrots"). Use the exact schedule day and slot identifiers supplied below (for example, use "Mon" rather than "Monday" and "school-lunch" rather than "lunch"). Do not infer facts, add pantry staples, or plan meals. Return empty arrays when no such fact is stated.`

export function renderWeekContextExtractionPrompt(context: Pick<MealPlanContext, "schedule">): string {
  return `${WEEK_CONTEXT_EXTRACTION_PROMPT}\nSchedule days: ${context.schedule.days.join(", ")}\nMeal slots: ${context.schedule.slots.map((slot) => slot.id).join(", ")}`
}

export interface MealPlanningLiveEvent {
  interactionKind?: WorkflowInteractionKind
  source?: "telegram-text" | "telegram-reply" | "mini-app"
  text?: string
  messageId?: number
  interactionId?: string
  version?: number
  /** Server-owned Mini App batch identity; never accepted from ordinary Telegram text. */
  feedbackBatchId?: string
  /** The version the Mini App saw when its server-side batch was accepted. */
  baseVersion?: number
  /** Structured per-cell submissions delivered by the iteration-2 mini-app. */
  items?: Array<{ id: string; text: string; target?: FeedbackTarget; scope?: { day?: string; slot?: string } }>
}

type PlanningOutcome =
  | { kind: "proposed"; propose: Extract<MealPlanningTerminalOutcome, { kind: "propose_plan" }> }
  | {
      kind: "week_context_updated"
      update: Extract<MealPlanningTerminalOutcome, { kind: "update_week_context" }>["update"]
    }
  | { kind: "abandoned" }

function renderMealDefinition(meal: MealDefinition): string {
  return JSON.stringify({
    id: meal.id,
    name: meal.name,
    suitableSlots: meal.suitableSlots,
    packedFood: meal.packedFood ?? null,
    typicalCookMinutes: meal.typicalCookMinutes,
    priorNightPrep: meal.priorNightPrep,
    requiredIngredients: meal.requiredIngredients,
    permittedIngredientChoices: [...meal.optionalIngredients, ...(meal.allowedIngredientChoices ?? [])],
  })
}

function renderInventoryItem(item: MealPlanContext["weeklyInventory"]["items"][number]): string {
  const annotations = [item.status === "available" ? undefined : item.status, item.quantityNote, item.useNote].filter(
    (value): value is string => Boolean(value),
  )
  return annotations.length ? `${item.name} (${annotations.join("; ")})` : item.name
}

/** Renders revision feedback without exposing its opaque storage identifier. */
export function renderRevisionFeedback(items: FeedbackItem[]): string {
  if (items.length === 0) return "- No submitted feedback."
  return items
    .map((item) => {
      if (item.target?.kind === "plan") return `- Feedback for the whole plan: ${item.text}`
      if (item.target?.kind === "cell") return `- Feedback for ${item.target.day} ${item.target.slot}: ${item.text}`
      const scope = item.scope
      if (scope?.day && scope.slot) return `- Feedback for ${scope.day} ${scope.slot}: ${item.text}`
      if (scope?.day) return `- Feedback for every meal on ${scope.day}: ${item.text}`
      if (scope?.slot) return `- Feedback for every ${scope.slot}: ${item.text}`
      return `- Unbound feedback: ${item.text}`
    })
    .join("\n")
}

/** Renders neutral temporal facts so the planner can resolve relative dates against its active school week. */
export function renderPlanningTimeContext(
  currentInstant: Date,
  timezone: string,
  weekStart: string,
  weekEnd: string,
): string {
  return [
    `Current instant: ${currentInstant.toISOString()}`,
    `Time zone: ${timezone}`,
    `Planning-week start: ${weekStart}`,
    `Planning-week end: ${weekEnd}`,
  ].join("\n")
}

/** Renders the household operating context the planning model must see (profile, schedule, policies, week state). */
export function renderHouseholdContext(context: MealPlanContext): string {
  const p = context.profile
  const lines = [
    `Household operating context:`,
    `- Schedule days: ${context.schedule.days.join(", ")}`,
    `- Slots: ${context.schedule.slots
      .map(
        (s) =>
          `${s.id} (${s.packed ? "packed" : "not packed"}, ${s.dry ? "dry" : "not dry"}, maxCookMinutes: ${s.maxCookMinutes ?? "unlimited"})`,
      )
      .join(", ")}`,
    `- Dietary exclusions (hard): ${p.dietaryExclusions.join(", ") || "none"}`,
    `- Established meal definitions (one JSON record per available catalog meal; select only by id):\n${
      (p.mealDefinitions ?? [])
        .filter((meal) => meal.status === "established")
        .map((meal) => `    ${renderMealDefinition(meal)}`)
        .join("\n") || "    none"
    }`,
    `- Plan-local provisional definitions (one JSON record per reusable meal):\n${(context.provisionalMealDefinitions ?? []).map((meal) => `    ${renderMealDefinition(meal)}`).join("\n") || "    none"}`,
    `- Food preferences: favourites = ${p.foodPreferences.favourites.join(", ") || "none"}, avoid = ${p.foodPreferences.avoid.join(", ") || "none"}`,
    `- New foods allowed: ${p.allowNewFoods ? "yes" : "no"}`,
    `- Sensory guidelines: ${p.sensoryGuidelines.join(", ") || "none"}`,
    `- Morning cook budget: ${p.morningCookingBudgetMinutes} minutes per day`,
    `- Prior-night prep allowed: ${p.priorNightPrepAllowed ? "yes" : "no"}`,
    `- Pantry baseline: ${p.pantryBaseline.join(", ") || "none"}`,
  ]
  if (context.customPolicies.length) {
    lines.push(`- Persistent custom policies:`)
    for (const policy of context.customPolicies) {
      lines.push(`    [${policy.id}] ${policy.label}: "${policy.value}"`)
    }
  }
  lines.push(`- Weekly inventory: ${context.weeklyInventory.items.map(renderInventoryItem).join(", ") || "none"}`)
  if (context.weeklyInventory.notes.length) lines.push(`  inventory notes: ${context.weeklyInventory.notes.join("; ")}`)
  if (context.weeklyExceptions.items.length) {
    lines.push(`- Weekly exceptions:`)
    for (const exception of context.weeklyExceptions.items) {
      const appliesTo = exception.appliesTo
      const target = appliesTo ? ` (${[appliesTo.day, ...(appliesTo.mealSlots ?? [])].filter(Boolean).join(", ")})` : ""
      lines.push(`    ${exception.kind}${target}: "${exception.instruction}"`)
    }
  }
  lines.push(`- Request kind: ${context.request.kind}`)
  if (context.recentPlan) {
    lines.push(`- Recent plan (change only the cells feedback targets):`)
    for (const [day, cells] of Object.entries(context.recentPlan)) {
      for (const [slot, cell] of Object.entries(cells)) {
        lines.push(
          `    ${day} ${slot}: ${cell.dish} (items: ${cell.items.join(", ")}; cook ${cell.cookMinutes} min; prior-night prep: ${cell.priorNightPrep ? "yes" : "no"})`,
        )
      }
    }
  }
  return lines.join("\n")
}

/**
 * Runs the bounded meal-planning workflow: load household state, resolve the
 * target week, run the planning-agent session (with 15-min clarification
 * prompts), persist the plan atomically via the D1 store, send the plan
 * message with a live [Give feedback] button, then park in a week-long live
 * loop that turns every feedback submission into a revision. Evaluator-gated
 * persistence: `propose_plan` already requires a passing evaluation, and
 * promotion is CAS-guarded on `current_version` (a stale revision changes
 * nothing and surfaces `meal-stale-plan`).
 */
export async function runAgentCenteredMealPlanningWorkflow(
  env: Env,
  event: WorkflowEvent<MealPlanningWorkflowParams>,
  step: WorkflowStep,
): Promise<void> {
  logRuntime(env, { workflow: event.instanceId, event: "meal-planning-workflow-run", outcome: "started" })
  const store = createStore(env)
  const timezone = env.TIMEZONE || MEAL_PLANNING_TIMEZONE_DEFAULT

  const profile = await stepDo(step, "meal-planning-load-profile", () =>
    store.loadOrCreateProfile(event.payload.chatId),
  )
  const week = resolvePlanningWeek(event.payload.invokedAtMs, timezone, event.payload.requestText)
  const recent = await stepDo(step, "meal-planning-read-recent", () => store.activePlan(event.payload.chatId))

  const baseContext: MealPlanContext = {
    schedule: profile.schedule,
    profile: profile.profile,
    customPolicies: profile.customPolicies,
    weeklyInventory: recent?.plan.weeklyInventory ?? { items: [], notes: [] },
    weeklyExceptions: recent?.plan.weeklyExceptions ?? { items: [] },
    recentPlan: recent?.version.candidate.grid ?? null,
    // Provisional meals are owned by a plan version. They may be reused by a
    // revision of that plan, but must never leak into a new initial plan.
    provisionalMealDefinitions: [],
    request: { kind: "initial_plan", text: event.payload.requestText },
  }
  const context = await extractInitialWeekContext(env, step, event, baseContext)
  const messages: ToolConversationMessage[] = [
    {
      role: "user",
      text: `${renderPlanningTimeContext(new Date(), timezone, week.weekStart, week.weekEnd)}\nRequest: ${event.payload.requestText || "/mealplan"}\n\n${renderHouseholdContext(context)}`,
    },
  ]
  const outcome = await runPlanningSession(env, step, event, {
    context,
    messages,
    isRevision: false,
    occurrence: "initial",
  })
  if (outcome?.kind !== "proposed") return

  // Optional enrichment must precede the persist batch: version rows are insert-only (§8).
  const enriched = await stepDo(step, "meal-planning-video-enrich", () =>
    enrichLunchVideos(env, outcome.propose.candidate),
  )

  const planId = `mealplan-${event.payload.chatId}-${crypto.randomUUID()}`
  const persisted = await stepDo(step, "meal-planning-create-plan", () =>
    store.createActivePlan({
      planId,
      chatId: event.payload.chatId,
      weekStart: week.weekStart,
      weekEnd: week.weekEnd,
      timezone,
      instanceId: event.instanceId,
      candidate: enriched.candidate,
      video: enriched.video,
      evaluation: outcome.propose.evaluation,
      weeklyInventory: outcome.propose.weeklyInventory,
      weeklyExceptions: outcome.propose.weeklyExceptions,
      provisionalMealDefinitions: outcome.propose.provisionalMealDefinitions,
    }),
  )

  await sendPlanAndRegister(
    env,
    step,
    event,
    profile,
    persisted.plan,
    persisted.version,
    persisted.generation,
    "initial",
  )
  await liveWeekLoop(env, step, event, store, profile, persisted.plan, persisted.generation)
}

async function extractInitialWeekContext(
  env: Env,
  step: WorkflowStep,
  event: WorkflowEvent<MealPlanningWorkflowParams>,
  context: MealPlanContext,
): Promise<MealPlanContext> {
  if (!event.payload.requestText?.trim()) return context
  const result = await stepDo(step, "meal-planning-extract-week-context", async () => {
    try {
      const provider = createToolProvider(
        env.OPENROUTER_API_KEY,
        MEAL_PLANNER_PROVIDER,
        MEAL_PLANNER_MODEL,
        Number(env.LLM_MAX_RETRIES || "3"),
        { onRequestEvent: (requestEvent) => logProviderRequestEvent(env, event.instanceId, requestEvent) },
      )
      const response = await provider.generate({
        messages: [
          { role: "system", text: renderWeekContextExtractionPrompt(context) },
          { role: "user", text: event.payload.requestText || "/mealplan" },
        ],
        tools: [
          {
            name: "extract_week_context",
            description: "Extract only parent-supplied inventory and calendar facts.",
            input: weekContextExtractionInputSchema,
            output: acceptedOutputSchema,
            privacy: "private",
            batching: "isolated",
            handler: async () => ({ accepted: true as const }),
          },
        ],
        toolChoice: "required",
        reasoning: "disabled",
      })
      const call = response.toolCalls?.find((candidate) => candidate.name === "extract_week_context")
      const parsed = weekContextExtractionInputSchema.safeParse(stripNullProperties(call?.input))
      if (!parsed.success) {
        logRuntime(env, {
          workflow: event.instanceId,
          event: "meal-planning-context-extraction",
          outcome: "failed",
          failureCategory: "invalid-output",
          details: { phase: "parsed", toolCallPresent: Boolean(call) },
        })
        return context
      }
      const inventoryChanges = parsed.data.inventoryChanges
        .map(({ name, status }) => `${normalizeIngredient(name)}:${status}`)
        .join(",")
      const exceptionAdds = parsed.data.exceptionAdds
        .map((exception) => `${exception.kind}:${JSON.stringify(exception.appliesTo ?? {})}`)
        .join(",")
      if (parsed.data.inventoryChanges.length === 0 && parsed.data.exceptionAdds.length === 0) {
        logRuntime(env, {
          workflow: event.instanceId,
          event: "meal-planning-context-extraction",
          outcome: "succeeded",
          details: { applied: false, inventoryChanges, exceptionAdds },
        })
        return context
      }
      const update = resolveWeekContextUpdate(context, { ...parsed.data, replan: false })
      logRuntime(env, {
        workflow: event.instanceId,
        event: "meal-planning-context-extraction",
        outcome: "succeeded",
        details: { applied: true, inventoryChanges, exceptionAdds },
      })
      return { ...context, weeklyInventory: update.weeklyInventory, weeklyExceptions: update.weeklyExceptions }
    } catch (error) {
      logRuntime(env, {
        workflow: event.instanceId,
        event: "meal-planning-context-extraction",
        outcome: "failed",
        failureCategory: error instanceof Error ? error.name : "unknown",
      })
      return context
    }
  })
  return result
}

/** Resolves the store binding, failing loudly when the D1 database is not configured. */
function createStore(env: Env): MealPlanningStore {
  if (!env.MEAL_PLANNING_DB) throw new Error("MEAL_PLANNING_DB binding is not configured")
  return createMealPlanningStore(env.MEAL_PLANNING_DB)
}

/** Runs one durable step, casting past the runtime's `Serializable` wrapper to the caller's expected type. */
async function stepDo<T>(step: WorkflowStep, name: string, fn: () => Promise<T>): Promise<T> {
  return (await step.do(name, fn as never)) as unknown as T
}

/**
 * Runs one bounded planning session turn loop (bounded by the 30-min session
 * TTL and the turn cap): a `needs_clarification` handoff blocks on a 15-min
 * force-reply prompt (timeout → canceled/not-applied notice), a `propose_plan`
 * handoff returns the candidate for persistence. `occurrence` is a stable
 * per-session key (`initial` or `revision-<live-loop-iteration>`) that scopes
 * every durable step name so name-memoized replays never reuse another
 * session's steps.
 */
async function runPlanningSession(
  env: Env,
  step: WorkflowStep,
  event: WorkflowEvent<MealPlanningWorkflowParams>,
  options: {
    context: MealPlanContext
    messages: ToolConversationMessage[]
    isRevision: boolean
    /** Retained only for revision patch hydration; never supplied to the model as ids. */
    revisionBaseCandidate?: MealPlanCandidate
    allowWeekContextUpdate?: boolean
    occurrence: string
  },
): Promise<PlanningOutcome | null> {
  const notifyPrefix = `meal-planning-notify-${options.occurrence}`
  const sessionDeadline = Date.now() + MEAL_PLANNING_TTL_MS
  for (let turn = 0; turn < MEAL_MAX_SESSION_TURNS; turn++) {
    if (Date.now() > sessionDeadline) {
      await notify(env, step, event.payload.chatId, MEAL_AGENT_UNAVAILABLE, `${notifyPrefix}-session-deadline`)
      return { kind: "abandoned" }
    }
    const session = await stepDo(step, `meal-planning-agent-session-${options.occurrence}-${turn}`, async () => {
      try {
        const provider = createToolProvider(
          env.OPENROUTER_API_KEY,
          MEAL_PLANNER_PROVIDER,
          MEAL_PLANNER_MODEL,
          Number(env.LLM_MAX_RETRIES || "3"),
          { onRequestEvent: (requestEvent) => logProviderRequestEvent(env, event.instanceId, requestEvent) },
        )
        return await runMealPlanningAgentSession(provider, options.messages, {
          context: options.context,
          revisionBaseCandidate: options.revisionBaseCandidate,
          allowWeekContextUpdate: options.allowWeekContextUpdate,
          onProviderTurnStart: (turn, messages) => logAgentTurnStart(env, event.instanceId, turn, messages),
          onProviderTurn: (turn, messages, durationMs) =>
            logAgentTurn(env, event.instanceId, turn, messages, durationMs),
          onProviderTurnFailure: (turn, durationMs, error) =>
            logAgentTurnFailure(env, event.instanceId, turn, durationMs, error),
        })
      } catch (_error) {
        // Upstream provider failure becomes an intelligible notice, not a crashed instance.
        logRuntime(env, {
          workflow: event.instanceId,
          event: "meal-planning-agent-session",
          outcome: "failed",
          failureCategory: "provider-error",
        })
        return null
      }
    })
    if (session === null) {
      await notify(env, step, event.payload.chatId, MEAL_AGENT_UNAVAILABLE, `${notifyPrefix}-session-failed`)
      return { kind: "abandoned" }
    }
    options.messages = session.messages
    logAgentSession(env, event.instanceId, session)
    if (!session.completed || !session.terminal) {
      await notify(env, step, event.payload.chatId, MEAL_AGENT_UNAVAILABLE, `${notifyPrefix}-session-failed`)
      return { kind: "abandoned" }
    }
    const terminal = session.terminal
    if (terminal.kind === "needs_clarification") {
      const reply = await promptForClarification(env, step, event, options.occurrence, turn, terminal.message)
      if (!reply) {
        await notify(
          env,
          step,
          event.payload.chatId,
          options.isRevision ? MEAL_FEEDBACK_NOT_APPLIED : MEAL_PLANNING_CANCELED,
          `${notifyPrefix}-clarification-timeout`,
        )
        return { kind: "abandoned" }
      }
      options.messages.push({ role: "user", text: reply })
      continue
    }
    if (terminal.kind === "update_week_context") return { kind: "week_context_updated", update: terminal.update }
    return { kind: "proposed", propose: terminal }
  }
  await notify(env, step, event.payload.chatId, MEAL_AGENT_UNAVAILABLE, `${notifyPrefix}-session-exhausted`)
  return { kind: "abandoned" }
}

/** Sends a force-reply clarification prompt and returns only the matching free-text reply (or null on timeout). */
async function promptForClarification(
  env: Env,
  step: WorkflowStep,
  event: WorkflowEvent<MealPlanningWorkflowParams>,
  occurrence: string,
  turn: number,
  message: string,
): Promise<string | null> {
  const chatId = event.payload.chatId
  // The interaction id is minted inside the cached send step and returned, so a
  // replayed workflow reuses the same id for registration and reply matching.
  const sent = await step.do(`meal-planning-clarify-notify-${occurrence}-${turn}`, async () => {
    const interactionId = crypto.randomUUID()
    const sentMessage = await createTelegramClient(env.TELEGRAM_BOT_TOKEN).sendMessage(chatId, message, {
      replyMarkup: { force_reply: true },
    })
    return { interactionId, messageId: sentMessage.messageId }
  })
  await step.do(`meal-planning-clarify-register-${occurrence}-${turn}`, async () => {
    const router = createInteractionRouter(env.INTERACTION_ROUTER, chatId)
    await router.register({
      interactionId: sent.interactionId,
      version: 0,
      workflowId: event.instanceId,
      kind: INTERACTION_KIND.MEAL_CLARIFICATION,
      botMessageId: sent.messageId,
      expiresAt: Date.now() + MEAL_CLARIFICATION_TTL_MS,
      interactionGroup: MEAL_PLANNING_GROUP,
    } satisfies InteractionRegistration)
  })
  const deadline = Date.now() + MEAL_CLARIFICATION_TTL_MS
  let attempt = 0
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return null
    const response = await step.waitForEvent<MealPlanningLiveEvent>(
      `meal-planning-clarify-wait-${occurrence}-${turn}-${attempt}`,
      {
        type: "telegram-reply",
        timeout: `${Math.max(1, Math.ceil(remaining / MILLISECONDS_PER_SECOND))} seconds` as never,
      },
    )
    if (response.type === "timeout") return null
    const payload = response.payload
    if (payload?.interactionId === sent.interactionId && payload.text) return payload.text
    // A foreign event for a different interaction: discard and keep waiting with the remaining time.
    attempt += 1
    logRuntime(env, {
      workflow: event.instanceId,
      event: "meal-planning-clarification-wait",
      outcome: "ignored",
      failureCategory: "foreign-interaction",
    })
  }
}

/** Builds the same-origin Mini App launch URL from its configured public HTTPS origin. */
export function miniAppLaunchUrl(origin: string | undefined): string | null {
  if (!origin?.trim()) return null
  try {
    const configured = new URL(origin)
    if (configured.protocol !== "https:" || configured.username || configured.password) return null
    return new URL("/mini-app", configured.origin).toString()
  } catch {
    return null
  }
}

/** Sends the rendered plan message with feedback and, when configured, Mini App review buttons. `occurrence` is a stable per-message key (`initial` or `revision-<live-loop-iteration>`). */
async function sendPlanAndRegister(
  env: Env,
  step: WorkflowStep,
  event: WorkflowEvent<MealPlanningWorkflowParams>,
  _profile: StoredMealProfile,
  plan: MealPlanRecord,
  version: MealPlanVersionRecord,
  generation: number,
  occurrence: string,
): Promise<void> {
  const chatId = event.payload.chatId
  const message = renderPlanLaunchMessage(plan)
  const reviewUrl = miniAppLaunchUrl(env.MINI_APP_ORIGIN)
  // The Mini App link is shown only after its server-owned private-chat scope
  // has been persisted. Its authorization is still rechecked from signed
  // Telegram initData at session creation; the button contains no identity.
  const miniAppUrl = await step.do(`meal-planning-register-mini-app-context-${occurrence}`, async () => {
    const telegramUserId = env.TELEGRAM_ALLOWED_USER_ID?.trim()
    if (!reviewUrl || !telegramUserId || !env.MEAL_PLANNING_DB) return null
    try {
      await createMealPlanningStore(env.MEAL_PLANNING_DB).upsertMiniAppReviewContext({
        telegramUserId,
        chatId,
        planId: plan.planId,
        weekEnd: plan.weekEnd,
      })
      return reviewUrl
    } catch {
      // Review is additive: never present a link that lacks its durable scope,
      // while retaining the established Telegram feedback path for this plan.
      logRuntime(env, {
        workflow: event.instanceId,
        event: "meal-planning-mini-app-context",
        outcome: "failed",
        failureCategory: "store-error",
      })
      return null
    }
  })
  // The callback token and interaction id are minted inside the cached send step
  // and returned, so a replayed workflow registers the credentials the parent
  // actually sees on the (cached) plan message instead of a fresh pair.
  const sent = await step.do(`meal-planning-send-plan-${occurrence}`, async () => {
    const callbackToken = crypto.randomUUID()
    const interactionId = crypto.randomUUID()
    const buttons: Array<Record<string, unknown>> = [{ text: "Give feedback", callback_data: callbackToken }]
    if (miniAppUrl) buttons.push({ text: "Review this week's plan", web_app: { url: miniAppUrl } })
    const sentMessage = await createTelegramClient(env.TELEGRAM_BOT_TOKEN).sendMessage(chatId, message, {
      replyMarkup: { inline_keyboard: [buttons] },
    })
    return { interactionId, callbackToken, messageId: sentMessage.messageId }
  })
  await step.do(`meal-planning-register-feedback-${occurrence}`, async () => {
    const router = createInteractionRouter(env.INTERACTION_ROUTER, chatId)
    await router.register({
      interactionId: sent.interactionId,
      version: version.version,
      workflowId: event.instanceId,
      kind: INTERACTION_KIND.MEAL_FEEDBACK,
      callbackToken: sent.callbackToken,
      botMessageId: sent.messageId,
      expiresAt: Date.parse(plan.weekEnd),
      interactionGroup: MEAL_PLANNING_GROUP,
      generation,
    } satisfies InteractionRegistration)
  })
}

/**
 * Parks the instance until `week_end` (or supersede): waits for `telegram-reply`
 * events in 24-h chunks (re-checking `week_end` each cycle), dispatching on the
 * payload's `interactionKind`. `meal-feedback` button taps open a 15-min
 * force-reply feedback prompt; `meal-feedback-reply` and
 * `meal-feedback-submission` events run a revision. A stale button tap sends
 * `meal-stale-plan`; unrecognized kinds are logged and re-waited.
 */
async function liveWeekLoop(
  env: Env,
  step: WorkflowStep,
  event: WorkflowEvent<MealPlanningWorkflowParams>,
  store: MealPlanningStore,
  profile: StoredMealProfile,
  plan: MealPlanRecord,
  planGeneration: number,
): Promise<void> {
  const chatId = event.payload.chatId
  const weekEndMs = Date.parse(plan.weekEnd)
  // Chat-scoped plan-message generation (§6): the current plan message's value,
  // bumped by every persistence batch and carried on every post-persist registration.
  let generation = planGeneration
  for (let iteration = 0; ; iteration++) {
    const remaining = weekEndMs - Date.now()
    if (remaining <= 0) return
    const timeoutSeconds = Math.max(
      1,
      Math.ceil(Math.min(remaining, MEAL_LIVE_WAIT_CHUNK_MS) / MILLISECONDS_PER_SECOND),
    )
    const response = await step.waitForEvent<MealPlanningLiveEvent>(`meal-planning-live-wait-${iteration}`, {
      type: "telegram-reply",
      timeout: `${timeoutSeconds} seconds` as never,
    })
    if (response.type === "timeout") continue
    const payload = response.payload
    const kind = payload?.interactionKind
    if (kind === INTERACTION_KIND.MEAL_FEEDBACK) {
      const active = await stepDo(step, `meal-planning-read-active-${iteration}`, () => store.activePlan(chatId))
      if (!active) continue
      if (payload.version !== undefined && payload.version < active.plan.currentVersion) {
        await notify(env, step, chatId, MEAL_STALE_PLAN, `meal-planning-notify-live-${iteration}-stale-plan`)
        continue
      }
      await promptForFeedbackReply(env, step, event, active.plan, generation, iteration)
      continue
    }
    if (kind === INTERACTION_KIND.MEAL_FEEDBACK_REPLY || kind === INTERACTION_KIND.MEAL_FEEDBACK_SUBMISSION) {
      let feedbackBatch: FeedbackBatchRecord | undefined
      if (payload?.source === "mini-app") {
        if (!payload.feedbackBatchId || !Number.isSafeInteger(payload.baseVersion)) continue
        const claimed = await stepDo(step, `meal-planning-claim-mini-app-batch-${iteration}`, () =>
          store.claimFeedbackBatchForWorkflow(
            payload.feedbackBatchId as string,
            event.instanceId,
            new Date().toISOString(),
          ),
        )
        if (!claimed) {
          await notifyMiniAppBatchTerminal(env, step, store, chatId, payload.feedbackBatchId, iteration)
          continue
        }
        feedbackBatch = claimed
      }
      const submission = feedbackBatch ? { items: feedbackBatch.items } : submissionFromPayload(payload)
      if (!submission) continue
      const active = await stepDo(step, `meal-planning-read-active-${iteration}`, () => store.activePlan(chatId))
      if (!active) continue
      try {
        const promotedGeneration = await runRevision(
          env,
          step,
          event,
          store,
          profile,
          active,
          submission,
          iteration,
          false,
          feedbackBatch,
        )
        if (promotedGeneration !== null) generation = promotedGeneration
      } catch {
        if (feedbackBatch) await failMiniAppBatch(env, step, store, chatId, feedbackBatch.batchId, iteration)
      }
      continue
    }
    logRuntime(env, {
      workflow: event.instanceId,
      event: "meal-planning-live-event",
      outcome: "ignored",
      failureCategory: "unrecognized-interaction-kind",
      details: { interactionKind: kind ?? "missing" },
    })
  }
}

async function notifyMiniAppBatchTerminal(
  env: Env,
  step: WorkflowStep,
  store: MealPlanningStore,
  chatId: string,
  batchId: string,
  iteration: number,
): Promise<void> {
  const batch = await stepDo(step, `meal-planning-read-mini-app-batch-${iteration}`, () => store.feedbackBatch(batchId))
  if (batch?.status !== "stale") return
  const claimed = await stepDo(step, `meal-planning-notify-mini-app-stale-claim-${iteration}`, () =>
    store.claimFeedbackBatchFailureNotification(batchId, new Date().toISOString()),
  )
  if (claimed) await notify(env, step, chatId, MEAL_STALE_PLAN, `meal-planning-notify-mini-app-stale-${iteration}`)
}

async function failMiniAppBatch(
  env: Env,
  step: WorkflowStep,
  store: MealPlanningStore,
  chatId: string,
  batchId: string,
  iteration: number,
): Promise<void> {
  await stepDo(step, `meal-planning-fail-mini-app-batch-${iteration}`, () =>
    store.markFeedbackBatchFailed(batchId, "workflow", new Date().toISOString()),
  )
  const claimed = await stepDo(step, `meal-planning-notify-mini-app-failure-claim-${iteration}`, () =>
    store.claimFeedbackBatchFailureNotification(batchId, new Date().toISOString()),
  )
  if (claimed)
    await notify(env, step, chatId, MEAL_FEEDBACK_NOT_APPLIED, `meal-planning-notify-mini-app-failure-${iteration}`)
}

/** Builds the canonical submission payload from a live-loop event, or null when it carries nothing. */
function submissionFromPayload(payload: MealPlanningLiveEvent | undefined): Submission | null {
  if (!payload) return null
  if (payload.items?.length) return { items: payload.items }
  if (!payload.text) return null
  const source = payload.source === "telegram-reply" ? "telegram-reply" : "telegram-text"
  return coerceSubmission(payload.text, source, payload.messageId ?? 0)
}

/** Runs one feedback-driven revision: session → no-change gate → CAS promotion → new plan message. Returns the new plan-message generation on success, null otherwise. */
async function runRevision(
  env: Env,
  step: WorkflowStep,
  event: WorkflowEvent<MealPlanningWorkflowParams>,
  store: MealPlanningStore,
  profile: StoredMealProfile,
  active: ActivePlanRecord,
  submission: Submission,
  iteration: number,
  contextAlreadyUpdated = false,
  feedbackBatch?: FeedbackBatchRecord,
): Promise<number | null> {
  const occurrence = `revision-${iteration}`
  const notifyPrefix = `meal-planning-notify-${occurrence}`
  // The calendar update itself is already persisted.  Its original message is
  // still useful context for the follow-up replan, but it must not become a
  // normal cell-scope requirement: the deterministic removal of a closed day
  // is the requested change.
  const feedbackItems = contextAlreadyUpdated ? [] : submission.items
  const revisionBaseCandidate = contextAlreadyUpdated
    ? withoutClosedDays(
        active.version.candidate,
        { ...active.plan, weeklyExceptions: active.plan.weeklyExceptions },
        profile,
      )
    : active.version.candidate
  const context: MealPlanContext = {
    schedule: profile.schedule,
    profile: profile.profile,
    customPolicies: profile.customPolicies,
    weeklyInventory: active.plan.weeklyInventory,
    weeklyExceptions: active.plan.weeklyExceptions,
    recentPlan: revisionBaseCandidate.grid,
    request: { kind: "revision", text: submission.items.map((item) => item.text).join(" ") },
    feedbackItems,
    provisionalMealDefinitions: active.version.provisionalMealDefinitions,
  }
  const messages: ToolConversationMessage[] = [
    {
      role: "user",
      text: `${renderPlanningTimeContext(new Date(), active.plan.timezone, active.plan.weekStart, active.plan.weekEnd)}\nRevision feedback:\n${renderRevisionFeedback(feedbackItems)}${contextAlreadyUpdated ? `\nWeek-context updates from this message are already applied. Carry out the requested replan: ${submission.items.map((item) => item.text).join(" ")}` : ""}\n\n${renderHouseholdContext(context)}`,
    },
  ]
  const outcome = await runPlanningSession(env, step, event, {
    context,
    messages,
    isRevision: true,
    revisionBaseCandidate,
    allowWeekContextUpdate: !contextAlreadyUpdated,
    occurrence,
  })
  if (outcome?.kind === "week_context_updated") {
    const updatedContext = outcome.update
    const persisted = await stepDo(step, `meal-planning-update-week-context-${occurrence}`, () =>
      store.updateWeeklyContext({
        planId: active.plan.planId,
        chatId: event.payload.chatId,
        baseVersion: active.plan.currentVersion,
        weeklyInventory: updatedContext.weeklyInventory,
        weeklyExceptions: updatedContext.weeklyExceptions,
      }),
    )
    if (!persisted.ok) {
      await notify(env, step, event.payload.chatId, MEAL_STALE_PLAN, `${notifyPrefix}-stale-context`)
      return null
    }
    if (!updatedContext.replan) {
      if (feedbackBatch)
        await stepDo(step, `meal-planning-consume-mini-app-batch-${occurrence}`, () =>
          store.markFeedbackBatchConsumed(feedbackBatch.batchId, new Date().toISOString()),
        )
      await notify(
        env,
        step,
        event.payload.chatId,
        "Updated this week's meal-planning context.",
        `${notifyPrefix}-context-updated`,
      )
      return null
    }
    return runRevision(
      env,
      step,
      event,
      store,
      profile,
      {
        ...active,
        plan: {
          ...active.plan,
          weeklyInventory: updatedContext.weeklyInventory,
          weeklyExceptions: updatedContext.weeklyExceptions,
        },
      },
      submission,
      iteration,
      true,
      feedbackBatch,
    )
  }
  if (outcome?.kind !== "proposed") {
    if (feedbackBatch) await failMiniAppBatch(env, step, store, event.payload.chatId, feedbackBatch.batchId, iteration)
    return null
  }
  const propose = outcome.propose
  // A replan that closes a school day is materially different from the active
  // version even when no remaining-day cell needs changing.
  if (
    isNoChangeCandidate(propose.candidate, contextAlreadyUpdated ? active.version.candidate : revisionBaseCandidate)
  ) {
    if (feedbackBatch)
      await stepDo(step, `meal-planning-consume-mini-app-batch-${occurrence}`, () =>
        store.markFeedbackBatchConsumed(feedbackBatch.batchId, new Date().toISOString()),
      )
    await notify(env, step, event.payload.chatId, MEAL_NO_CHANGES, `${notifyPrefix}-no-change`)
    return null
  }
  const enriched = await stepDo(step, `meal-planning-video-enrich-${occurrence}`, () =>
    enrichLunchVideos(env, propose.candidate),
  )
  const result = await stepDo(step, `meal-planning-promote-${occurrence}`, () =>
    store.promotePlanVersion({
      planId: active.plan.planId,
      chatId: event.payload.chatId,
      baseVersion: active.plan.currentVersion,
      candidate: enriched.candidate,
      video: enriched.video,
      evaluation: propose.evaluation,
      provisionalMealDefinitions: propose.provisionalMealDefinitions,
      inventory: {
        weeklyInventory: propose.weeklyInventory,
        weeklyExceptions: propose.weeklyExceptions,
      },
      feedbackBatch: {
        batchId: feedbackBatch?.batchId ?? `${active.plan.planId}:v${active.plan.currentVersion + 1}`,
        items: submission.items,
        consumeExisting: Boolean(feedbackBatch),
      },
    }),
  )
  if (!result.ok) {
    if (feedbackBatch) {
      await stepDo(step, `meal-planning-stale-mini-app-batch-${occurrence}`, () =>
        store.markFeedbackBatchStale(feedbackBatch.batchId, new Date().toISOString()),
      )
      await notifyMiniAppBatchTerminal(env, step, store, event.payload.chatId, feedbackBatch.batchId, iteration)
    }
    logRuntime(env, {
      workflow: event.instanceId,
      event: "meal-plan-promotion",
      outcome: "failed",
      failureCategory: result.reason,
    })
    await notify(env, step, event.payload.chatId, MEAL_STALE_PLAN, `${notifyPrefix}-stale-plan`)
    return null
  }
  const updated = await stepDo(step, `meal-planning-read-updated-${occurrence}`, () =>
    store.activePlan(event.payload.chatId),
  )
  if (!updated) return null
  await sendPlanAndRegister(env, step, event, profile, updated.plan, result.version, result.generation, occurrence)
  return result.generation
}

/** A newly closed school day is removed deterministically before a revision patch is merged. */
function withoutClosedDays(
  candidate: MealPlanCandidate,
  plan: MealPlanRecord,
  profile: StoredMealProfile,
): MealPlanCandidate {
  const closedDays = computeCoverageSet({
    schedule: profile.schedule,
    profile: profile.profile,
    customPolicies: profile.customPolicies,
    weeklyInventory: plan.weeklyInventory,
    weeklyExceptions: plan.weeklyExceptions,
    recentPlan: candidate.grid,
    request: { kind: "revision", text: "week context update" },
  }).closedDays
  return {
    ...candidate,
    grid: Object.fromEntries(Object.entries(candidate.grid).filter(([day]) => !closedDays.includes(day))),
  }
}

/** Sends the 15-min force-reply feedback prompt and registers the meal-feedback-reply interaction (live-loop iteration scopes the step names). */
async function promptForFeedbackReply(
  env: Env,
  step: WorkflowStep,
  event: WorkflowEvent<MealPlanningWorkflowParams>,
  plan: MealPlanRecord,
  generation: number,
  iteration: number,
): Promise<void> {
  const chatId = event.payload.chatId
  const sent = await step.do(`meal-planning-feedback-prompt-${iteration}`, () =>
    createTelegramClient(env.TELEGRAM_BOT_TOKEN).sendMessage(chatId, MEAL_OPEN_FEEDBACK_PROMPT, {
      replyMarkup: { force_reply: true },
    }),
  )
  await step.do(`meal-planning-register-feedback-reply-${iteration}`, async () => {
    const router = createInteractionRouter(env.INTERACTION_ROUTER, chatId)
    await router.register({
      interactionId: crypto.randomUUID(),
      version: plan.currentVersion,
      workflowId: event.instanceId,
      kind: INTERACTION_KIND.MEAL_FEEDBACK_REPLY,
      botMessageId: sent.messageId,
      expiresAt: Date.now() + MEAL_FEEDBACK_REPLY_TTL_MS,
      interactionGroup: MEAL_PLANNING_GROUP,
      generation,
    } satisfies InteractionRegistration)
  })
}

/** True when a submitted revision candidate changes no grid cell and no easy buy versus the base version. */
function isNoChangeCandidate(submitted: MealPlanCandidate, base: MealPlanCandidate): boolean {
  if (
    submitted.easyBuys.length !== base.easyBuys.length ||
    submitted.easyBuys.some((dish, index) => dish !== base.easyBuys[index])
  )
    return false
  const baseDays = Object.keys(base.grid)
  const submittedDays = Object.keys(submitted.grid)
  if (baseDays.length !== submittedDays.length || baseDays.some((day, index) => day !== submittedDays[index]))
    return false
  for (const day of baseDays) {
    const baseSlots = base.grid[day] ?? {}
    const submittedSlots = submitted.grid[day] ?? {}
    const baseSlotIds = Object.keys(baseSlots)
    const submittedSlotIds = Object.keys(submittedSlots)
    if (
      baseSlotIds.length !== submittedSlotIds.length ||
      baseSlotIds.some((slotId, index) => slotId !== submittedSlotIds[index])
    )
      return false
    for (const slotId of baseSlotIds) {
      const left = baseSlots[slotId]
      const right = submittedSlots[slotId]
      if (!left || !right) return false
      if (
        left.dish !== right.dish ||
        left.vegetarian !== right.vegetarian ||
        left.cookMinutes !== right.cookMinutes ||
        left.priorNightPrep !== right.priorNightPrep ||
        left.items.length !== right.items.length ||
        left.items.some((item, index) => item !== right.items[index])
      )
        return false
    }
  }
  return true
}

function transcriptEnabled(env: Env): boolean {
  return env.LLM_DEBUG_TRANSCRIPT?.trim().toLowerCase() === "true" && env.DEPLOYMENT_ENV === "development"
}

function logAgentTurnStart(
  env: Env,
  workflow: string,
  turn: number,
  messages: readonly ToolConversationMessage[],
): void {
  logRuntime(env, {
    workflow,
    event: "meal-planning-agent-turn",
    outcome: "started",
    metrics: { turn, messageCount: messages.length },
  })
}

function logAgentTurn(
  env: Env,
  workflow: string,
  turn: number,
  messages: readonly ToolConversationMessage[],
  durationMs: number,
): void {
  logRuntime(env, {
    workflow,
    event: "meal-planning-agent-turn",
    outcome: "succeeded",
    durationMs,
    metrics: { turn, messageCount: messages.length },
  })
  if (!transcriptEnabled(env)) return
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      component: "kipp-runtime",
      workflow,
      event: "meal-planning-agent-transcript",
      outcome: "turn-completed",
      details: { warning: "development diagnostic; may contain household data", turn },
      transcript: serializeTranscript(messages),
    }),
  )
}

function logAgentTurnFailure(env: Env, workflow: string, turn: number, durationMs: number, error: unknown): void {
  logRuntime(env, {
    workflow,
    event: "meal-planning-agent-turn",
    outcome: "failed",
    durationMs,
    failureCategory: error instanceof Error ? error.name : "provider-error",
    metrics: { turn },
  })
}

function logProviderRequestEvent(env: Env, workflow: string, requestEvent: ToolProviderRequestEvent): void {
  logRuntime(env, {
    workflow,
    event: "meal-planning-provider-request",
    outcome: requestEvent.phase === "failed" ? "failed" : requestEvent.phase === "parsed" ? "succeeded" : "started",
    durationMs: requestEvent.durationMs,
    ...(requestEvent.failureCategory ? { failureCategory: requestEvent.failureCategory } : {}),
    ...(requestEvent.status === undefined
      ? {}
      : { details: { phase: requestEvent.phase, status: requestEvent.status } }),
    metrics: {
      ...(requestEvent.toolCallCount === undefined ? {} : { toolCallCount: requestEvent.toolCallCount }),
      ...(requestEvent.inputTokens === undefined ? {} : { inputTokens: requestEvent.inputTokens }),
      ...(requestEvent.outputTokens === undefined ? {} : { outputTokens: requestEvent.outputTokens }),
      ...(requestEvent.reasoningTokens === undefined ? {} : { reasoningTokens: requestEvent.reasoningTokens }),
      ...(requestEvent.messageCharacters === undefined ? {} : { messageCharacters: requestEvent.messageCharacters }),
      ...(requestEvent.toolSchemaCharacters === undefined
        ? {}
        : { toolSchemaCharacters: requestEvent.toolSchemaCharacters }),
      ...(requestEvent.requestBodyCharacters === undefined
        ? {}
        : { requestBodyCharacters: requestEvent.requestBodyCharacters }),
    },
  })
}

function serializeTranscript(messages: readonly ToolConversationMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === "assistant" && "toolCalls" in message)
      return {
        role: message.role,
        text: message.text?.slice(0, TRANSCRIPT_TEXT_MAX_CHARACTERS),
        toolCalls: message.toolCalls.map((call) => ({ id: call.id, name: call.name, input: call.input })),
      }
    if (message.role === "tool")
      return { role: message.role, toolCallId: message.toolCallId, name: message.name, output: message.output }
    return { role: message.role, text: message.text.slice(0, TRANSCRIPT_TEXT_MAX_CHARACTERS) }
  })
}

/** Emits per-tool and per-session runtime metadata for one bounded planning session. */
function logAgentSession(env: Env, workflow: string, session: MealPlanningAgentSessionResult): void {
  for (const execution of session.toolExecutions)
    logRuntime(env, {
      workflow,
      event: "meal-planning-agent-tool",
      tool: execution.tool,
      outcome: execution.outcome,
      failureCategory: execution.failureCategory,
      ...(execution.validationPaths?.length
        ? { details: { validationPaths: execution.validationPaths.join(",") } }
        : {}),
    })
  logRuntime(env, {
    workflow,
    event: "meal-planning-agent-session",
    outcome: session.completed ? "succeeded" : "failed",
    failureCategory: session.failureReason,
    metrics: { providerTurns: session.providerTurns, toolCallCount: session.toolCallCount },
  })
  // Conversation bodies can contain household data, so transcript logging is
  // an explicit development-only diagnostic. Reasoning content is omitted.
  if (transcriptEnabled(env)) {
    const transcript = serializeTranscript(session.messages)
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        component: "kipp-runtime",
        workflow,
        event: "meal-planning-agent-transcript",
        outcome: session.completed ? "succeeded" : "failed",
        details: { warning: "development diagnostic; may contain household data" },
        transcript,
      }),
    )
  }
}

/** Sends one deterministic workflow notification through a durable step named by its stable workflow context, so each notification is its own cached step. */
async function notify(env: Env, step: WorkflowStep, chatId: string, message: string, stepName: string): Promise<void> {
  await step.do(stepName, () => createTelegramClient(env.TELEGRAM_BOT_TOKEN).sendMessage(chatId, message))
}
