import { beforeEach, describe, expect, it, vi } from "vitest"

const mockReadFile = vi.hoisted(() => vi.fn<() => Promise<{ content: string; sha: string }>>())
const mockWriteFile = vi.hoisted(() => vi.fn<() => Promise<void>>())

vi.mock("../integrations/github", () => ({
  createGitHubClient: () => ({
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    mutateFile: vi.fn(),
  }),
}))

const mockFetch = vi.hoisted(() => {
  const fn = vi.fn()
  globalThis.fetch = fn
  return fn
})

import { handleAuthCallback, handleAuthStart } from "../triggers/linkedin-auth"

const MIN_ENV = {
  LINKEDIN_CLIENT_ID: "client-123",
  LINKEDIN_CLIENT_SECRET: "secret-456",
  GITHUB_PAT: "ghp_token",
  DATA_REPO_OWNER: "owner",
  DATA_REPO_NAME: "repo",
} as never

describe("handleAuthStart", () => {
  it("redirects to LinkedIn authorize URL with correct params", () => {
    const res = handleAuthStart("example.com", MIN_ENV)
    expect(res.status).toBe(302)
    const url = new URL(res.headers.get("location")!)
    expect(url.origin + url.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("client_id")).toBe("client-123")
    expect(url.searchParams.get("redirect_uri")).toBe("https://example.com/auth/linkedin/callback")
    expect(url.searchParams.get("scope")).toBe("w_member_social offline_access")
  })
})

describe("handleAuthCallback", () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockReadFile.mockReset()
    mockWriteFile.mockReset()
  })

  it("exchanges code and stores tokens on success", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: "new-access-token",
          expires_in: 5184000,
          refresh_token: "new-refresh-token",
        }),
    })
    mockReadFile.mockRejectedValue(new Error("Not found"))

    const res = await handleAuthCallback("auth-code-123", "example.com", MIN_ENV)
    expect(res.status).toBe(200)

    expect(mockFetch).toHaveBeenCalledWith(
      "https://www.linkedin.com/oauth/v2/accessToken",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
    )
    const callBody = mockFetch.mock.calls[0][1].body as URLSearchParams
    expect(callBody.get("grant_type")).toBe("authorization_code")
    expect(callBody.get("code")).toBe("auth-code-123")
    expect(mockWriteFile).toHaveBeenCalledWith(
      ".linkedin-tokens.json",
      expect.stringContaining("new-access-token"),
      undefined,
    )
  })

  it("updates existing tokens when file already has a sha", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: "updated-token",
          expires_in: 5184000,
        }),
    })
    mockReadFile.mockResolvedValue({ content: '{"access_token":"old"}', sha: "abc123" })

    const res = await handleAuthCallback("code-456", "example.com", MIN_ENV)
    expect(res.status).toBe(200)
    expect(mockWriteFile).toHaveBeenCalledWith(".linkedin-tokens.json", expect.any(String), "abc123")
  })

  it("returns error when LinkedIn returns non-ok", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("invalid_grant"),
    })
    mockReadFile.mockRejectedValue(new Error("Not found"))

    const res = await handleAuthCallback("bad-code", "example.com", MIN_ENV)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain("invalid_grant")
    expect(mockWriteFile).not.toHaveBeenCalled()
  })
})
