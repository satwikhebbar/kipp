import { createTokenVault, TOKEN_PROVIDER } from "../token-vault-client"
import type { Env, GoogleCalendarTokens } from "../types"
import { extractCookie, hasSetupAccess } from "./oauth"

const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
const OAUTH_COOKIE_NAME = "google-calendar-oauth-session"
const OAUTH_STATE_MAX_AGE_SECONDS = 300 // ponytail: 5 minutes

export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
] as const

/** Builds the OAuth redirect URI for Google Calendar. */
function redirectUrl(env: Env, host: string): string {
  const origin = env.GOOGLE_CALENDAR_REDIRECT_ORIGIN || `https://${host}`
  return `${origin}/auth/google-calendar/callback`
}

/** Returns Google Calendar OAuth client credentials or null if not configured. */
function googleClientCredentials(env: Env): { clientId: string; clientSecret: string } | null {
  if (!env.GOOGLE_CALENDAR_CLIENT_ID || !env.GOOGLE_CALENDAR_CLIENT_SECRET) return null
  return { clientId: env.GOOGLE_CALENDAR_CLIENT_ID, clientSecret: env.GOOGLE_CALENDAR_CLIENT_SECRET }
}

/** Initiates the Google Calendar OAuth flow, redirecting to Google's consent page. */
export async function handleGoogleCalendarAuthStart(request: Request, host: string, env: Env): Promise<Response> {
  if (!(await hasSetupAccess(request, env))) return new Response("Setup requires authentication", { status: 403 })
  const credentials = googleClientCredentials(env)
  if (!credentials) return new Response("Google Calendar is not configured", { status: 503 })

  const vault = createTokenVault(env, TOKEN_PROVIDER.GOOGLE_CALENDAR)
  const { state, cookieId } = await vault.issueState()
  const url = new URL(GOOGLE_AUTHORIZATION_URL)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", credentials.clientId)
  url.searchParams.set("redirect_uri", redirectUrl(env, host))
  url.searchParams.set("scope", GOOGLE_CALENDAR_SCOPES.join(" "))
  url.searchParams.set("access_type", "offline")
  url.searchParams.set("prompt", "consent")
  url.searchParams.set("state", state)

  const headers = new Headers({ Location: url.toString() })
  headers.append(
    "Set-Cookie",
    `${OAUTH_COOKIE_NAME}=${cookieId}; Secure; HttpOnly; SameSite=Lax; Path=/auth/google-calendar; Max-Age=${OAUTH_STATE_MAX_AGE_SECONDS}`,
  )
  return new Response(null, { status: 302, headers })
}

/** Handles the Google Calendar OAuth callback, exchanging the code for tokens. */
export async function handleGoogleCalendarAuthCallback(
  code: string,
  state: string,
  host: string,
  env: Env,
  request: Request,
): Promise<Response> {
  if (!(await hasSetupAccess(request, env))) return new Response("OAuth setup failed", { status: 403 })
  const credentials = googleClientCredentials(env)
  if (!credentials) return new Response("OAuth setup failed", { status: 503 })

  const cookieId = extractCookie(request.headers.get("cookie"), OAUTH_COOKIE_NAME)
  if (!cookieId) return new Response("OAuth setup failed", { status: 400 })

  const vault = createTokenVault(env, TOKEN_PROVIDER.GOOGLE_CALENDAR)
  const { valid } = await vault.consumeState(state, cookieId)
  if (!valid) return new Response("OAuth setup failed", { status: 400 })

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      redirect_uri: redirectUrl(env, host),
    }),
  })
  if (!response.ok) return new Response("OAuth setup failed", { status: 400 })

  const data = (await response.json()) as {
    access_token?: string
    expires_in?: number
    refresh_token?: string
    scope?: string
  }
  if (!data.access_token || typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in))
    return new Response("OAuth setup failed", { status: 400 })

  const tokens: GoogleCalendarTokens = {
    access_token: data.access_token,
    expires_in: data.expires_in,
    created_at: new Date().toISOString(),
    ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
    ...(data.scope ? { scope: data.scope } : {}),
  }
  const { ok } = await vault.writeTokens(tokens)
  if (!ok) return new Response("OAuth setup failed", { status: 500 })
  return new Response("Google Calendar connected", { status: 200 })
}
