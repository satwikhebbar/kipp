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
