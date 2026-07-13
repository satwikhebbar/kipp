import type { Env, LinkedInTokens } from "../types"
import type { GithubClient } from "./github"
import { createGitHubClient } from "./github"

const LINKEDIN_API = "https://api.linkedin.com"

export class LinkedInError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "LinkedInError"
  }
}

export interface LinkedinClient {
  createDraftPost(authorUrn: string, text: string): Promise<{ urn: string }>
}

export async function getLinkedInToken(env: Env, gh?: GithubClient): Promise<string> {
  try {
    const client = gh ?? createGitHubClient(env)
    const file = await client.readFile(".linkedin-tokens.json")
    const tokens = JSON.parse(file.content) as LinkedInTokens
    if (tokens.access_token) return tokens.access_token
  } catch {
    /* fall through */
  }
  if (env.LINKEDIN_ACCESS_TOKEN) return env.LINKEDIN_ACCESS_TOKEN
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
      throw new LinkedInError(res.status, `LinkedIn API error ${res.status}: ${text}`)
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
