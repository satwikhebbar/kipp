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
  TELEGRAM_WEBHOOK_SECRET: "whsec-789",
  GITHUB_PAT: "ghp_token",
  DATA_REPO_OWNER: "owner",
  DATA_REPO_NAME: "repo",
} as never

describe("handleAuthStart", () => {
  it("redirects to LinkedIn authorize URL with correct params", async () => {
    const res = await handleAuthStart("example.com", MIN_ENV)
    expect(res.status).toBe(302)
    const loc = res.headers.get("location")
    expect(loc).toBeTruthy()
    const url = new URL(loc!)
    expect(url.origin + url.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("client_id")).toBe("client-123")
    expect(url.searchParams.get("redirect_uri")).toBe("https://example.com/auth/linkedin/callback")
    expect(url.searchParams.get("scope")).toBe("w_member_social offline_access")
    expect(url.searchParams.get("state")).toBeTruthy()
  })

  it("uses LINKEDIN_REDIRECT_ORIGIN when configured", async () => {
    const env = Object.assign({}, MIN_ENV, { LINKEDIN_REDIRECT_ORIGIN: "https://custom.example.com" }) as never
    const res = await handleAuthStart("ignored-host", env)
    const loc = res.headers.get("location")
    expect(loc).toBeTruthy()
    const url = new URL(loc!)
    expect(url.searchParams.get("redirect_uri")).toBe("https://custom.example.com/auth/linkedin/callback")
  })
})

describe("handleAuthCallback", () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockReadFile.mockReset()
    mockWriteFile.mockReset()
  })

  async function validState(host = "example.com"): Promise<string> {
    const res = await handleAuthStart(host, MIN_ENV)
    const loc = res.headers.get("location")!
    return new URL(loc).searchParams.get("state")!
  }

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

    const state = await validState()
    const res = await handleAuthCallback("auth-code-123", state, "example.com", MIN_ENV)
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

    const state = await validState()
    const res = await handleAuthCallback("code-456", state, "example.com", MIN_ENV)
    expect(res.status).toBe(200)
    expect(mockWriteFile).toHaveBeenCalledWith(".linkedin-tokens.json", expect.any(String), "abc123")
  })

  it("rejects callback with missing or mismatched state", async () => {
    mockReadFile.mockRejectedValue(new Error("Not found"))

    const noState = await handleAuthCallback("code", "", "example.com", MIN_ENV)
    expect(noState.status).toBe(400)
    expect(await noState.text()).toContain("invalid state")
    expect(mockWriteFile).not.toHaveBeenCalled()

    const badState = await handleAuthCallback("code", "bad-state", "example.com", MIN_ENV)
    expect(badState.status).toBe(400)
    expect(await badState.text()).toContain("invalid state")
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it("sanitizes LinkedIn exchange errors (no raw body leaked)", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('invalid_grant with access_token="leaked"'),
    })
    mockReadFile.mockRejectedValue(new Error("Not found"))

    const state = await validState()
    const res = await handleAuthCallback("bad-code", state, "example.com", MIN_ENV)
    expect(res.status).toBe(400)
    const body = await res.text()
    expect(body).toContain("token exchange error")
    expect(body).not.toContain("invalid_grant")
    expect(body).not.toContain("leaked")
    expect(mockWriteFile).not.toHaveBeenCalled()
  })
})
