import { Hono } from "hono"
import type { Env } from "../core/types"
import { INTERACTION_KIND } from "../core/types"
import { createTelegramClient, TELEGRAM_NOTIFY_TIMEOUT_MS } from "../integrations/telegram"
import { HTTP_STATUS } from "../runtime/http"
import { logRuntime } from "../runtime/logging"
import { MINI_APP_SHELL } from "./mini-app/client"
import { authenticateMiniApp, MiniAppAuthError, readMiniAppSession } from "./mini-app-auth"
import { createMealPlanningStore, type FeedbackBatchRecord, type MealPlanningStore } from "./store"

const BYTES_PER_KIBIBYTE = 1_024
const MAX_REQUEST_KIBIBYTES = 64
const MAX_REQUEST_BYTES = MAX_REQUEST_KIBIBYTES * BYTES_PER_KIBIBYTE
const MAX_IDEMPOTENCY_KEY_LENGTH = 128
const MAX_ERROR_NAME_LENGTH = 120
const MAX_ERROR_MESSAGE_LENGTH = 240
const HTTP_ACCEPTED = 202
const HTTP_CREATED = 201

export { MINI_APP_SHELL } from "./mini-app/client"

type MiniAppContext = { store: MealPlanningStore; session: Awaited<ReturnType<typeof readMiniAppSession>> }
type MealPlanRead = NonNullable<Awaited<ReturnType<MealPlanningStore["activePlan"]>>>

/** No store headers. */
function noStoreHeaders(): Headers {
  return new Headers({ "Cache-Control": "no-store", Pragma: "no-cache" })
}

/** Json response. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers({
      ...Object.fromEntries(noStoreHeaders()),
      "Content-Type": "application/json; charset=utf-8",
    }),
  })
}

/** Request too large. */
function requestTooLarge(request: Request): boolean {
  const length = request.headers.get("content-length")
  return length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES)
}

/** Reads request text without trusting Content-Length (chunked bodies have none). */
async function readBoundedText(request: Request): Promise<string | null> {
  if (requestTooLarge(request)) return null
  const reader = request.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > MAX_REQUEST_BYTES) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/** Get context. */
async function getContext(request: Request, env: Env): Promise<MiniAppContext> {
  if (!env.MEAL_PLANNING_DB) throw new MiniAppAuthError("unavailable")
  const session = await readMiniAppSession(request.headers.get("authorization") ?? undefined, env)
  return { store: createMealPlanningStore(env.MEAL_PLANNING_DB), session }
}

/** Plan DTO. */
function planDto(
  active: MealPlanRead,
  schedule: Awaited<ReturnType<MealPlanningStore["loadOrCreateProfile"]>>["schedule"],
  readOnly: boolean,
) {
  // Older saved plans may predate a recurring schedule rule. Show the half-day
  // marker only when that plan actually has the reduced set of meals.
  const applicableHalfDays = schedule.halfDays?.filter((day) => {
    const cells = active.version.candidate.grid[day]
    return !cells?.snack2 && !cells?.["school-lunch"]
  })
  return {
    planId: active.plan.planId,
    version: active.version.version,
    weekStart: active.plan.weekStart,
    weekEnd: active.plan.weekEnd,
    timezone: active.plan.timezone,
    readOnly,
    schedule: { ...schedule, halfDays: applicableHalfDays },
    candidate: active.version.candidate,
    weeklyInventory: active.plan.weeklyInventory,
    weeklyExceptions: active.plan.weeklyExceptions,
    video: active.version.video,
    provisionalMealDefinitions: active.version.provisionalMealDefinitions,
  }
}

/** History entry DTO. */
function historyEntry(active: MealPlanRead, readOnly: boolean) {
  return {
    planId: active.plan.planId,
    version: active.version.version,
    weekStart: active.plan.weekStart,
    weekEnd: active.plan.weekEnd,
    lifecycle: active.plan.status === "active" ? "current" : "historical",
    readOnly,
  }
}

/** History-aware authenticated Mini App response. */
async function readPlanDto(
  request: Request,
  store: MealPlanningStore,
  session: Awaited<ReturnType<typeof readMiniAppSession>>,
) {
  const profile = await store.loadOrCreateProfile(session.chatId)
  const history = await store.listPlanHistory(session.chatId)
  const generation = await store.activePlanGeneration(session.chatId)
  const requestedPlanId = new URL(request.url).searchParams.get("planId")?.trim() || session.planId
  const selected = await store.planById(session.chatId, requestedPlanId)
  const active = history.find((entry) => entry.plan.status === "active") ?? null
  const historyDto = history.map((entry) => historyEntry(entry, entry.plan.status !== "active" || generation !== null))
  if (!selected) {
    if (generation) return { status: "generating" as const, currentPlan: null, history: historyDto }
    return { status: "empty" as const }
  }
  if (selected.plan.status !== "active") {
    return {
      status: "historical" as const,
      plan: planDto(selected, profile.schedule, true),
      history: historyDto,
    }
  }
  if (generation) {
    return {
      status: "generating" as const,
      currentPlan: planDto(selected, profile.schedule, true),
      history: historyDto,
    }
  }
  return {
    status: "current" as const,
    plan: planDto(active ?? selected, profile.schedule, false),
    history: historyDto,
  }
}

