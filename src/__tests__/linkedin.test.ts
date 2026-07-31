import { beforeEach, describe, expect, it, vi } from "vitest"

const mockReadTokens = vi.hoisted(() => vi.fn())

vi.mock("../token-vault-client", () => ({
  createTokenVault: () => ({ readTokens: mockReadTokens }),
}))

const mockFetch = vi.hoisted(() => {
  const fn = vi.fn()
  globalThis.fetch = fn
  return fn
})

import { createLinkedInClient, getLinkedInToken, LinkedInError } from "../integrations/linkedin"

describe("getLinkedInToken", () => {
  it("reads from DO when tokens exist", async () => {
    mockReadTokens.mockResolvedValue({ tokens: { access_token: "do-token" } })
    const token = await getLinkedInToken({} as never)
    expect(token).toBe("do-token")
  })

  it("falls back to env var when ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK is set", async () => {
    mockReadTokens.mockResolvedValue({ tokens: null })
    const token = await getLinkedInToken({
      LINKEDIN_ACCESS_TOKEN: "env-token",
      ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK: "true",
      DEPLOYMENT_ENV: "development",
    } as never)
    expect(token).toBe("env-token")
  })

  it("returns empty when DO has no tokens and no dev fallback", async () => {
    mockReadTokens.mockResolvedValue({ tokens: null })
    const token = await getLinkedInToken({} as never)
    expect(token).toBe("")
  })

  it("does NOT fall back to env var without ALLOW_INSECURE flag", async () => {
    mockReadTokens.mockResolvedValue({ tokens: null })
    const token = await getLinkedInToken({ LINKEDIN_ACCESS_TOKEN: "env-token" } as never)
    expect(token).toBe("")
  })
})

describe("createLinkedInClient", () => {
  beforeEach(() => mockFetch.mockReset())

  it("creates a draft post and returns URN", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "x-restli-id": "urn:li:ugcPost:from-header" }),
      json: () => Promise.resolve({ id: "urn:li:share:abc123" }),
    })
    const client = createLinkedInClient("token")
    const result = await client.createDraftPost("urn:li:person:789", "Post text")
    expect(result.urn).toBe("urn:li:ugcPost:from-header")
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

  it("uses the JSON ID when LinkedIn does not return an x-restli-id header", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: () => Promise.resolve({ id: "urn:li:share:abc123" }),
    })
    const client = createLinkedInClient("token")
    await expect(client.createDraftPost("urn:li:person:1", "Text")).resolves.toEqual({
      urn: "urn:li:share:abc123",
    })
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
