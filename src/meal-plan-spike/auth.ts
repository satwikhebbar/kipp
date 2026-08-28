const INIT_DATA_MAX_AGE_SECONDS = 10 * 60
const MAX_CLOCK_SKEW_SECONDS = 60
const MILLISECONDS_PER_SECOND = 1_000
const HEX_RADIX = 16
const HEX_BYTE_WIDTH = 2

/** The verified subset of Telegram launch data required by the prototype. */
export interface VerifiedTelegramLaunch {
  userId: string
  fingerprint: string
}

/** Verifies raw Telegram Mini App init data and returns its authenticated user id. */
export async function verifyTelegramMiniAppInitData(
  initData: string,
  botToken: string,
  nowMs: number,
): Promise<VerifiedTelegramLaunch | null> {
  if (!initData || !botToken) return null
  const params = new URLSearchParams(initData)
  const hash = params.get("hash")
  const authDate = Number(params.get("auth_date"))
  const rawUser = params.get("user")
  if (!hash || !Number.isSafeInteger(authDate) || !rawUser) return null
  const nowSeconds = Math.floor(nowMs / MILLISECONDS_PER_SECOND)
  if (authDate > nowSeconds + MAX_CLOCK_SKEW_SECONDS || nowSeconds - authDate > INIT_DATA_MAX_AGE_SECONDS) return null

  let user: unknown
  try {
    user = JSON.parse(rawUser)
  } catch {
    return null
  }
  if (!isTelegramUser(user)) return null

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")
  const secretKey = await hmac(new TextEncoder().encode("WebAppData"), new TextEncoder().encode(botToken))
  const expectedHash = await hmac(secretKey, new TextEncoder().encode(dataCheckString))
  if (!constantTimeEqual(hash, toHex(expectedHash))) return null

  const fingerprint = toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(initData)))
  return { userId: String(user.id), fingerprint }
}

/** Narrows untrusted JSON to the only Telegram user property this prototype uses. */
function isTelegramUser(value: unknown): value is { id: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof (value as { id: unknown }).id === "number" &&
    Number.isSafeInteger((value as { id: number }).id)
  )
}

/** Calculates a SHA-256 HMAC using the Worker Web Crypto implementation. */
async function hmac(key: BufferSource, value: BufferSource): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return crypto.subtle.sign("HMAC", cryptoKey, value)
}

/** Converts bytes to lowercase hexadecimal without Node.js-only helpers. */
function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, "0")).join("")
}

/** Compares two strings without early return for a mismatched character. */
function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return difference === 0
}