/** Error response. */
function errorResponse(error: unknown): Response {
  if (error instanceof MiniAppAuthError) return jsonResponse({ error: "unauthorized" }, error.status)
  return jsonResponse({ error: "unavailable" }, HTTP_STATUS.SERVICE_UNAVAILABLE)
}

/** Dispatches an accepted batch to the server-owned workflow pointer. */
export async function startFeedbackBatch(batch: FeedbackBatchRecord, env: Env): Promise<boolean> {
  const store = env.MEAL_PLANNING_DB ? createMealPlanningStore(env.MEAL_PLANNING_DB) : null
  let phase = "validate"
  logRuntime(env, {
    workflow: batch.workflowInstanceId ?? undefined,
    event: "mini-app-feedback-dispatch",
    outcome: "started",
    details: { phase, batchId: batch.batchId, planId: batch.planId, status: batch.status },
  })
  if (!store || !env.MEAL_PLANNING_WORKFLOW || !batch.workflowInstanceId) {
    if (store) await failFeedbackBatchDispatch(batch, env, store)
    logRuntime(env, {
      workflow: batch.workflowInstanceId ?? undefined,
      event: "mini-app-feedback-dispatch",
      outcome: "failed",
      failureCategory: "dispatch-not-configured",
      details: {
        phase,
        batchId: batch.batchId,
        hasDatabase: Boolean(store),
        hasWorkflowBinding: Boolean(env.MEAL_PLANNING_WORKFLOW),
        hasWorkflowInstanceId: Boolean(batch.workflowInstanceId),
      },
    })
    return false
  }
  // The Workflow claims only delivered batches. Persist the transition before
  // the event is visible so a fast Workflow cannot observe an accepted batch.
  phase = "claim-delivery"
  if (!store || !(await store.markFeedbackBatchDelivered(batch.batchId))) {
    logRuntime(env, {
      workflow: batch.workflowInstanceId,
      event: "mini-app-feedback-dispatch",
      outcome: "failed",
      failureCategory: "batch-not-accepted",
      details: { phase, batchId: batch.batchId },
    })
    return false
  }
  try {
    phase = "workflow-get"
    const instance = await env.MEAL_PLANNING_WORKFLOW.get(batch.workflowInstanceId)
    phase = "workflow-send-event"
    await instance.sendEvent({
      type: "telegram-reply",
      payload: {
        userId: Number(env.TELEGRAM_ALLOWED_USER_ID),
        text: "__mini_app_feedback__",
        interactionKind: INTERACTION_KIND.MEAL_FEEDBACK_SUBMISSION,
        source: "mini-app",
        feedbackBatchId: batch.batchId,
        baseVersion: batch.baseVersion,
        items: batch.items,
      },
    })
    logRuntime(env, {
      workflow: batch.workflowInstanceId,
      event: "mini-app-feedback-dispatch",
      outcome: "succeeded",
      details: { phase, batchId: batch.batchId },
    })
    return true
  } catch (error) {
    await failFeedbackBatchDispatch(batch, env, store)
    const errorName = error instanceof Error ? error.name : typeof error
    const errorMessage = error instanceof Error ? error.message : String(error)
    logRuntime(env, {
      workflow: batch.workflowInstanceId ?? undefined,
      event: "mini-app-feedback-dispatch",
      outcome: "failed",
      failureCategory: "workflow-unreachable",
      details: {
        phase,
        batchId: batch.batchId,
        errorName: errorName.slice(0, MAX_ERROR_NAME_LENGTH),
        errorMessage: errorMessage.replace(/\s+/g, " ").slice(0, MAX_ERROR_MESSAGE_LENGTH),
      },
    })
    return false
  }
}

/** Fail feedback batch dispatch. */
async function failFeedbackBatchDispatch(
  batch: FeedbackBatchRecord,
  env: Env,
  store: MealPlanningStore,
): Promise<void> {
  const now = new Date().toISOString()
  await store.markFeedbackBatchFailed(batch.batchId, "dispatch", now).catch(() => false)
  if (batch.chatId && (await store.claimFeedbackBatchFailureNotification(batch.batchId, now))) {
    await createTelegramClient(env.TELEGRAM_BOT_TOKEN)
      .sendMessage(batch.chatId, "Your feedback was received but could not be sent for processing. Please try again.", {
        signal: AbortSignal.timeout(TELEGRAM_NOTIFY_TIMEOUT_MS),
      })
      .catch(() => {})
  }
}

