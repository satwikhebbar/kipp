import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers"
import {
  type MealPlanningAgentSessionResult,
  type MealPlanningTerminalOutcome,
  runMealPlanningAgentSession,
} from "../agent/meal-planning-session"
import { createInteractionRouter, type InteractionRegistration } from "../core/interaction-router-client"
import { type Env, INTERACTION_KIND, type WorkflowInteractionKind } from "../core/types"
import { createTelegramClient } from "../integrations/telegram"
import { createToolProvider, type ToolConversationMessage } from "../providers"
import { logRuntime } from "../runtime/logging"
import {
  MEAL_AGENT_UNAVAILABLE,
  MEAL_FEEDBACK_NOT_APPLIED,
  MEAL_NO_CHANGES,
  MEAL_OPEN_FEEDBACK_PROMPT,
  MEAL_PLANNING_CANCELED,
  MEAL_STALE_PLAN,
  renderPlanMessage,
} from "./messages"
import {
  type ActivePlanRecord,
  createMealPlanningStore,
  type MealPlanningStore,
  type MealPlanRecord,
  type MealPlanVersionRecord,
  type StoredMealProfile,
} from "./store"
import { coerceSubmission, type Submission } from "./submissions"
import type { MealPlanCandidate, MealPlanContext } from "./types"
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

export interface MealPlanningLiveEvent {
  interactionKind?: WorkflowInteractionKind
  source?: "telegram-text" | "telegram-reply" | "mini-app"
  text?: string
  messageId?: number
  interactionId?: string
  version?: number
  /** Structured per-cell submissions delivered by the iteration-2 mini-app. */
  items?: Array<{ id: string; text: string; scope?: { day?: string; slot?: string } }>
}

type PlanningOutcome =
  | { kind: "proposed"; propose: Extract<MealPlanningTerminalOutcome, { kind: "propose_plan" }> }
  | { kind: "abandoned" }

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

  const context: MealPlanContext = {
    schedule: profile.schedule,
    profile: profile.profile,
    customPolicies: profile.customPolicies,
    weeklyInventory: recent?.plan.weeklyInventory ?? { items: [], notes: [] },
    weeklyExceptions: recent?.plan.weeklyExceptions ?? { items: [] },
    recentPlan: recent?.version.candidate.grid ?? null,
    request: { kind: "initial_plan", text: event.payload.requestText },
  }
  const messages: ToolConversationMessage[] = [
    {
      role: "user",
      text: `Current instant: ${new Date().toISOString()}\nTime zone: ${timezone}\nRequest: ${event.payload.requestText || "/mealplan"}`,
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
  options: { context: MealPlanContext; messages: ToolConversationMessage[]; isRevision: boolean; occurrence: string },
): Promise<PlanningOutcome | null> {
  const notifyPrefix = `meal-planning-notify-${options.occurrence}`
  const sessionDeadline = Date.now() + MEAL_PLANNING_TTL_MS
  for (let turn = 0; turn < MEAL_MAX_SESSION_TURNS; turn++) {
    if (Date.now() > sessionDeadline) {
      await notify(env, step, event.payload.chatId, MEAL_AGENT_UNAVAILABLE, `${notifyPrefix}-session-deadline`)
      return { kind: "abandoned" }
    }
    const session = await stepDo(step, `meal-planning-agent-session-${options.occurrence}-${turn}`, async () => {
      const provider = createToolProvider(
        env.LLM_API_KEY,
        env.LLM_PROVIDER,
        env.LLM_MODEL,
        Number(env.LLM_MAX_RETRIES || "3"),
      )
      return runMealPlanningAgentSession(provider, options.messages, { context: options.context })
    })
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

/** Sends the rendered plan message with a [Give feedback] button and registers the meal-feedback interaction. `occurrence` is a stable per-message key (`initial` or `revision-<live-loop-iteration>`). */
async function sendPlanAndRegister(
  env: Env,
  step: WorkflowStep,
  event: WorkflowEvent<MealPlanningWorkflowParams>,
  profile: StoredMealProfile,
  plan: MealPlanRecord,
  version: MealPlanVersionRecord,
  generation: number,
  occurrence: string,
): Promise<void> {
  const chatId = event.payload.chatId
  const message = renderPlanMessage(plan, version, profile.schedule, profile.customPolicies)
  // The callback token and interaction id are minted inside the cached send step
  // and returned, so a replayed workflow registers the credentials the parent
  // actually sees on the (cached) plan message instead of a fresh pair.
  const sent = await step.do(`meal-planning-send-plan-${occurrence}`, async () => {
    const callbackToken = crypto.randomUUID()
    const interactionId = crypto.randomUUID()
    const sentMessage = await createTelegramClient(env.TELEGRAM_BOT_TOKEN).sendMessage(chatId, message, {
      replyMarkup: { inline_keyboard: [[{ text: "Give feedback", callback_data: callbackToken }]] },
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
      const submission = submissionFromPayload(payload)
      if (!submission) continue
      const active = await stepDo(step, `meal-planning-read-active-${iteration}`, () => store.activePlan(chatId))
      if (!active) continue
      const promotedGeneration = await runRevision(env, step, event, store, profile, active, submission, iteration)
      if (promotedGeneration !== null) generation = promotedGeneration
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
): Promise<number | null> {
  const occurrence = `revision-${iteration}`
  const notifyPrefix = `meal-planning-notify-${occurrence}`
  const context: MealPlanContext = {
    schedule: profile.schedule,
    profile: profile.profile,
    customPolicies: profile.customPolicies,
    weeklyInventory: active.plan.weeklyInventory,
    weeklyExceptions: active.plan.weeklyExceptions,
    recentPlan: active.version.candidate.grid,
    request: { kind: "revision", text: submission.items.map((item) => item.text).join(" ") },
    feedbackItems: submission.items,
  }
  const messages: ToolConversationMessage[] = [
    {
      role: "user",
      text: `Current instant: ${new Date().toISOString()}\nTime zone: ${active.plan.timezone}\nRevision feedback: ${submission.items.map((item) => item.text).join(" ")}`,
    },
  ]
  const outcome = await runPlanningSession(env, step, event, { context, messages, isRevision: true, occurrence })
  if (outcome?.kind !== "proposed") return null
  const propose = outcome.propose
  if (isNoChangeCandidate(propose.candidate, active.version.candidate)) {
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
      inventory: {
        weeklyInventory: propose.weeklyInventory,
        weeklyExceptions: propose.weeklyExceptions,
      },
      feedbackBatch: {
        batchId: `${active.plan.planId}:v${active.plan.currentVersion + 1}`,
        items: submission.items,
      },
    }),
  )
  if (!result.ok) {
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
}

/** Sends one deterministic workflow notification through a durable step named by its stable workflow context, so each notification is its own cached step. */
async function notify(env: Env, step: WorkflowStep, chatId: string, message: string, stepName: string): Promise<void> {
  await step.do(stepName, () => createTelegramClient(env.TELEGRAM_BOT_TOKEN).sendMessage(chatId, message))
}
