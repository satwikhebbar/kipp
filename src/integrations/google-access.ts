import type { Env, GoogleCalendarTokens } from "../core/types"

export const GOOGLE_CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts.readonly"
export const GOOGLE_ACCOUNT_EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email"
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
const GOOGLE_TOKEN_REQUEST_TIMEOUT_MS = 10_000

/** Refreshes an offline Google grant without replacing the stored grant. */
export async function refreshGoogleAccess(
  env: Env,
  tokens: GoogleCalendarTokens,
): Promise<GoogleCalendarTokens | null> {
  if (!tokens.refresh_token || !env.GOOGLE_CALENDAR_CLIENT_ID || !env.GOOGLE_CALENDAR_CLIENT_SECRET) return null
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: env.GOOGLE_CALENDAR_CLIENT_ID,
      client_secret: env.GOOGLE_CALENDAR_CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(GOOGLE_TOKEN_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) return null
  const data = (await response.json()) as { access_token?: string; expires_in?: number; scope?: string }
  if (!data.access_token || typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in)) return null
  return {
    ...tokens,
    access_token: data.access_token,
    expires_in: data.expires_in,
    created_at: new Date().toISOString(),
    ...(data.scope ? { scope: data.scope } : {}),
  }
}

/** Checks a space-delimited Google scope grant. */
export function hasGoogleScope(scope: string | undefined, required: string): boolean {
  return scope?.split(/\s+/).includes(required) ?? false
}