export const miniAppRoutes = new Hono<{ Bindings: Env }>()

miniAppRoutes.get(
  "/mini-app",
  (_c) =>
    new Response(MINI_APP_SHELL, {
      headers: new Headers({
        ...Object.fromEntries(noStoreHeaders()),
        "Content-Type": "text/html; charset=utf-8",
      }),
    }),
)

miniAppRoutes.post("/mini-app/api/session", async (c) => {
  try {
    if (c.req.header("content-type")?.split(";", 1)[0] !== "text/plain") {
      return jsonResponse({ error: "invalid_request" }, HTTP_STATUS.BAD_REQUEST)
    }
    const raw = await readBoundedText(c.req.raw)
    if (raw === null) return jsonResponse({ error: "invalid_request" }, HTTP_STATUS.BAD_REQUEST)
    const result = await authenticateMiniApp(raw, c.env)
    return jsonResponse({ token: result.token, expiresAt: result.session.expiresAt }, HTTP_CREATED)
  } catch (error) {
    return errorResponse(error)
  }
})

miniAppRoutes.get("/mini-app/api/plan", async (c) => {
  try {
    const { store, session } = await getContext(c.req.raw, c.env)
    return jsonResponse(await readPlanDto(c.req.raw, store, session))
  } catch (error) {
    return errorResponse(error)
  }
})

miniAppRoutes.post("/mini-app/api/feedback", async (c) => {
  try {
    if (c.req.header("content-type")?.split(";", 1)[0] !== "application/json") {
      return jsonResponse({ error: "invalid_request" }, HTTP_STATUS.BAD_REQUEST)
    }
    const { store, session } = await getContext(c.req.raw, c.env)
    let body: Record<string, unknown>
    try {
      const raw = await readBoundedText(c.req.raw)
      if (raw === null) return jsonResponse({ error: "invalid_request" }, HTTP_STATUS.BAD_REQUEST)
      body = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return jsonResponse({ error: "invalid_request" }, HTTP_STATUS.BAD_REQUEST)
    }
    if (!body || typeof body !== "object") return jsonResponse({ error: "invalid_request" }, HTTP_STATUS.BAD_REQUEST)
    const planId = typeof body.planId === "string" ? body.planId : ""
    const baseVersion = typeof body.baseVersion === "number" ? body.baseVersion : NaN
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : ""
    if (
      !planId ||
      !Number.isSafeInteger(baseVersion) ||
      !idempotencyKey ||
      idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
    ) {
      return jsonResponse({ error: "invalid_request" }, HTTP_STATUS.BAD_REQUEST)
    }
    if (planId !== session.planId) return jsonResponse({ error: "historical_or_stale" }, HTTP_STATUS.CONFLICT)
    const active = await store.activePlan(session.chatId)
    if (!active || active.plan.planId !== planId)
      return jsonResponse({ error: "historical_or_stale" }, HTTP_STATUS.CONFLICT)
    const accepted = await store.acceptFeedbackBatch({
      batchId: crypto.randomUUID(),
      planId,
      chatId: session.chatId,
      baseVersion,
      workflowInstanceId: active.plan.instanceId,
      idempotencyKey,
      items: body.items,
    })
    if (!accepted.ok) {
      return jsonResponse(
        { error: accepted.reason === "invalid_items" ? "invalid_items" : accepted.reason },
        accepted.reason === "stale" || accepted.reason === "generating"
          ? HTTP_STATUS.CONFLICT
          : HTTP_STATUS.BAD_REQUEST,
      )
    }
    if (accepted.duplicate) {
      const status = accepted.batch.status
      if (status === "consumed")
        return jsonResponse({ status: "submitted", batchId: accepted.batch.batchId }, HTTP_ACCEPTED)
      if (status === "accepted" || status === "delivered" || status === "processing")
        return jsonResponse({ status: "pending", batchId: accepted.batch.batchId }, HTTP_ACCEPTED)
      if (status === "stale")
        return jsonResponse({ status: "stale", batchId: accepted.batch.batchId }, HTTP_STATUS.CONFLICT)
      return jsonResponse({ status: "failed", batchId: accepted.batch.batchId }, HTTP_STATUS.SERVICE_UNAVAILABLE)
    }
    const dispatched = await startFeedbackBatch(accepted.batch, c.env)
    if (!dispatched)
      return jsonResponse({ status: "failed", batchId: accepted.batch.batchId }, HTTP_STATUS.SERVICE_UNAVAILABLE)
    return jsonResponse({ status: "accepted", batchId: accepted.batch.batchId }, HTTP_ACCEPTED)
  } catch (error) {
    return errorResponse(error)
  }
})
