import { beforeEach, describe, expect, it, vi } from "vitest"

const mockReadTokens = vi.hoisted(() => vi.fn())
const mockWriteTokens = vi.hoisted(() => vi.fn())

vi.mock("../token-vault-client", () => ({
  createTokenVault: () => ({
    readTokens: mockReadTokens,
    writeTokens: mockWriteTokens,
  }),
}))

const mockFetch = vi.hoisted(() => vi.fn())
vi.stubGlobal("fetch", mockFetch)

import { handleTokenCheckCron } from "../triggers/token-check"

function mockEnv(overrides?: Record<string, string>) {
  return {
    TELEGRAM_BOT_TOKEN: "bot:token",
    TELEGRAM_WEBHOOK_SECRET: "secret",
    TELEGRAM_ALLOWED_USER_ID: "123",
    LINKEDIN_CLIENT_ID: "client_id",
    LINKEDIN_CLIENT_SECRET: "client_secret",
    ...overrides,
  }
}

const VALID_TOKENS = {
  access_token: "at-valid",
  expires_in: 5184000,
  created_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString(), // 2 days old, ~58 days left
  refresh_token: "rt-valid",
}

const EXPIRING_TOKENS = {
  access_token: "at-expiring",
  expires_in: 5184000,
  created_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 55).toISOString(), // 55 days old, ~5 days left
  refresh_token: "rt-expiring",
}

const NO_REFRESH_TOKENS = {
  access_token: "at-no-refresh",
  expires_in: 5184000,
  created_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 55).toISOString(),
}

describe("handleTokenCheckCron", () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockReadTokens.mockReset()
    mockWriteTokens.mockReset()
  })

  it("skips when no tokens stored", async () => {
    mockReadTokens.mockResolvedValue({ tokens: null })
    const result = await handleTokenCheckCron(mockEnv() as never)
    expect(result).toEqual({ alerted: false, refreshed: false })
  })

  it("skips when token is not near expiry", async () => {
    mockReadTokens.mockResolvedValue({ tokens: VALID_TOKENS })
    const result = await handleTokenCheckCron(mockEnv() as never)
    expect(result).toEqual({ alerted: false, refreshed: false })
  })

  it("refreshes token when near expiry", async () => {
    mockReadTokens.mockResolvedValue({ tokens: EXPIRING_TOKENS })
    mockFetch.mockImplementation(async (url: string) => {
      if (url?.includes?.("linkedin.com/oauth")) {
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: "at-refreshed",
              expires_in: 5184000,
              refresh_token: "rt-new",
            }),
        }
      }
      return { ok: true, json: () => Promise.resolve({}) }
    })
    const result = await handleTokenCheckCron(mockEnv() as never)
    expect(result).toEqual({ alerted: false, refreshed: true })
    expect(mockWriteTokens).toHaveBeenCalledWith(expect.objectContaining({ access_token: "at-refreshed" }))
  })

  it("alerts when refresh API returns error", async () => {
    let sentMessage = ""
    mockReadTokens.mockResolvedValue({ tokens: EXPIRING_TOKENS })
    mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url?.includes?.("linkedin.com/oauth")) {
        return { ok: false, status: 400, text: () => Promise.resolve("bad request") }
      }
      if (url?.includes?.("api.telegram.org/bot")) {
        const body = JSON.parse(opts?.body as string) as { text?: string }
        sentMessage = body.text ?? ""
        return { ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 1 } }) }
      }
      return { ok: true, json: () => Promise.resolve({}) }
    })
    const result = await handleTokenCheckCron(mockEnv() as never)
    expect(result).toEqual({ alerted: true, refreshed: false })
    expect(sentMessage).toContain("expires")
  })

  it("alerts when refresh throws (network error)", async () => {
    let sentMessage = ""
    mockReadTokens.mockResolvedValue({ tokens: EXPIRING_TOKENS })
    mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url?.includes?.("linkedin.com/oauth")) {
        throw new Error("network timeout")
      }
      if (url?.includes?.("api.telegram.org/bot")) {
        const body = JSON.parse(opts?.body as string) as { text?: string }
        sentMessage = body.text ?? ""
        return { ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 1 } }) }
      }
      return { ok: true, json: () => Promise.resolve({}) }
    })
    const result = await handleTokenCheckCron(mockEnv() as never)
    expect(result).toEqual({ alerted: true, refreshed: false })
    expect(sentMessage).toContain("expires")
  })

  it("alerts when near expiry and no refresh token", async () => {
    let sentMessage = ""
    mockReadTokens.mockResolvedValue({ tokens: NO_REFRESH_TOKENS })
    mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url?.includes?.("api.telegram.org/bot")) {
        const body = JSON.parse(opts?.body as string) as { text?: string }
        sentMessage = body.text ?? ""
        return { ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 1 } }) }
      }
      return { ok: true, json: () => Promise.resolve({}) }
    })
    const result = await handleTokenCheckCron(mockEnv() as never)
    expect(result).toEqual({ alerted: true, refreshed: false })
    expect(sentMessage).toContain("expires")
  })

  it("does not leak tokens, secrets, or provider error body in Telegram alert on refresh failure", async () => {
    let sentMessage = ""
    const accessToken = "at-leak-check-xyz"
    const refreshToken = "rt-leak-check-xyz"
    const clientSecret = "cs-leak-check-xyz"
    const errorBody = JSON.stringify({ error: "invalid_client", error_description: "secret_mismatch" })
    mockReadTokens.mockResolvedValue({
      tokens: {
        access_token: accessToken,
        expires_in: 5184000,
        created_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 55).toISOString(),
        refresh_token: refreshToken,
      },
    })
    mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url?.includes?.("linkedin.com/oauth")) {
        return { ok: false, status: 400, text: () => Promise.resolve(errorBody) }
      }
      if (url?.includes?.("api.telegram.org/bot")) {
        const body = JSON.parse(opts?.body as string) as { text?: string }
        sentMessage = body.text ?? ""
        return { ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 1 } }) }
      }
      return { ok: true, json: () => Promise.resolve({}) }
    })
    const result = await handleTokenCheckCron(mockEnv({ LINKEDIN_CLIENT_SECRET: clientSecret }) as never)
    expect(result).toEqual({ alerted: true, refreshed: false })
    expect(sentMessage).toContain("expires")
    expect(sentMessage).not.toContain(accessToken)
    expect(sentMessage).not.toContain(refreshToken)
    expect(sentMessage).not.toContain(clientSecret)
    expect(sentMessage).not.toContain("invalid_client")
    expect(sentMessage).not.toContain("secret_mismatch")
  })
})
