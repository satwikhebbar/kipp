import { beforeEach, describe, expect, it, vi } from "vitest"
import { handleTokenCheckCron } from "../triggers/token-check"

const mockFetch = vi.hoisted(() => vi.fn())
vi.stubGlobal("fetch", mockFetch)

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function mockEnv(overrides?: Record<string, string>) {
  return {
    GITHUB_PAT: "pat",
    DATA_REPO_OWNER: "o",
    DATA_REPO_NAME: "r",
    TELEGRAM_BOT_TOKEN: "bot:token",
    TELEGRAM_WEBHOOK_SECRET: "secret",
    TELEGRAM_ALLOWED_USER_ID: "123",
    LINKEDIN_CLIENT_ID: "client_id",
    LINKEDIN_CLIENT_SECRET: "client_secret",
    LINKEDIN_ACCESS_TOKEN: "",
    LINKEDIN_REFRESH_TOKEN: "",
    LINKEDIN_AUTHOR_URN: "",
    LLM_API_KEY: "",
    LLM_PROVIDER: "gemini",
    SUBSTACK_RSS_URL: "",
    POSTING_CADENCE_DAYS: "7",
    PIPELINE_WORKFLOW: {} as never,
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
  beforeEach(() => mockFetch.mockReset())

  it("skips when no token file exists", async () => {
    mockFetch.mockImplementation(async () => ({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Not Found"),
    }))
    const result = await handleTokenCheckCron(mockEnv() as never)
    expect(result).toEqual({ alerted: false, refreshed: false })
  })

  it("skips when token is not near expiry", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url?.includes?.("api.github.com")) {
        return {
          ok: true,
          json: () => Promise.resolve({ content: b64(JSON.stringify(VALID_TOKENS)), sha: "s1" }),
        }
      }
      return { ok: true, json: () => Promise.resolve({}) }
    })
    const result = await handleTokenCheckCron(mockEnv() as never)
    expect(result).toEqual({ alerted: false, refreshed: false })
  })

  it("refreshes token when near expiry", async () => {
    let writtenContent = ""
    mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url?.includes?.("api.github.com")) {
        if (opts?.method === "PUT") {
          const body = JSON.parse(opts.body as string) as { content: string }
          writtenContent = new TextDecoder().decode(Uint8Array.from(atob(body.content), (c) => c.charCodeAt(0)))
          return { ok: true, json: () => Promise.resolve({}) }
        }
        return {
          ok: true,
          json: () => Promise.resolve({ content: b64(JSON.stringify(EXPIRING_TOKENS)), sha: "s1" }),
        }
      }
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
    expect(writtenContent).toContain("at-refreshed")
    expect(writtenContent).toContain("rt-new")
  })

  it("alerts when refresh API returns error", async () => {
    let sentMessage = ""
    mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url?.includes?.("api.github.com")) {
        return {
          ok: true,
          json: () => Promise.resolve({ content: b64(JSON.stringify(EXPIRING_TOKENS)), sha: "s1" }),
        }
      }
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
    mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url?.includes?.("api.github.com")) {
        return {
          ok: true,
          json: () => Promise.resolve({ content: b64(JSON.stringify(EXPIRING_TOKENS)), sha: "s1" }),
        }
      }
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
    mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url?.includes?.("api.github.com")) {
        return {
          ok: true,
          json: () => Promise.resolve({ content: b64(JSON.stringify(NO_REFRESH_TOKENS)), sha: "s1" }),
        }
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
})
