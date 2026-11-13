import type { BufferGrantInput, Env } from "../../core/types"

export const BUFFER_SCOPES = ["account:read", "posts:read", "posts:write", "offline_access"] as const
export const BUFFER_AUTH_URL = "https://auth.buffer.com/auth"
export const BUFFER_TOKEN_URL = "https://auth.buffer.com/token"
export const BUFFER_CALLBACK_PATH = "/auth/buffer/callback"
const MILLISECONDS_PER_SECOND = 1000
const TOKEN_TIMEOUT_MS = 20_000

/** Requires an explicit HTTPS origin; request Host never chooses a callback. */
export function bufferRedirectUri(env: Env): string | null {
  try {
    const origin = new URL(env.BUFFER_REDIRECT_ORIGIN ?? "")
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      return null
    return origin.origin + BUFFER_CALLBACK_PATH
  } catch {
    return null
  }
}

/** Validates a complete rotating grant, without logging provider response bodies. */
export function parseBufferToken(data: unknown, now = Date.now()): Omit<BufferGrantInput, "accountId"> {
  const value = data as Record<string, unknown> | null
  const scopes = typeof value?.scope === "string" ? value.scope.split(/\s+/) : []
  if (
    !value ||
    typeof value.access_token !== "string" ||
    !value.access_token ||
    typeof value.refresh_token !== "string" ||
    !value.refresh_token ||
    typeof value.token_type !== "string" ||
    value.token_type.toLowerCase() !== "bearer" ||
    typeof value.expires_in !== "number" ||
    !Number.isFinite(value.expires_in) ||
    value.expires_in <= 0 ||
    !Number.isFinite(now + value.expires_in * MILLISECONDS_PER_SECOND) ||
    !BUFFER_SCOPES.every((scope) => scopes.includes(scope))
  )
    throw new Error("Incomplete Buffer authorization")
  return {
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    expiresAtMs: now + value.expires_in * MILLISECONDS_PER_SECOND,
    scopes,
  }
}

/** Makes exactly one bounded token exchange. An uncertain refresh must not be replayed. */
export async function exchangeBufferToken(
  env: Env,
  parameters: Record<string, string>,
): Promise<Omit<BufferGrantInput, "accountId">> {
  if (!env.BUFFER_CLIENT_ID || !env.BUFFER_CLIENT_SECRET) throw new Error("Buffer OAuth is not configured")
  const response = await fetch(BUFFER_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...parameters,
      client_id: env.BUFFER_CLIENT_ID,
      client_secret: env.BUFFER_CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error("Buffer authorization failed; reconnect Buffer")
  return parseBufferToken(await response.json())
}
