import { afterEach, describe, expect, it, vi } from "vitest"
import { TokenVaultDO } from "../token-vault"
import { createTokenVault } from "../token-vault-client"
import { handleGoogleCalendarAuthCallback, handleGoogleCalendarAuthStart } from "../triggers/google-calendar-auth"
import type { Env } from "../types"

const ONE_HOUR_IN_SECONDS = 60 * 60

function storage(): DurableObjectStorage {
  const entries = new Map<string, unknown>()
  return {
    get: async (key: string) => entries.get(key),
    put: async (key: string, value: unknown) => entries.set(key, value),
    delete: async (key: string) => entries.delete(key),
    list: async (options?: { prefix?: string }) =>
      new Map([...entries].filter(([key]) => !options?.prefix || key.startsWith(options.prefix))),
    getAlarm: async () => null,
    setAlarm: async () => {},
  } as unknown as DurableObjectStorage
}

function environment(): Env {
  const vault = new TokenVaultDO(
    { storage: storage() } as never,
    {
      TOKEN_ENCRYPTION_KEY_IDS: "test",
      TOKEN_ENCRYPTION_KEY_test: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    } as never,
  )
  return {
    DEPLOYMENT_ENV: "development",
    ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK: "true",
    GOOGLE_CALENDAR_CLIENT_ID: "google-client",
    GOOGLE_CALENDAR_CLIENT_SECRET: "google-secret",
    TOKEN_VAULT: {
      idFromName: () => "vault",
      get: () => ({
        fetch: (url: string | Request, init?: RequestInit) =>
          vault.fetch(url instanceof Request ? url : new Request(url, init)),
      }),
    } as never,
  } as unknown as Env
}

afterEach(() => vi.unstubAllGlobals())

describe("Google Calendar OAuth", () => {
  it("requests only Calendar event and availability scopes", async () => {
    const response = await handleGoogleCalendarAuthStart(
      new Request("https://kipp.test/setup/google-calendar"),
      "kipp.test",
      environment(),
    )
    expect(response.status).toBe(302)
    const url = new URL(response.headers.get("location") ?? "")
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.events.freebusy",
    )
    expect(url.searchParams.get("access_type")).toBe("offline")
  })

  it("stores Calendar tokens in the Calendar namespace after a valid callback", async () => {
    const env = environment()
    const start = await handleGoogleCalendarAuthStart(
      new Request("https://kipp.test/setup/google-calendar"),
      "kipp.test",
      env,
    )
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? ""
    const cookieId = (start.headers.get("set-cookie") ?? "").match(/google-calendar-oauth-session=([^;]+)/)?.[1] ?? ""
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "calendar-token",
            expires_in: ONE_HOUR_IN_SECONDS,
            refresh_token: "refresh",
          }),
      }),
    )

    const result = await handleGoogleCalendarAuthCallback(
      "code",
      state,
      "kipp.test",
      env,
      new Request("https://kipp.test/auth/google-calendar/callback", {
        headers: { cookie: `google-calendar-oauth-session=${cookieId}` },
      }),
    )
    expect(result.status).toBe(200)
    const { tokens } = await createTokenVault(env, "google-calendar").readTokens()
    expect(tokens?.access_token).toBe("calendar-token")
  })
})
