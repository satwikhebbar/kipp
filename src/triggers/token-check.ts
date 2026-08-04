import { createTokenVault } from "../core/token-vault-client"
import type { Env, LinkedInTokens } from "../core/types"
import { createTelegramClient } from "../integrations/telegram"

const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken"
const SECONDS_TO_MS = 1000
const MS_PER_DAY = 86_400_000
const EXPIRY_ALERT_DAYS = 7

/** Checks LinkedIn token expiry, attempts refresh if close to expiry, and alerts via Telegram if needed. */
export async function handleTokenCheckCron(env: Env): Promise<{ alerted: boolean; refreshed: boolean }> {
  const vault = createTokenVault(env)
  const { tokens } = await vault.readTokens()
  if (!tokens) return { alerted: false, refreshed: false }

  const expiresAt = new Date(tokens.created_at).getTime() + tokens.expires_in * SECONDS_TO_MS
  const daysUntilExpiry = (expiresAt - Date.now()) / MS_PER_DAY

  if (daysUntilExpiry > EXPIRY_ALERT_DAYS) return { alerted: false, refreshed: false }

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

        await vault.writeTokens(updated)
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
      `⚠️ LinkedIn access token expires in ${Math.ceil(daysUntilExpiry)} days. Re-run OAuth setup to renew.`,
    )
  }

  return { alerted: true, refreshed: false }
}
