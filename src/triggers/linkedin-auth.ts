import { createGitHubClient } from "../integrations/github"
import type { Env, LinkedInTokens } from "../types"

const AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization"
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken"

async function createState(secret: string): Promise<string> {
  const nonce = crypto.randomUUID()
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(nonce))
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
  return `${nonce}.${sigB64}`
}

async function verifyState(state: string, secret: string): Promise<boolean> {
  const dot = state.indexOf(".")
  if (dot === -1) return false
  const nonce = state.slice(0, dot)
  const sigB64 = state.slice(dot + 1)
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "verify",
  ])
  const sig = new Uint8Array(
    atob(sigB64)
      .split("")
      .map((c) => c.charCodeAt(0)),
  )
  return crypto.subtle.verify("HMAC", key, sig, encoder.encode(nonce))
}

export async function handleAuthStart(host: string, env: Env): Promise<Response> {
  const redirectUri = redirectUrl(env, host)
  const state = await createState(env.TELEGRAM_WEBHOOK_SECRET)
  const url = new URL(AUTH_URL)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", env.LINKEDIN_CLIENT_ID)
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("scope", "w_member_social")
  url.searchParams.set("state", state)
  return Response.redirect(url.toString(), 302)
}

export async function handleAuthCallback(code: string, state: string, host: string, env: Env): Promise<Response> {
  if (!state || !(await verifyState(state, env.TELEGRAM_WEBHOOK_SECRET))) {
    return new Response("OAuth setup failed: invalid state", { status: 400 })
  }

  const redirectUri = redirectUrl(env, host)

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: env.LINKEDIN_CLIENT_ID,
      client_secret: env.LINKEDIN_CLIENT_SECRET,
      redirect_uri: redirectUri,
    }),
  })

  if (!res.ok) {
    return new Response("OAuth setup failed: token exchange error", { status: 400 })
  }

  const data = (await res.json()) as {
    access_token: string
    expires_in: number
    refresh_token?: string
    refresh_token_expires_in?: number
  }

  const tokens: LinkedInTokens = {
    access_token: data.access_token,
    expires_in: data.expires_in,
    created_at: new Date().toISOString(),
    ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
    ...(data.refresh_token_expires_in ? { refresh_token_expires_in: data.refresh_token_expires_in } : {}),
  }

  const github = createGitHubClient(env)
  let sha: string | undefined
  try {
    const existing = await github.readFile(".linkedin-tokens.json")
    sha = existing.sha
  } catch {
    /* new file, no sha needed */
  }
  await github.writeFile(".linkedin-tokens.json", JSON.stringify(tokens, null, 2), sha)

  return new Response("✅ LinkedIn tokens stored. You can close this tab.", { status: 200 })
}

function redirectUrl(env: Env, host: string): string {
  const origin = env.LINKEDIN_REDIRECT_ORIGIN || `https://${host}`
  return `${origin}/auth/linkedin/callback`
}
