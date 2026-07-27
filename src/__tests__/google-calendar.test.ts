import { afterEach, describe, expect, it, vi } from "vitest"
import { createGoogleCalendarClient } from "../integrations/google-calendar"
import { TokenVaultDO } from "../token-vault"
import { createTokenVault } from "../token-vault-client"
import type { Env } from "../types"

const ONE_HOUR_IN_SECONDS = 60 * 60
const EVENT = {
  id: "kipp-event-1",
  summary: "Call Jamie",
  start: "2026-07-28T19:00:00+05:30",
  end: "2026-07-28T19:30:00+05:30",
  timeZone: "Asia/Kolkata",
  reminderMinutes: 10,
  requestId: "request-1",
}

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

async function environment(): Promise<Env> {
  const vault = new TokenVaultDO(
    { storage: storage() } as never,
    {
      TOKEN_ENCRYPTION_KEY_IDS: "test",
      TOKEN_ENCRYPTION_KEY_test: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    } as never,
  )
  const env = {
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
  await createTokenVault(env, "google-calendar").writeTokens({
    access_token: "calendar-token",
    expires_in: ONE_HOUR_IN_SECONDS,
    created_at: new Date().toISOString(),
    refresh_token: "refresh-token",
  })
  return env
}

function response(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("Google Calendar client", () => {
  it("creates a private, opaque managed event with the requested reminder", async () => {
    const fetch = vi.fn().mockResolvedValue(response(200))
    vi.stubGlobal("fetch", fetch)

    await createGoogleCalendarClient(await environment()).createManagedEvent(EVENT)

    const request = fetch.mock.calls[0][1] as RequestInit
    expect(JSON.parse(request.body as string)).toMatchObject({
      id: EVENT.id,
      visibility: "private",
      transparency: "opaque",
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: EVENT.reminderMinutes }] },
      extendedProperties: { private: { "kipp.requestId": EVENT.requestId } },
    })
  })

  it("treats a conflict as success only when the matching managed event already exists", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(409))
      .mockResolvedValueOnce(
        response(200, { id: EVENT.id, extendedProperties: { private: { "kipp.requestId": EVENT.requestId } } }),
      )
    vi.stubGlobal("fetch", fetch)

    await expect(createGoogleCalendarClient(await environment()).createManagedEvent(EVENT)).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("verifies a managed event after an ambiguous transient write failure", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(
        response(200, { id: EVENT.id, extendedProperties: { private: { "kipp.requestId": EVENT.requestId } } }),
      )
    vi.stubGlobal("fetch", fetch)

    const creation = createGoogleCalendarClient(await environment()).createManagedEvent(EVENT)
    await expect(creation).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it("returns only primary-calendar busy intervals", async () => {
    const busy = [{ start: EVENT.start, end: EVENT.end }]
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(200, { calendars: { primary: { busy } } })))

    await expect(
      createGoogleCalendarClient(await environment()).getBusyIntervals(EVENT.start, EVENT.end),
    ).resolves.toEqual(busy)
  })
})
