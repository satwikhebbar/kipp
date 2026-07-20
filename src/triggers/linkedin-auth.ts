import { createTokenVault, verifyAccessJwt } from "../token-vault-client"
import type { Env, LinkedInTokens } from "../types"

const AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization"
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken"

function extractCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim()
    if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1)
  }
  return null
}

function redirectUrl(env: Env, host: string): string {
  const origin = env.LINKEDIN_REDIRECT_ORIGIN || `https://${host}`
  return `${origin}/auth/linkedin/callback`
}

export async function handleAuthStart(request: Request, host: string, env: Env): Promise<Response> {
  const claims = await verifyAccessJwt(request, env)
  if (!claims && env.ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK !== "true") {
    return new Response("Setup requires authentication", { status: 403 })
  }

  const vault = createTokenVault(env)
  const { state, cookieId } = await vault.issueState()

  const redirectUri = redirectUrl(env, host)
  const url = new URL(AUTH_URL)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", env.LINKEDIN_CLIENT_ID)
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("scope", "w_member_social")
  url.searchParams.set("state", state)

  const headers = new Headers()
  headers.append(
    "Set-Cookie",
    `oauth-session=${cookieId}; Secure; HttpOnly; SameSite=Lax; Path=/auth/linkedin; Max-Age=300`,
  )
  headers.append("Location", url.toString())
  return new Response(null, { status: 302, headers })
}

export async function handleAuthCallback(
  code: string,
  state: string,
  host: string,
  env: Env,
  request: Request,
): Promise<Response> {
  const claims = await verifyAccessJwt(request, env)
  if (!claims && env.ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK !== "true") {
    return new Response("OAuth setup failed", { status: 403 })
  }

  const cookieHeader = request.headers.get("cookie")
  const cookieId = extractCookie(cookieHeader, "oauth-session")
  if (!cookieId) return new Response("OAuth setup failed", { status: 400 })

  const vault = createTokenVault(env)
  const { valid } = await vault.consumeState(state, cookieId)
  if (!valid) return new Response("OAuth setup failed", { status: 400 })

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
    return new Response("OAuth setup failed", { status: 400 })
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

  const { ok } = await vault.writeTokens(tokens)
  if (!ok) return new Response("OAuth setup failed", { status: 500 })

  return new Response("Ok", { status: 200 })
}
