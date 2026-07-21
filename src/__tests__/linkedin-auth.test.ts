import { beforeEach, describe, expect, it, vi } from "vitest"

const mockIssueState = vi.hoisted(() => vi.fn())
const mockConsumeState = vi.hoisted(() => vi.fn())
const mockWriteTokens = vi.hoisted(() => vi.fn())

vi.mock("../token-vault-client", () => ({
  createTokenVault: () => ({
    issueState: mockIssueState,
    consumeState: mockConsumeState,
    writeTokens: mockWriteTokens,
  }),
  verifyAccessJwt: vi.fn().mockResolvedValue(null),
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
  ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK: "true",
  DEPLOYMENT_ENV: "development",
} as never

function mockRequest(url = "https://example.com/setup/linkedin"): Request {
  return new Request(url)
}

function mockCallbackRequest(url: string, cookie?: string): Request {
  const headers: Record<string, string> = {}
  if (cookie) headers.cookie = cookie
  return new Request(url, { headers })
}

describe("handleAuthStart", () => {
  beforeEach(() => {
    mockIssueState.mockReset()
  })

  it("redirects to LinkedIn authorize URL with correct params", async () => {
    mockIssueState.mockResolvedValue({ state: "test-state", cookieId: "test-cookie-id" })
    const req = mockRequest()
    const res = await handleAuthStart(req, "example.com", MIN_ENV)
    expect(res.status).toBe(302)
    const loc = res.headers.get("location") as string
    const url = new URL(loc)
    expect(url.origin + url.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("client_id")).toBe("client-123")
    expect(url.searchParams.get("redirect_uri")).toBe("https://example.com/auth/linkedin/callback")
    expect(url.searchParams.get("scope")).toBe("w_member_social")
    expect(url.searchParams.get("state")).toBe("test-state")
    expect(mockIssueState).toHaveBeenCalledOnce()
  })

  it("sets oauth-session cookie on redirect", async () => {
    mockIssueState.mockResolvedValue({ state: "s", cookieId: "cookie-abc" })
    const req = mockRequest()
    const res = await handleAuthStart(req, "example.com", MIN_ENV)
    const setCookie = res.headers.get("set-cookie") ?? ""
    expect(setCookie).toContain("oauth-session=cookie-abc")
    expect(setCookie).toContain("Secure")
    expect(setCookie).toContain("HttpOnly")
    expect(setCookie).toContain("SameSite=Lax")
    expect(setCookie).toContain("Path=/auth/linkedin")
    expect(setCookie).toContain("Max-Age=300")
  })

  it("uses LINKEDIN_REDIRECT_ORIGIN when configured", async () => {
    mockIssueState.mockResolvedValue({ state: "s", cookieId: "c" })
    const env = Object.assign({}, MIN_ENV, { LINKEDIN_REDIRECT_ORIGIN: "https://custom.example.com" }) as never
    const req = mockRequest()
    const res = await handleAuthStart(req, "ignored-host", env)
    const loc = res.headers.get("location") as string
    const url = new URL(loc)
    expect(url.searchParams.get("redirect_uri")).toBe("https://custom.example.com/auth/linkedin/callback")
  })
})

describe("handleAuthCallback", () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockConsumeState.mockReset()
    mockWriteTokens.mockReset()
  })

  it("exchanges code and stores tokens via DO on success", async () => {
    mockConsumeState.mockResolvedValue({ valid: true })
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: "new-access-token",
          expires_in: 5184000,
          refresh_token: "new-refresh-token",
        }),
    })
    mockWriteTokens.mockResolvedValue({ ok: true })

    const req = mockCallbackRequest(
      "https://example.com/auth/linkedin/callback?code=abc&state=xyz",
      "oauth-session=cookie-123",
    )
    const res = await handleAuthCallback("auth-code-123", "test-state", "example.com", MIN_ENV, req)
    expect(res.status).toBe(200)

    expect(mockConsumeState).toHaveBeenCalledWith("test-state", "cookie-123")
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
    expect(mockWriteTokens).toHaveBeenCalledWith(expect.objectContaining({ access_token: "new-access-token" }))
  })

  it("returns 400 when oauth-session cookie is missing", async () => {
    const req = mockCallbackRequest("https://example.com/auth/linkedin/callback?code=abc&state=xyz")
    const res = await handleAuthCallback("code", "state", "example.com", MIN_ENV, req)
    expect(res.status).toBe(400)
    expect(mockWriteTokens).not.toHaveBeenCalled()
  })

  it("returns 400 when state is invalid", async () => {
    mockConsumeState.mockResolvedValue({ valid: false })
    const req = mockCallbackRequest(
      "https://example.com/auth/linkedin/callback?code=abc&state=bad",
      "oauth-session=cookie-123",
    )
    const res = await handleAuthCallback("code", "bad-state", "example.com", MIN_ENV, req)
    expect(res.status).toBe(400)
    expect(mockWriteTokens).not.toHaveBeenCalled()
  })

  it("returns 400 on LinkedIn token exchange error", async () => {
    mockConsumeState.mockResolvedValue({ valid: true })
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('invalid_grant with access_token="leaked"'),
    })

    const req = mockCallbackRequest(
      "https://example.com/auth/linkedin/callback?code=abc&state=xyz",
      "oauth-session=cookie-123",
    )
    const res = await handleAuthCallback("bad-code", "test-state", "example.com", MIN_ENV, req)
    expect(res.status).toBe(400)
    const body = await res.text()
    expect(body).toBe("OAuth setup failed")
    expect(body).not.toContain("invalid_grant")
    expect(body).not.toContain("leaked")
    expect(mockWriteTokens).not.toHaveBeenCalled()
  })

  it("returns 500 when writeTokens fails", async () => {
    mockConsumeState.mockResolvedValue({ valid: true })
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: "t", expires_in: 5184000 }),
    })
    mockWriteTokens.mockResolvedValue({ ok: false })

    const req = mockCallbackRequest(
      "https://example.com/auth/linkedin/callback?code=abc&state=xyz",
      "oauth-session=cookie-123",
    )
    const res = await handleAuthCallback("code", "test-state", "example.com", MIN_ENV, req)
    expect(res.status).toBe(500)
  })
})
