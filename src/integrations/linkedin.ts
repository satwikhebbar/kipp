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
        "LinkedIn-Version": "202501",
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
    const res = await request("POST", "/rest/posts", {
      author: authorUrn,
      commentary: text,
      visibility: "PUBLIC",
      lifecycleState: "DRAFT",
      distribution: { feedDistribution: "MAIN_FEED" },
    })
    const urn = res.headers.get("x-restli-id") ?? ""
    return { urn }
  }

  return { createDraftPost }
}
