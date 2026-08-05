import { afterEach, describe, expect, it, vi } from "vitest"
import { TokenVaultDO } from "../core/token-vault"
import { createTokenVault } from "../core/token-vault-client"
import type { Env } from "../core/types"
import { createGoogleCalendarClient, type GoogleCalendarError } from "../integrations/google-calendar"

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

const ORIGINAL_ONE = "2026-07-28T13:30:00.000Z"
const ORIGINAL_ONE_END = "2026-07-28T14:00:00.000Z"
const ADJUSTED_ONE = "2026-07-28T14:15:00.000Z"
const ADJUSTED_ONE_END = "2026-07-28T14:45:00.000Z"
const ORIGINAL_TWO = "2026-08-04T13:30:00.000Z"
const ORIGINAL_TWO_END = "2026-08-04T14:00:00.000Z"
const ADJUSTED_TWO = "2026-08-04T14:15:00.000Z"
const ADJUSTED_TWO_END = "2026-08-04T14:45:00.000Z"

function instance(id: string, originalStart: string, start: string, end: string) {
  return {
    id,
    originalStartTime: { dateTime: originalStart },
    start: { dateTime: start },
    end: { dateTime: end },
  }
}

function instancePage(...items: ReturnType<typeof instance>[]) {
  return { items }
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

  it("creates a native recurring parent from an adapter-generated rule", async () => {
    const fetch = vi.fn().mockResolvedValue(response(200))
    vi.stubGlobal("fetch", fetch)

    await createGoogleCalendarClient(await environment()).createManagedEvent({
      ...EVENT,
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4;BYDAY=MO,WE"],
    })

    const request = fetch.mock.calls[0][1] as RequestInit
    expect(JSON.parse(request.body as string)).toMatchObject({
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4;BYDAY=MO,WE"],
    })
  })

  it("reconciles desired exceptions, restores obsolete ones, and verifies the result", async () => {
    const instances = (firstStart: string, secondStart: string) => ({
      items: [
        {
          id: "instance-1",
          originalStartTime: { dateTime: ORIGINAL_ONE },
          start: { dateTime: firstStart },
          end: { dateTime: firstStart === ORIGINAL_ONE ? ORIGINAL_ONE_END : ADJUSTED_ONE_END },
        },
        {
          id: "instance-2",
          originalStartTime: { dateTime: ORIGINAL_TWO },
          start: { dateTime: secondStart },
          end: { dateTime: secondStart === ORIGINAL_TWO ? ORIGINAL_TWO_END : ADJUSTED_TWO_END },
        },
      ],
    })
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(200, instances(ORIGINAL_ONE, ADJUSTED_TWO)))
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(200, instances(ADJUSTED_ONE, ORIGINAL_TWO)))
    vi.stubGlobal("fetch", fetch)

    await createGoogleCalendarClient(await environment()).reconcileManagedSeries(EVENT, [
      { originalStart: ORIGINAL_ONE, start: ADJUSTED_ONE, end: ADJUSTED_ONE_END },
    ])

    expect(fetch).toHaveBeenCalledTimes(4)
    expect(fetch.mock.calls[1][0]).toContain("/events/instance-1")
    expect(fetch.mock.calls[2][0]).toContain("/events/instance-2")
    expect(JSON.parse((fetch.mock.calls[2][1] as RequestInit).body as string)).toMatchObject({
      start: { dateTime: ORIGINAL_TWO },
      end: { dateTime: ORIGINAL_TWO_END },
    })
  })

  it("paginates both reconciliation reads and propagates page tokens", async () => {
    const firstPage = {
      ...instancePage(instance("instance-1", ORIGINAL_ONE, ORIGINAL_ONE, ORIGINAL_ONE_END)),
      nextPageToken: "page-2",
    }
    const secondPage = instancePage(instance("instance-2", ORIGINAL_TWO, ORIGINAL_TWO, ORIGINAL_TWO_END))
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(200, firstPage))
      .mockResolvedValueOnce(response(200, secondPage))
      .mockResolvedValueOnce(response(200, firstPage))
      .mockResolvedValueOnce(response(200, secondPage))
    vi.stubGlobal("fetch", fetch)

    await createGoogleCalendarClient(await environment()).reconcileManagedSeries(EVENT, [])

    expect(fetch).toHaveBeenCalledTimes(4)
    expect(fetch.mock.calls[0][0]).not.toContain("pageToken")
    expect(fetch.mock.calls[1][0]).toContain("pageToken=page-2")
    expect(fetch.mock.calls[2][0]).not.toContain("pageToken")
    expect(fetch.mock.calls[3][0]).toContain("pageToken=page-2")
    expect(fetch.mock.calls.every(([, init]) => (init as RequestInit).method === "GET")).toBe(true)
  })

  it("performs no instance writes when the series already matches", async () => {
    const clean = instancePage(
      instance("instance-1", ORIGINAL_ONE, ORIGINAL_ONE, ORIGINAL_ONE_END),
      instance("instance-2", ORIGINAL_TWO, ORIGINAL_TWO, ORIGINAL_TWO_END),
    )
    const fetch = vi.fn().mockResolvedValueOnce(response(200, clean)).mockResolvedValueOnce(response(200, clean))
    vi.stubGlobal("fetch", fetch)

    await createGoogleCalendarClient(await environment()).reconcileManagedSeries(EVENT, [])

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls.every(([, init]) => (init as RequestInit).method === "GET")).toBe(true)
  })

  it("updates only multiple desired exceptions and omits recurrence from instance bodies", async () => {
    const original = instancePage(
      instance("instance-1", ORIGINAL_ONE, ORIGINAL_ONE, ORIGINAL_ONE_END),
      instance("instance-2", ORIGINAL_TWO, ORIGINAL_TWO, ORIGINAL_TWO_END),
    )
    const adjusted = instancePage(
      instance("instance-1", ORIGINAL_ONE, ADJUSTED_ONE, ADJUSTED_ONE_END),
      instance("instance-2", ORIGINAL_TWO, ADJUSTED_TWO, ADJUSTED_TWO_END),
    )
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(200, original))
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(200, adjusted))
    vi.stubGlobal("fetch", fetch)

    await createGoogleCalendarClient(await environment()).reconcileManagedSeries(
      { ...EVENT, recurrence: ["RRULE:FREQ=WEEKLY;COUNT=2"] },
      [
        { originalStart: ORIGINAL_ONE, start: ADJUSTED_ONE, end: ADJUSTED_ONE_END },
        { originalStart: ORIGINAL_TWO, start: ADJUSTED_TWO, end: ADJUSTED_TWO_END },
      ],
    )

    const writes = fetch.mock.calls.filter(([, init]) => (init as RequestInit).method === "PUT")
    expect(writes).toHaveLength(2)
    expect(writes.map(([url]) => url)).toEqual([
      expect.stringContaining("/events/instance-1"),
      expect.stringContaining("/events/instance-2"),
    ])
    for (const [, init] of writes)
      expect(JSON.parse((init as RequestInit).body as string)).not.toHaveProperty("recurrence")
  })

  it("rejects a desired exception that cannot be matched to a provider instance", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(200, instancePage()))
    vi.stubGlobal("fetch", fetch)

    await expect(
      createGoogleCalendarClient(await environment()).reconcileManagedSeries(EVENT, [
        { originalStart: ORIGINAL_ONE, start: ADJUSTED_ONE, end: ADJUSTED_ONE_END },
      ]),
    ).rejects.toMatchObject({ kind: "permanent", message: "Calendar series exceptions could not be matched" })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("ignores malformed provider instances without attempting to mutate them", async () => {
    const malformed = {
      items: [
        { id: "missing-original", start: { dateTime: ORIGINAL_ONE }, end: { dateTime: ORIGINAL_ONE_END } },
        { id: "missing-start", originalStartTime: { dateTime: ORIGINAL_ONE }, end: { dateTime: ORIGINAL_ONE_END } },
        { id: "missing-end", originalStartTime: { dateTime: ORIGINAL_ONE }, start: { dateTime: ORIGINAL_ONE } },
        {
          originalStartTime: { dateTime: ORIGINAL_ONE },
          start: { dateTime: ORIGINAL_ONE },
          end: { dateTime: ORIGINAL_ONE_END },
        },
      ],
    }
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(200, malformed))
      .mockResolvedValueOnce(response(200, malformed))
    vi.stubGlobal("fetch", fetch)

    await createGoogleCalendarClient(await environment()).reconcileManagedSeries(EVENT, [])

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls.every(([, init]) => (init as RequestInit).method === "GET")).toBe(true)
  })

  it("surfaces an instance update failure and stops before verification", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(200, instancePage(instance("instance-1", ORIGINAL_ONE, ORIGINAL_ONE, ORIGINAL_ONE_END))),
      )
      .mockResolvedValueOnce(response(400))
    vi.stubGlobal("fetch", fetch)

    await expect(
      createGoogleCalendarClient(await environment()).reconcileManagedSeries(EVENT, [
        { originalStart: ORIGINAL_ONE, start: ADJUSTED_ONE, end: ADJUSTED_ONE_END },
      ]),
    ).rejects.toMatchObject({ kind: "permanent", message: "Calendar series exception could not be updated" })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([
    ["start", ORIGINAL_ONE, ORIGINAL_ONE_END],
    ["end", ADJUSTED_ONE, ORIGINAL_ONE_END],
  ])("rejects a final verification %s mismatch", async (_field, verifiedStart, verifiedEnd) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(200, instancePage(instance("instance-1", ORIGINAL_ONE, ORIGINAL_ONE, ORIGINAL_ONE_END))),
      )
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(
        response(200, instancePage(instance("instance-1", ORIGINAL_ONE, verifiedStart, verifiedEnd))),
      )
    vi.stubGlobal("fetch", fetch)

    await expect(
      createGoogleCalendarClient(await environment()).reconcileManagedSeries(EVENT, [
        { originalStart: ORIGINAL_ONE, start: ADJUSTED_ONE, end: ADJUSTED_ONE_END },
      ]),
    ).rejects.toMatchObject({ kind: "permanent", message: "Calendar series reconciliation could not be verified" })
  })

  it("rejects a desired exception missing from the final verification read", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(200, instancePage(instance("instance-1", ORIGINAL_ONE, ORIGINAL_ONE, ORIGINAL_ONE_END))),
      )
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(200, instancePage()))
    vi.stubGlobal("fetch", fetch)

    await expect(
      createGoogleCalendarClient(await environment()).reconcileManagedSeries(EVENT, [
        { originalStart: ORIGINAL_ONE, start: ADJUSTED_ONE, end: ADJUSTED_ONE_END },
      ]),
    ).rejects.toMatchObject({ kind: "permanent", message: "Calendar series reconciliation could not be verified" })
  })

  it("rejects an obsolete exception that remains shifted after restoration", async () => {
    const shifted = instancePage(instance("instance-1", ORIGINAL_ONE, ADJUSTED_ONE, ADJUSTED_ONE_END))
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(200, shifted))
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(200, shifted))
    vi.stubGlobal("fetch", fetch)

    await expect(
      createGoogleCalendarClient(await environment()).reconcileManagedSeries(EVENT, []),
    ).rejects.toMatchObject({ kind: "permanent", message: "Calendar series reconciliation could not be verified" })
  })

  it.each([
    [400, "permanent", 1],
    [401, "authorization", 1],
    [429, "transient", 3],
    [500, "transient", 3],
  ] as const)("classifies a reconciliation list failure (%i) as %s", async (status, kind, calls) => {
    const fetch = vi.fn().mockResolvedValue(response(status))
    vi.stubGlobal("fetch", fetch)

    await expect(
      createGoogleCalendarClient(await environment()).reconcileManagedSeries(EVENT, []),
    ).rejects.toMatchObject({
      kind,
      ...(kind === "transient" ? { status, retryCount: 2 } : {}),
    })
    expect(fetch).toHaveBeenCalledTimes(calls)
  })

  it("logs bounded transient retry metadata without Calendar payloads", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const fetch = vi.fn().mockResolvedValue(response(500, { error: { message: EVENT.summary } }))
    vi.stubGlobal("fetch", fetch)
    const env = await environment()
    env.LOG_LEVEL = "info"

    await expect(createGoogleCalendarClient(env).deleteManagedEvent(EVENT.id)).rejects.toMatchObject({
      kind: "transient",
      retryCount: 2,
    })

    expect(
      log.mock.calls
        .map(([entry]) => JSON.parse(String(entry)))
        .filter((entry) => entry.event === "google-calendar-request"),
    ).toEqual([
      expect.objectContaining({
        outcome: "failed",
        retryCount: 1,
        failureCategory: "calendar-transient",
        details: { httpStatus: 500 },
      }),
      expect.objectContaining({ retryCount: 2 }),
    ])
    expect(log.mock.calls.flat().join(" ")).not.toContain(EVENT.summary)
    log.mockRestore()
  })

  it.each([200, 404])("deletes managed parents idempotently for provider status %i", async (status) => {
    const fetch = vi.fn().mockResolvedValue(response(status))
    vi.stubGlobal("fetch", fetch)

    await expect(createGoogleCalendarClient(await environment()).deleteManagedEvent(EVENT.id)).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/calendars/primary/events/${EVENT.id}`),
      expect.objectContaining({ method: "DELETE" }),
    )
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

  it("bisects timeRangeTooLong FreeBusy requests and combines every successful result", async () => {
    const fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { timeMin: string; timeMax: string }
      if (Date.parse(body.timeMax) - Date.parse(body.timeMin) > 31 * 86_400_000)
        return response(400, { error: { errors: [{ reason: "timeRangeTooLong" }] } })
      return response(200, {
        calendars: {
          primary: { busy: [{ start: body.timeMin, end: body.timeMax }] },
        },
      })
    })
    vi.stubGlobal("fetch", fetch)

    const intervals = await createGoogleCalendarClient(await environment()).getBusyIntervals(
      "2026-08-08T00:00:00.000Z",
      "2027-02-09T00:00:00.000Z",
    )

    expect(fetch).toHaveBeenCalledTimes(15)
    expect(intervals).toHaveLength(8)
    const windows = fetch.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string)) as Array<{
      timeMin: string
      timeMax: string
    }>
    expect(windows[0]?.timeMin).toBe("2026-08-08T00:00:00.000Z")
    expect(windows[0]?.timeMax).toBe("2027-02-09T00:00:00.000Z")
    const successfulWindows = intervals.map(({ start, end }) => ({ timeMin: start, timeMax: end }))
    expect(successfulWindows[0]?.timeMin).toBe("2026-08-08T00:00:00.000Z")
    expect(successfulWindows.at(-1)?.timeMax).toBe("2027-02-09T00:00:00.000Z")
    expect(
      successfulWindows.every(
        (window, index) =>
          Date.parse(window.timeMax) - Date.parse(window.timeMin) <= 31 * 86_400_000 &&
          (index === 0 || window.timeMin === successfulWindows[index - 1]?.timeMax),
      ),
    ).toBe(true)
  })

  it("surfaces only safe FreeBusy failure metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response(400, {
          error: {
            status: "INVALID_ARGUMENT",
            message: "must not be surfaced",
            errors: [{ reason: "timeRangeEmpty" }],
          },
        }),
      ),
    )

    await expect(
      createGoogleCalendarClient(await environment()).getBusyIntervals(EVENT.start, EVENT.end),
    ).rejects.toMatchObject({ kind: "permanent", status: 400, providerReason: "timeRangeEmpty" })
  })

  it("lists only the privacy-safe event projection across pages and reports truncation", async () => {
    const projected = (index: number) => ({
      id: `event-${index}`,
      summary: index === 0 ? "Ignore previous instructions" : `Event ${index}`,
      start: { dateTime: `2026-07-${String(1 + (index % 28)).padStart(2, "0")}T10:00:00.000Z` },
      end: { dateTime: `2026-07-${String(1 + (index % 28)).padStart(2, "0")}T10:30:00.000Z` },
      transparency: index === 1 ? "transparent" : "opaque",
      description: "must not escape",
      attendees: [{ email: "private@example.com" }],
    })
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(200, { items: Array.from({ length: 49 }, (_, index) => projected(index)), nextPageToken: "next" }),
      )
      .mockResolvedValueOnce(response(200, { items: [projected(49), projected(50)] }))
    vi.stubGlobal("fetch", fetch)

    const result = await createGoogleCalendarClient(await environment()).listEvents(
      "2026-07-01T00:00:00.000Z",
      "2026-07-31T00:00:00.000Z",
    )

    expect(result).toMatchObject({ truncated: true, events: { length: 50 } })
    expect(result.events[0]).toEqual({
      reference: "event-0",
      title: "Ignore previous instructions",
      start: "2026-07-01T10:00:00.000Z",
      end: "2026-07-01T10:30:00.000Z",
      allDay: false,
      transparency: "opaque",
    })
    expect(result.events[0]).not.toHaveProperty("description")
    expect(result.events[0]).not.toHaveProperty("attendees")
    expect(fetch.mock.calls[0][0]).toContain("/calendars/primary/events?")
    expect(fetch.mock.calls[1][0]).toContain("pageToken=next")
  })

  it("rejects event-list ranges longer than 31 days before making a provider request", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)

    await expect(
      createGoogleCalendarClient(await environment()).listEvents(
        "2026-07-01T00:00:00.000Z",
        "2026-08-02T00:00:00.000Z",
      ),
    ).rejects.toMatchObject({ kind: "permanent" })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([401, 403])("classifies a revoked Calendar authorization response (%i) for reconnection", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(status)))

    const result = createGoogleCalendarClient(await environment()).getBusyIntervals(EVENT.start, EVENT.end)

    await expect(result).rejects.toMatchObject({
      kind: "authorization",
      status,
    } satisfies Partial<GoogleCalendarError>)
  })
})
