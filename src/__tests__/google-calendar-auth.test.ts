import { afterEach, describe, expect, it, vi } from "vitest"
import { TokenVaultDO } from "../core/token-vault"
import { createTokenVault } from "../core/token-vault-client"
import type { Env } from "../core/types"
import { GOOGLE_ACCOUNT_EMAIL_SCOPE, GOOGLE_CONTACTS_SCOPE } from "../integrations/google-access"
import { handleGoogleCalendarAuthCallback, handleGoogleCalendarAuthStart } from "../triggers/google-calendar-auth"

const ONE_HOUR_IN_SECONDS = 60 * 60
const CALENDAR_SCOPES =
  "https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.events.freebusy"
const CALENDAR_AND_CONTACTS_SCOPES = `${CALENDAR_SCOPES} ${GOOGLE_CONTACTS_SCOPE}`
const MEETING_SCOPES = `${CALENDAR_AND_CONTACTS_SCOPES} ${GOOGLE_ACCOUNT_EMAIL_SCOPE}`

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
  it("requests Calendar, Contacts, and account email access from the standard setup URL", async () => {
    const response = await handleGoogleCalendarAuthStart(
      new Request("https://kipp.test/setup/google-calendar"),
      "kipp.test",
      environment(),
    )
    expect(response.status).toBe(302)
    const url = new URL(response.headers.get("location") ?? "")
    expect(url.searchParams.get("scope")).toBe(MEETING_SCOPES)
    expect(url.searchParams.get("include_granted_scopes")).toBe("true")
    expect(url.searchParams.get("access_type")).toBe("offline")
  })

  it.each([
    "granted",
    "declined",
    "email declined",
    "refresh lacks scope",
  ])("verifies the full meeting grant when consent is %s", async (outcome) => {
    const env = environment()
    const vault = createTokenVault(env, "google-calendar")
    await vault.writeTokens({
      access_token: "existing-calendar",
      expires_in: ONE_HOUR_IN_SECONDS,
      created_at: new Date().toISOString(),
    })
    const start = await handleGoogleCalendarAuthStart(
      new Request("https://kipp.test/setup/google-calendar"),
      "kipp.test",
      env,
    )
    const location = new URL(start.headers.get("location") ?? "")
    const cookie = start.headers.get("set-cookie")?.split(";")[0]
    if (!cookie) throw new Error("Missing OAuth state cookie")
    const exchangedScope =
      outcome === "declined"
        ? CALENDAR_SCOPES
        : outcome === "email declined"
          ? CALENDAR_AND_CONTACTS_SCOPES
          : MEETING_SCOPES
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          access_token: "new-calendar",
          expires_in: ONE_HOUR_IN_SECONDS,
          refresh_token: "new-refresh",
          scope: exchangedScope,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: "refreshed-calendar",
          expires_in: ONE_HOUR_IN_SECONDS,
          scope: outcome === "granted" ? MEETING_SCOPES : CALENDAR_AND_CONTACTS_SCOPES,
        }),
      )
    vi.stubGlobal("fetch", fetch)

    const result = await handleGoogleCalendarAuthCallback(
      "code",
      location.searchParams.get("state") ?? "",
      "kipp.test",
      env,
      new Request("https://kipp.test/auth/google-calendar/callback", { headers: { cookie } }),
    )
    const { tokens } = await vault.readTokens()
    expect(result.status).toBe(outcome === "granted" ? 200 : 400)
    if (outcome === "granted") expect(await result.text()).toBe("Google Calendar and Contacts connected")
    expect(tokens?.access_token).toBe(outcome === "granted" ? "refreshed-calendar" : "existing-calendar")
    expect(fetch).toHaveBeenCalledTimes(exchangedScope === MEETING_SCOPES ? 2 : 1)
  })

  it("retains a newer consent grant when an earlier access token refresh finishes late", async () => {
    const vault = createTokenVault(environment(), "google-calendar")
    const initial = {
      access_token: "old-calendar",
      expires_in: ONE_HOUR_IN_SECONDS,
      created_at: new Date().toISOString(),
    }
    await vault.writeTokens(initial)
    await vault.writeTokens({ ...initial, access_token: "contacts-enabled", scope: GOOGLE_CONTACTS_SCOPE })
    await expect(
      vault.writeTokens({ ...initial, access_token: "late-refresh" }, initial.access_token),
    ).resolves.toEqual({
      ok: false,
      superseded: true,
    })
    await expect(vault.readTokens()).resolves.toMatchObject({
      tokens: { access_token: "contacts-enabled", scope: GOOGLE_CONTACTS_SCOPE },
    })
  })
})
