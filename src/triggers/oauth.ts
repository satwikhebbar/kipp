import { isInsecureLocalAccessEnabled, verifyAccessJwt } from "../token-vault-client"
import type { Env } from "../types"

/** Allows Cloudflare Access admins, with an explicit development-only local escape hatch. */
export async function hasSetupAccess(request: Request, env: Env): Promise<boolean> {
  return Boolean(await verifyAccessJwt(request, env)) || isInsecureLocalAccessEnabled(env)
}

/** Extracts a named cookie value from a Cookie header string. */
export function extractCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim()
    if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1)
  }
  return null
}
