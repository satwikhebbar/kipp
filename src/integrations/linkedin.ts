import { createTokenVault } from "../token-vault-client"
import type { Env } from "../types"

const LINKEDIN_API = "https://api.linkedin.com"

export class LinkedInError extends Error {
  readonly status: number
  declare readonly body?: string

  constructor(status: number, message: string, body?: string) {
    super(message)
    this.name = "LinkedInError"
    this.status = status
    Object.defineProperty(this, "body", {
      value: body,
      enumerable: false,
      writable: false,
      configurable: false,
    })
  }
}

export interface LinkedinClient {
  createDraftPost(authorUrn: string, text: string): Promise<{ urn: string }>
}

export async function getLinkedInToken(env: Env): Promise<string> {
  const vault = createTokenVault(env)
  const { tokens } = await vault.readTokens()
  if (tokens?.access_token) return tokens.access_token
  if (
    env.ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK === "true" &&
    env.DEPLOYMENT_ENV === "development" &&
    env.LINKEDIN_ACCESS_TOKEN
  ) {
    return env.LINKEDIN_ACCESS_TOKEN
  }
  return ""
}

export function createLinkedInClient(accessToken: string): LinkedinClient {
  async function request(method: string, path: string, body?: Record<string, unknown>) {
    const res = await fetch(`${LINKEDIN_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const text = await res.text()
      throw new LinkedInError(res.status, `LinkedIn API error ${res.status}`, text)
    }
    return res
  }

  async function createDraftPost(authorUrn: string, text: string): Promise<{ urn: string }> {
    const res = await request("POST", "/v2/ugcPosts", {
      author: authorUrn,
      lifecycleState: "DRAFT",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text },
          shareMediaCategory: "NONE",
        },
      },
      visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
    })
    const data = (await res.json()) as { id?: string }
    return { urn: data.id ?? "" }
  }

  return { createDraftPost }
}
