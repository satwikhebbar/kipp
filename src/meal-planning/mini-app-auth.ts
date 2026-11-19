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
const SETTINGS_LAUNCH_TTL_SECONDS = 600
const MAX_LAUNCH_REFERENCE_LENGTH = 256

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
): Promise<{ userId: string; authDate: number; verifiedHash: string; queryId: string | null }> {
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
  return { userId: String(user.id), authDate, verifiedHash: hashValue.toLowerCase(), queryId: params.get("query_id") }
}

/** Sha256. */
async function sha256(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))
}

/** Random token. */
function randomToken(): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(SESSION_TOKEN_BYTES)))
}

/** Creates a short-lived private-chat settings launch and stores only its hash. */
export async function createSettingsLaunchReference(
  telegramUserId: string,
  chatId: string,
  env: Pick<Env, "MEAL_PLANNING_DB">,
  now = new Date(),
): Promise<{ reference: string; expiresAt: string }> {
  if (!env.MEAL_PLANNING_DB) throw new MiniAppAuthError("unavailable")
  const reference = randomToken()
  const expiresAt = new Date(now.getTime() + SETTINGS_LAUNCH_TTL_SECONDS * SECONDS_PER_MILLISECOND).toISOString()
  await createMealPlanningStore(env.MEAL_PLANNING_DB).createMiniAppSettingsLaunch({
    tokenHash: await sha256(reference),
    telegramUserId,
    chatId,
    expiresAt,
    createdAt: now.toISOString(),
  })
  return { reference, expiresAt }
}

/** Authenticate mini app. */
export async function authenticateMiniApp(
  rawInitData: string,
  env: Pick<Env, "TELEGRAM_BOT_TOKEN" | "TELEGRAM_ALLOWED_USER_ID" | "MEAL_PLANNING_DB">,
  now = new Date(),
  launchReference?: string | null,
): Promise<{ token: string; session: MiniAppSessionRecord; context: MiniAppReviewContext | null }> {
  if (!env.MEAL_PLANNING_DB) throw new MiniAppAuthError("unavailable")
  const nowSeconds = Math.floor(now.getTime() / SECONDS_PER_MILLISECOND)
  const verified = await verifyTelegramInitData(rawInitData, env.TELEGRAM_BOT_TOKEN, nowSeconds)
  if (verified.userId !== env.TELEGRAM_ALLOWED_USER_ID.trim()) throw new MiniAppAuthError("unauthorized")
  const store = createMealPlanningStore(env.MEAL_PLANNING_DB)
  const settingsLaunch = launchReference !== undefined && launchReference !== null
  if (settingsLaunch && (!launchReference || launchReference.length > MAX_LAUNCH_REFERENCE_LENGTH || !verified.queryId))
    throw new MiniAppAuthError("invalid")
  const context = settingsLaunch ? null : await store.resolveMiniAppReviewContext(verified.userId)
  if (!settingsLaunch && !context) throw new MiniAppAuthError("unauthorized")
  const launch = settingsLaunch
    ? await store.getMiniAppSettingsLaunch(await sha256(launchReference as string), verified.userId, now.toISOString())
    : null
  if (settingsLaunch && !launch) throw new MiniAppAuthError("unauthorized")
  if (launch) await store.loadOrCreateProfile(launch.chatId)
  const token = randomToken()
  const fingerprintHash = await sha256(verified.verifiedHash)
  const fingerprintExpiresAt = new Date(
    (verified.authDate + AUTH_MAX_AGE_SECONDS) * SECONDS_PER_MILLISECOND,
  ).toISOString()
  const sessionInput = {
    sessionId: crypto.randomUUID(),
    tokenHash: await sha256(token),
    telegramUserId: verified.userId,
    chatId: launch?.chatId ?? (context as MiniAppReviewContext).chatId,
    planId: context?.planId ?? null,
    scope: settingsLaunch ? "settings" : "review",
    expiresAt: new Date(now.getTime() + AUTH_MAX_AGE_SECONDS * SECONDS_PER_MILLISECOND).toISOString(),
    createdAt: now.toISOString(),
  } as const
  let session: MiniAppSessionRecord
  if (launch) {
    const exchanged = await store.exchangeMiniAppSettingsLaunch({
      launchTokenHash: launch.tokenHash,
      telegramUserId: verified.userId,
      fingerprintHash,
      fingerprintExpiresAt,
      now: now.toISOString(),
      session: sessionInput,
    })
    if (!exchanged.ok) throw new MiniAppAuthError(exchanged.reason)
    session = exchanged.session
  } else {
    const replayed = await store.consumeMiniAppInitDataFingerprint(
      fingerprintHash,
      fingerprintExpiresAt,
      now.toISOString(),
    )
    if (!replayed) throw new MiniAppAuthError("replayed")
    session = await store.createMiniAppSession(sessionInput)
  }
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
