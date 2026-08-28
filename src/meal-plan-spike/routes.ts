import { z } from "zod"
import type { Env } from "../core/types"
import { createTelegramClient, TELEGRAM_NOTIFY_TIMEOUT_MS } from "../integrations/telegram"
import { HTTP_STATUS } from "../runtime/http"
import { verifyTelegramMiniAppInitData } from "./auth"
import { getMealPlanSpikeState } from "./state"

const MAX_INIT_DATA_LENGTH = 8_000
const MAX_FEEDBACK_LENGTH = 1_000
const MINIMUM_TEXT_LENGTH = 1
const MAX_FEEDBACK_ITEMS = 12

const sessionSchema = z.object({ initData: z.string().min(MINIMUM_TEXT_LENGTH).max(MAX_INIT_DATA_LENGTH) })
const feedbackSchema = z.object({
  feedback: z
    .array(
      z.object({
        dayId: z.string().regex(/^[a-z]{3}$/u),
        mealId: z.string().regex(/^[a-z]+$/u),
        text: z.string().trim().min(MINIMUM_TEXT_LENGTH).max(MAX_FEEDBACK_LENGTH),
      }),
    )
    .min(MINIMUM_TEXT_LENGTH)
    .max(MAX_FEEDBACK_ITEMS),
  baseVersion: z.number().int().positive(),
  idempotencyKey: z.string().uuid(),
})

/** Starts a short-lived server session from signed Telegram Mini App launch data. */
export async function createMiniAppSession(request: Request, env: Env): Promise<Response> {
  const parsed = await parseJson(request, sessionSchema)
  if (!parsed) return Response.json({ error: "Invalid session request" }, { status: HTTP_STATUS.BAD_REQUEST })
  const now = Date.now()
  const launch = await verifyTelegramMiniAppInitData(parsed.initData, env.TELEGRAM_BOT_TOKEN, now)
  if (!launch) return Response.json({ error: "Telegram authentication failed" }, { status: HTTP_STATUS.UNAUTHORIZED })

  const state = getMealPlanSpikeState()
  if (!state.consumeInitData(launch.fingerprint))
    return Response.json({ error: "Telegram launch data was already used" }, { status: HTTP_STATUS.UNAUTHORIZED })
  if (launch.userId !== state.authorizedUserId(env.TELEGRAM_ALLOWED_USER_ID))
    return Response.json(
      { error: "This mock plan is not available to this Telegram user" },
      { status: HTTP_STATUS.FORBIDDEN },
    )

  const session = state.createSession(launch.userId, now)
  return Response.json({ sessionToken: session.token, expiresAt: new Date(session.expiresAt).toISOString() })
}

/** Returns the active mock plan only to a valid Mini App session. */
export function readMiniAppPlan(request: Request): Response {
  const session = readSession(request)
  if (!session) return Response.json({ error: "Mini App session required" }, { status: HTTP_STATUS.UNAUTHORIZED })
  const plan = getMealPlanSpikeState().readPlan(session.householdId)
  if (!plan) return Response.json({ error: "Plan not found" }, { status: HTTP_STATUS.FORBIDDEN })
  return Response.json({ plan })
}

/** Hands an explicitly finalized client-side feedback batch to the mock Telegram agent. */
export async function submitMiniAppFeedback(request: Request, env: Env): Promise<Response> {
  const session = readSession(request)
  if (!session) return Response.json({ error: "Mini App session required" }, { status: HTTP_STATUS.UNAUTHORIZED })
  const parsed = await parseJson(request, feedbackSchema)
  if (!parsed) return Response.json({ error: "Invalid feedback" }, { status: HTTP_STATUS.BAD_REQUEST })

  const result = getMealPlanSpikeState().submitFeedbackBatch({
    householdId: session.householdId,
    ...parsed,
    now: Date.now(),
  })
  if (result.kind === "invalid") return Response.json({ error: "Meal not found" }, { status: HTTP_STATUS.BAD_REQUEST })
  if (result.kind === "conflict")
    return Response.json({ error: "This plan changed. Refresh and try again.", plan: result.plan }, { status: 409 })
  if (!result.duplicate) {
    await createTelegramClient(env.TELEGRAM_BOT_TOKEN).sendMessage(
      session.userId,
      `Thanks — I have your ${result.feedback.length} feedback item${result.feedback.length === 1 ? "" : "s"}. Before I revise the mock plan: which change matters most? Reply here.`,
      { signal: AbortSignal.timeout(TELEGRAM_NOTIFY_TIMEOUT_MS) },
    )
  }
  return Response.json({ acceptedFeedbackCount: result.feedback.length }, { status: 202 })
}

/** Extracts and validates the current prototype session from a bearer token. */
function readSession(request: Request) {
  const authorization = request.headers.get("authorization") ?? ""
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : ""
  return token ? getMealPlanSpikeState().readSession(token, Date.now()) : null
}

/** Parses a bounded JSON request with a Zod schema, treating malformed JSON as invalid input. */
async function parseJson<T>(request: Request, schema: z.ZodType<T>): Promise<T | null> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return null
  }
  const parsed = schema.safeParse(body)
  return parsed.success ? parsed.data : null
}
