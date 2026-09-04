import { base64urlEncode } from "../core/crypto"
import type { Env } from "../core/types"
import { HTTP_STATUS } from "../runtime/http"
import { createMealPlanningStore, type MiniAppReviewContext, type MiniAppSessionRecord } from "./store"

const AUTH_MAX_AGE_SECONDS = 600
const AUTH_FUTURE_SKEW_SECONDS = 60
const SHA256_HEX_LENGTH = 64
const SHA256_BYTE_LENGTH = 32
const HEX_RADIX = 16
const HEX_BYTE_WIDTH = 2
const SECONDS_PER_MILLISECOND = 1_000
const MAX_BEARER_LENGTH = 256
const MAX_INIT_DATA_LENGTH = 16_384
const SESSION_TOKEN_BYTES = 32

export class MiniAppAuthError extends Error {
  constructor(
    readonly reason: "invalid" | "expired" | "replayed" | "unauthorized" | "unavailable",
    readonly status: 401 | 403 | 503 = reason === "unavailable"
      ? HTTP_STATUS.SERVICE_UNAVAILABLE
      : reason === "unauthorized"
        ? HTTP_STATUS.FORBIDDEN
        : HTTP_STATUS.UNAUTHORIZED,
  ) {
    super(reason)
  }
}

/** Hex. */
function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, "0")).join("")
}

/** From hex. */
function fromHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null
  const result = new Uint8Array(SHA256_BYTE_LENGTH)
  for (let index = 0; index < result.length; index++)
    result[index] = Number.parseInt(
      value.slice(index * HEX_BYTE_WIDTH, index * HEX_BYTE_WIDTH + HEX_BYTE_WIDTH),
      HEX_RADIX,
    )
  return result
}

/** Hmac. */
async function hmac(keyBytes: Uint8Array, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)))
}

/** Equal bytes. */
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index]
  return difference === 0
}

/** Verifies Telegram's sorted data-check HMAC and returns its verified user id. */
export async function verifyTelegramInitData(
  raw: string,
  botToken: string,
  nowSeconds = Math.floor(Date.now() / SECONDS_PER_MILLISECOND),
): Promise<{ userId: string; authDate: number; verifiedHash: string }> {
  if (!raw || raw.length > MAX_INIT_DATA_LENGTH) throw new MiniAppAuthError("invalid")
  const params = new URLSearchParams(raw)
  const hashValue = params.get("hash")
  const authDateValue = params.get("auth_date")
  const userValue = params.get("user")
  if (!hashValue || hashValue.length !== SHA256_HEX_LENGTH || !authDateValue || !userValue) {
    throw new MiniAppAuthError("invalid")
  }
  const authDate = Number(authDateValue)
  if (!Number.isInteger(authDate)) throw new MiniAppAuthError("invalid")
  if (nowSeconds - authDate > AUTH_MAX_AGE_SECONDS || authDate - nowSeconds > AUTH_FUTURE_SKEW_SECONDS) {
    throw new MiniAppAuthError("expired")
  }
  let user: { id?: number | string }
  try {
    user = JSON.parse(userValue) as { id?: number | string }
  } catch {
    throw new MiniAppAuthError("invalid")
  }
  if (user.id === undefined || user.id === "") throw new MiniAppAuthError("invalid")
  const checkString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")
  const secret = await hmac(new TextEncoder().encode("WebAppData"), botToken)
  const expected = await hmac(secret, checkString)
  const supplied = fromHex(hashValue)
  if (!supplied || !equalBytes(expected, supplied)) throw new MiniAppAuthError("invalid")
  return { userId: String(user.id), authDate, verifiedHash: hashValue.toLowerCase() }
}

/** Sha256. */
async function sha256(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))
}

/** Random token. */
function randomToken(): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(SESSION_TOKEN_BYTES)))
}

/** Authenticate mini app. */
export async function authenticateMiniApp(
  rawInitData: string,
  env: Pick<Env, "TELEGRAM_BOT_TOKEN" | "TELEGRAM_ALLOWED_USER_ID" | "MEAL_PLANNING_DB">,
  now = new Date(),
): Promise<{ token: string; session: MiniAppSessionRecord; context: MiniAppReviewContext }> {
  if (!env.MEAL_PLANNING_DB) throw new MiniAppAuthError("unavailable")
  const nowSeconds = Math.floor(now.getTime() / SECONDS_PER_MILLISECOND)
  const verified = await verifyTelegramInitData(rawInitData, env.TELEGRAM_BOT_TOKEN, nowSeconds)
  if (verified.userId !== env.TELEGRAM_ALLOWED_USER_ID.trim()) throw new MiniAppAuthError("unauthorized")
  const store = createMealPlanningStore(env.MEAL_PLANNING_DB)
  const replayed = await store.consumeMiniAppInitDataFingerprint(
    await sha256(verified.verifiedHash),
    new Date((verified.authDate + AUTH_MAX_AGE_SECONDS) * SECONDS_PER_MILLISECOND).toISOString(),
    now.toISOString(),
  )
  if (!replayed) throw new MiniAppAuthError("replayed")
  const context = await store.resolveMiniAppReviewContext(verified.userId)
  if (!context) throw new MiniAppAuthError("unauthorized")
  const token = randomToken()
  const session = await store.createMiniAppSession({
    sessionId: crypto.randomUUID(),
    tokenHash: await sha256(token),
    telegramUserId: verified.userId,
    chatId: context.chatId,
    planId: context.planId,
    expiresAt: new Date(now.getTime() + AUTH_MAX_AGE_SECONDS * SECONDS_PER_MILLISECOND).toISOString(),
    createdAt: now.toISOString(),
  })
  return { token, session, context }
}

/** Read mini app session. */
export async function readMiniAppSession(
  authorization: string | undefined,
  env: Pick<Env, "MEAL_PLANNING_DB">,
  now = new Date(),
): Promise<MiniAppSessionRecord> {
  if (!env.MEAL_PLANNING_DB || !authorization?.startsWith("Bearer ")) throw new MiniAppAuthError("unauthorized")
  const token = authorization.slice("Bearer ".length).trim()
  if (!token || token.length > MAX_BEARER_LENGTH) throw new MiniAppAuthError("unauthorized")
  const session = await createMealPlanningStore(env.MEAL_PLANNING_DB).readMiniAppSession(
    await sha256(token),
    now.toISOString(),
  )
  if (!session) throw new MiniAppAuthError("unauthorized")
  return session
}
