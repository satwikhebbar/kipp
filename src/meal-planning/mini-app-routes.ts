import { Hono } from "hono"
import type { Env } from "../core/types"
import { INTERACTION_KIND } from "../core/types"
import { createTelegramClient, TELEGRAM_NOTIFY_TIMEOUT_MS } from "../integrations/telegram"
import { HTTP_STATUS } from "../runtime/http"
import { logRuntime } from "../runtime/logging"
import { authenticateMiniApp, MiniAppAuthError, readMiniAppSession } from "./mini-app-auth"
import { createMealPlanningStore, type FeedbackBatchRecord, type MealPlanningStore } from "./store"
import { resolvePlanningWeek } from "./week"

const BYTES_PER_KIBIBYTE = 1_024
const MAX_REQUEST_KIBIBYTES = 64
const MAX_REQUEST_BYTES = MAX_REQUEST_KIBIBYTES * BYTES_PER_KIBIBYTE
const MAX_IDEMPOTENCY_KEY_LENGTH = 128
const HTTP_ACCEPTED = 202
const HTTP_CREATED = 201

export const MINI_APP_SHELL = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kipp meal plan</title></head><body><main><h1>Kipp meal plan</h1>
<p>Open this page from Telegram to review an authenticated meal plan.</p></main></body></html>`

type MiniAppContext = { store: MealPlanningStore; session: Awaited<ReturnType<typeof readMiniAppSession>> }

function noStoreHeaders(): Headers {
  return new Headers({ "Cache-Control": "no-store", Pragma: "no-cache" })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers({
      ...Object.fromEntries(noStoreHeaders()),
      "Content-Type": "application/json; charset=utf-8",
    }),
  })
}

function requestTooLarge(request: Request): boolean {
  const length = request.headers.get("content-length")
  return length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES)
}

async function getContext(request: Request, env: Env): Promise<MiniAppContext> {
  if (!env.MEAL_PLANNING_DB) throw new MiniAppAuthError("unavailable")
  const session = await readMiniAppSession(request.headers.get("authorization") ?? undefined, env)
  return { store: createMealPlanningStore(env.MEAL_PLANNING_DB), session }
}

function readyDto(
  active: NonNullable<Awaited<ReturnType<MealPlanningStore["activePlan"]>>>,
  schedule: Awaited<ReturnType<MealPlanningStore["loadOrCreateProfile"]>>["schedule"],
) {
  return {
    status: "ready" as const,
    plan: {
      planId: active.plan.planId,
      version: active.version.version,
      weekStart: active.plan.weekStart,
      weekEnd: active.plan.weekEnd,
      timezone: active.plan.timezone,
      schedule,
      candidate: active.version.candidate,
      weeklyInventory: active.plan.weeklyInventory,
      weeklyExceptions: active.plan.weeklyExceptions,
      video: active.version.video,
      provisionalMealDefinitions: active.version.provisionalMealDefinitions,
    },
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof MiniAppAuthError) return jsonResponse({ error: "unauthorized" }, error.status)
  return jsonResponse({ error: "unavailable" }, HTTP_STATUS.SERVICE_UNAVAILABLE)
}

/** Dispatches an accepted batch to the server-owned workflow pointer. */
export async function startFeedbackBatch(batch: FeedbackBatchRecord, env: Env): Promise<boolean> {
  if (!env.MEAL_PLANNING_WORKFLOW || !batch.workflowInstanceId) return false
  const store = env.MEAL_PLANNING_DB ? createMealPlanningStore(env.MEAL_PLANNING_DB) : null
  // The Workflow claims only delivered batches. Persist the transition before
  // the event is visible so a fast Workflow cannot observe an accepted batch.
  if (!store || !(await store.markFeedbackBatchDelivered(batch.batchId))) return false
  try {
    const instance = await env.MEAL_PLANNING_WORKFLOW.get(batch.workflowInstanceId)
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
    return true
  } catch {
    const now = new Date().toISOString()
    await store.markFeedbackBatchFailed(batch.batchId, "dispatch", now).catch(() => false)
    if (batch.chatId && (await store.claimFeedbackBatchFailureNotification(batch.batchId, now))) {
      await createTelegramClient(env.TELEGRAM_BOT_TOKEN)
        .sendMessage(
          batch.chatId,
          "Your feedback was received but could not be sent for processing. Please try again.",
          {
            signal: AbortSignal.timeout(TELEGRAM_NOTIFY_TIMEOUT_MS),
          },
        )
        .catch(() => {})
    }
    logRuntime(env, {
      workflow: batch.workflowInstanceId ?? undefined,
      event: "mini-app-feedback-dispatch",
      outcome: "failed",
      failureCategory: "workflow-unreachable",
    })
    return false
  }
}

export const miniAppRoutes = new Hono<{ Bindings: Env }>()

miniAppRoutes.get("/mini-app", (_c) => new Response(MINI_APP_SHELL, { headers: noStoreHeaders() }))

miniAppRoutes.post("/mini-app/api/session", async (c) => {
  try {
    if (requestTooLarge(c.req.raw) || c.req.header("content-type")?.split(";", 1)[0] !== "text/plain") {
      return jsonResponse({ error: "invalid_request" }, HTTP_STATUS.BAD_REQUEST)
    }
    const raw = await c.req.text()
    const result = await authenticateMiniApp(raw, c.env)
    return jsonResponse({ token: result.token, expiresAt: result.session.expiresAt }, HTTP_CREATED)
  } catch (error) {
    return errorResponse(error)
  }
})

miniAppRoutes.get("/mini-app/api/plan", async (c) => {
  try {
    const { store, session } = await getContext(c.req.raw, c.env)
    const active = await store.activePlan(session.chatId)
    const profile = await store.loadOrCreateProfile(session.chatId)
    const currentWeek = resolvePlanningWeek(Date.now(), active?.plan.timezone ?? "Asia/Kolkata")
    if (!active || active.plan.planId !== session.planId || active.plan.weekStart !== currentWeek.weekStart) {
      return jsonResponse({ status: "empty", weekStart: currentWeek.weekStart, weekEnd: currentWeek.weekEnd })
    }
    return jsonResponse(readyDto(active, profile.schedule))
  } catch (error) {
    return errorResponse(error)
  }
})

miniAppRoutes.post("/mini-app/api/feedback", async (c) => {
  try {
    if (requestTooLarge(c.req.raw) || c.req.header("content-type")?.split(";", 1)[0] !== "application/json") {
      return jsonResponse({ error: "invalid_request" }, HTTP_STATUS.BAD_REQUEST)
    }
    const { store, session } = await getContext(c.req.raw, c.env)
    let body: Record<string, unknown>
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      return jsonResponse({ error: "invalid_request" }, HTTP_STATUS.BAD_REQUEST)
    }
    if (!body || typeof body !== "object") return jsonResponse({ error: "invalid_request" }, HTTP_STATUS.BAD_REQUEST)
    const planId = typeof body.planId === "string" ? body.planId : ""
    const baseVersion = typeof body.baseVersion === "number" ? body.baseVersion : NaN
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : ""
    if (
      planId !== session.planId ||
      !Number.isSafeInteger(baseVersion) ||
      !idempotencyKey ||
      idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
    ) {
      return jsonResponse({ error: "invalid_request" }, HTTP_STATUS.BAD_REQUEST)
    }
    const active = await store.activePlan(session.chatId)
    if (!active || active.plan.planId !== planId) return jsonResponse({ error: "conflict" }, HTTP_STATUS.CONFLICT)
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
        accepted.reason === "stale" ? HTTP_STATUS.CONFLICT : HTTP_STATUS.BAD_REQUEST,
      )
    }
    if (accepted.duplicate) return jsonResponse({ status: "accepted", batchId: accepted.batch.batchId }, HTTP_ACCEPTED)
    const dispatched = await startFeedbackBatch(accepted.batch, c.env)
    if (!dispatched)
      return jsonResponse({ status: "failed", batchId: accepted.batch.batchId }, HTTP_STATUS.SERVICE_UNAVAILABLE)
    return jsonResponse({ status: "accepted", batchId: accepted.batch.batchId }, HTTP_ACCEPTED)
  } catch (error) {
    return errorResponse(error)
  }
})
