import { beforeEach, describe, expect, it, vi } from "vitest"

const mockFetch = vi.hoisted(() => vi.fn())
vi.stubGlobal("fetch", mockFetch)

import { createLinkedInClient } from "../integrations/linkedin"

describe("createLinkedInClient", () => {
  beforeEach(() => mockFetch.mockReset())

  it("creates a draft post and returns URN", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Map([["x-restli-id", "urn:li:share:abc123"]]),
    })
    const client = createLinkedInClient("token")
    const result = await client.createDraftPost("urn:li:person:789", "Post text")
    expect(result.urn).toBe("urn:li:share:abc123")
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.linkedin.com/rest/posts",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer token",
          "LinkedIn-Version": "202501",
        }),
        body: expect.stringContaining('"commentary":"Post text"'),
      }),
    )
  })

  it("includes lifecycleState DRAFT in body", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Map([["x-restli-id", "urn:li:share:abc123"]]),
    })
    const client = createLinkedInClient("token")
    await client.createDraftPost("urn:li:person:1", "Text")
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(callBody.lifecycleState).toBe("DRAFT")
    expect(callBody.visibility).toBe("PUBLIC")
  })

  it("throws on API error", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve("unauthorized") })
    const client = createLinkedInClient("bad-token")
    await expect(client.createDraftPost("urn:li:person:1", "x")).rejects.toThrow("LinkedIn API error 401")
  })
})
