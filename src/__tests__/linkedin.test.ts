import { beforeEach, describe, expect, it, vi } from "vitest"

const mockFetch = vi.hoisted(() => {
  const fn = vi.fn()
  globalThis.fetch = fn
  return fn
})

import { createLinkedInClient, getLinkedInToken, LinkedInError } from "../integrations/linkedin"

interface MockClient {
  readFile(path: string): Promise<{ content: string; sha: string }>
  writeFile: (...args: unknown[]) => unknown
  mutateFile: (...args: unknown[]) => unknown
}

function mockClient(content?: string): MockClient {
  return {
    async readFile(path: string) {
      if (path === ".linkedin-tokens.json" && content !== undefined) return { content, sha: "s1" }
      throw Object.assign(new Error("Not found"), { status: 404 })
    },
    writeFile: vi.fn(),
    mutateFile: vi.fn(),
  }
}

describe("getLinkedInToken", () => {
  it("reads from .linkedin-tokens.json when available", async () => {
    const gh = mockClient(JSON.stringify({ access_token: "file-token" }))
    const token = await getLinkedInToken({} as never, gh as never)
    expect(token).toBe("file-token")
  })

  it("falls back to LINKEDIN_ACCESS_TOKEN when file is missing", async () => {
    const gh = mockClient()
    const token = await getLinkedInToken({ LINKEDIN_ACCESS_TOKEN: "env-token" } as never, gh as never)
    expect(token).toBe("env-token")
  })

  it("falls through when file lacks access_token key", async () => {
    const gh = mockClient(JSON.stringify({}))
    const token = await getLinkedInToken({ LINKEDIN_ACCESS_TOKEN: "env-token" } as never, gh as never)
    expect(token).toBe("env-token")
  })

  it("falls through on file read error", async () => {
    const gh = {
      readFile: vi.fn().mockRejectedValue(new Error("network error")),
      writeFile: vi.fn(),
      mutateFile: vi.fn(),
    }
    const token = await getLinkedInToken({ LINKEDIN_ACCESS_TOKEN: "env-token" } as never, gh as never)
    expect(token).toBe("env-token")
  })

  it("returns empty string when neither source has a token", async () => {
    const gh = mockClient()
    const token = await getLinkedInToken({} as never, gh as never)
    expect(token).toBe("")
  })
})

describe("createLinkedInClient", () => {
  beforeEach(() => mockFetch.mockReset())

  it("creates a draft post and returns URN", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "urn:li:share:abc123" }),
    })
    const client = createLinkedInClient("token")
    const result = await client.createDraftPost("urn:li:person:789", "Post text")
    expect(result.urn).toBe("urn:li:share:abc123")
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.linkedin.com/v2/ugcPosts",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer token",
        }),
      }),
    )
  })

  it("includes lifecycleState DRAFT in body", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "urn:li:share:abc123" }),
    })
    const client = createLinkedInClient("token")
    await client.createDraftPost("urn:li:person:1", "Text")
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(callBody.lifecycleState).toBe("DRAFT")
    expect(callBody.specificContent["com.linkedin.ugc.ShareContent"].shareMediaCategory).toBe("NONE")
  })

  it("throws on API error", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve("unauthorized") })
    const client = createLinkedInClient("bad-token")
    await expect(client.createDraftPost("urn:li:person:1", "x")).rejects.toThrow("LinkedIn API error 401")
  })
})

describe("LinkedInError", () => {
  it("stores body non-enumerably so production log serializers do not leak it", () => {
    const err = new LinkedInError(401, "msg", "body with access_token=secret")
    expect(err.body).toBe("body with access_token=secret")
    expect(Object.keys(err)).not.toContain("body")
    expect(JSON.stringify(err)).not.toContain("access_token")
  })

  it("works without body", () => {
    const err = new LinkedInError(500, "server error")
    expect(err.body).toBeUndefined()
    expect(Object.keys(err)).not.toContain("body")
    expect(JSON.stringify(err)).not.toContain("body")
  })
})
