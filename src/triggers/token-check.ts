import { createGitHubClient } from "../integrations/github"
import { createTelegramClient } from "../integrations/telegram"
import type { Env, LinkedInTokens } from "../types"

const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken"

export async function handleTokenCheckCron(env: Env): Promise<{ alerted: boolean; refreshed: boolean }> {
  const github = createGitHubClient(env)

  let tokens: LinkedInTokens
  try {
    const file = await github.readFile(".linkedin-tokens.json")
    tokens = JSON.parse(file.content) as LinkedInTokens
  } catch {
    return { alerted: false, refreshed: false }
  }

  const expiresAt = new Date(tokens.created_at).getTime() + tokens.expires_in * 1000
  const daysUntilExpiry = (expiresAt - Date.now()) / (1000 * 60 * 60 * 24)

  if (daysUntilExpiry > 7) return { alerted: false, refreshed: false }

  if (tokens.refresh_token) {
    try {
      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          client_id: env.LINKEDIN_CLIENT_ID,
          client_secret: env.LINKEDIN_CLIENT_SECRET,
        }),
      })

      if (res.ok) {
        const data = (await res.json()) as {
          access_token: string
          expires_in: number
          refresh_token?: string
          refresh_token_expires_in?: number
        }

        const updated: LinkedInTokens = {
          access_token: data.access_token,
          expires_in: data.expires_in,
          created_at: new Date().toISOString(),
          ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
          ...(data.refresh_token_expires_in ? { refresh_token_expires_in: data.refresh_token_expires_in } : {}),
        }

        await github.mutateFile(".linkedin-tokens.json", () => JSON.stringify(updated, null, 2))
        return { alerted: false, refreshed: true }
      }
    } catch {
      /* fall through to alert */
    }
  }

  if (env.TELEGRAM_ALLOWED_USER_ID && env.TELEGRAM_BOT_TOKEN) {
    const tg = createTelegramClient(env.TELEGRAM_BOT_TOKEN)
    await tg.sendMessage(
      Number(env.TELEGRAM_ALLOWED_USER_ID),
      `⚠️ LinkedIn access token expires in ${Math.ceil(daysUntilExpiry)} days.\nRun \`wrangler secrets put LINKEDIN_ACCESS_TOKEN <new-token>\` to update it.`,
    )
  }

  return { alerted: true, refreshed: false }
}
