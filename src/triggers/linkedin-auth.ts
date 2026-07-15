import { createGitHubClient } from "../integrations/github"
import type { Env, LinkedInTokens } from "../types"

const AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization"
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken"

export function handleAuthStart(host: string, env: Env): Response {
  const redirectUri = `https://${host}/auth/linkedin/callback`
  const url = new URL(AUTH_URL)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", env.LINKEDIN_CLIENT_ID)
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("scope", "w_member_social offline_access")
  return Response.redirect(url.toString(), 302)
}

export async function handleAuthCallback(code: string, host: string, env: Env): Promise<Response> {
  const redirectUri = `https://${host}/auth/linkedin/callback`

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
    const text = await res.text()
    return new Response(`OAuth exchange failed: ${text}`, { status: 400 })
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
