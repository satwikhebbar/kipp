import { HTTP_STATUS, isTransientHttpStatus } from "../runtime/http"
import { createTokenVault } from "../token-vault-client"
import { type Env, type GoogleCalendarTokens, TOKEN_PROVIDER } from "../types"

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
const GOOGLE_CALENDAR_API_URL = "https://www.googleapis.com/calendar/v3"
const REFRESH_SKEW_MS = 60_000
const MAX_TRANSIENT_RETRIES = 2
const RETRY_DELAY_MS = 250
const TOKEN_EXPIRY_UNIT_MS = 1_000
const PRIMARY_CALENDAR_ID = "primary"
const CALENDAR_EVENT_CONFLICT_STATUS = HTTP_STATUS.CONFLICT
const MANAGED_BY_PROPERTY = "kipp.managedBy"
const REQUEST_ID_PROPERTY = "kipp.requestId"
const SCHEMA_VERSION_PROPERTY = "kipp.schemaVersion"
const MANAGED_BY_VALUE = "calendar-agent"
const SCHEMA_VERSION = "1"
const PRIVATE_VISIBILITY = "private"
const OPAQUE_TRANSPARENCY = "opaque"
const POPUP_REMINDER_METHOD = "popup"
const MAX_CALENDAR_INSTANCES_PER_PAGE = "2500"
const MAX_VISIBLE_EVENTS = 50
const EVENT_LIST_FETCH_LIMIT = String(MAX_VISIBLE_EVENTS + 1)
const MAX_EVENT_LIST_RANGE_DAYS = 31
const MILLIS_PER_DAY = 86_400_000
const MAX_EVENT_LIST_RANGE_MS = MAX_EVENT_LIST_RANGE_DAYS * MILLIS_PER_DAY

export interface BusyInterval {
  start: string
  end: string
}

export interface ManagedCalendarEvent {
  id: string
  summary: string
  start: string
  end: string
  timeZone: string
  description?: string
  location?: string
  reminderMinutes: number
  requestId: string
  recurrence?: string[]
}

export interface ManagedCalendarException {
  originalStart: string
  start: string
  end: string
}

export interface CalendarEventProjection {
  reference: string
  title: string
  start: string
  end: string
  allDay: boolean
  transparency: "opaque" | "transparent"
}

export interface CalendarEventList {
  events: CalendarEventProjection[]
  truncated: boolean
}

interface ManagedCalendarInstance {
  id: string
  originalStart: string
  start: string
  end: string
}

interface GoogleCalendarEventResponse {
  id?: string
  summary?: string
  transparency?: "opaque" | "transparent"
  extendedProperties?: { private?: Record<string, string> }
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  originalStartTime?: { dateTime?: string }
}

interface GoogleCalendarInstancesResponse {
  items?: GoogleCalendarEventResponse[]
  nextPageToken?: string
}

interface GoogleCalendarEventsResponse {
  items?: GoogleCalendarEventResponse[]
  nextPageToken?: string
}

interface GoogleCalendarFreeBusyResponse {
  calendars?: Record<string, { busy?: BusyInterval[] }>
}

interface GoogleCalendarEventBody {
  id: string
  summary: string
  start: { dateTime: string; timeZone: string }
  end: { dateTime: string; timeZone: string }
  description?: string
  location?: string
  visibility: typeof PRIVATE_VISIBILITY
  transparency: typeof OPAQUE_TRANSPARENCY
  reminders: { useDefault: false; overrides: Array<{ method: typeof POPUP_REMINDER_METHOD; minutes: number }> }
  extendedProperties: { private: Record<string, string> }
  recurrence?: string[]
}

export interface GoogleCalendarClient {
  getBusyIntervals(timeMin: string, timeMax: string): Promise<BusyInterval[]>
  listEvents(timeMin: string, timeMax: string): Promise<CalendarEventList>
  findManagedEvent(id: string, requestId: string): Promise<boolean>
  createManagedEvent(event: ManagedCalendarEvent): Promise<void>
  updateManagedEvent(event: ManagedCalendarEvent): Promise<void>
  reconcileManagedSeries(event: ManagedCalendarEvent, exceptions: ManagedCalendarException[]): Promise<void>
  deleteManagedEvent(id: string): Promise<void>
}

/** Returns the epoch ms at which the token expires. */
function tokenExpiry(tokens: GoogleCalendarTokens): number {
  return new Date(tokens.created_at).getTime() + tokens.expires_in * TOKEN_EXPIRY_UNIT_MS
}

/** Type guard that validates a token object has the expected Google Calendar shape. */
function isGoogleCalendarTokens(tokens: GoogleCalendarTokens | null | unknown): tokens is GoogleCalendarTokens {
  return Boolean(
    tokens &&
      typeof tokens === "object" &&
      typeof (tokens as GoogleCalendarTokens).access_token === "string" &&
      typeof (tokens as GoogleCalendarTokens).created_at === "string" &&
      typeof (tokens as GoogleCalendarTokens).expires_in === "number",
  )
}

/** Builds the Google Calendar API event payload from a managed event. */
function calendarEventBody(event: ManagedCalendarEvent): GoogleCalendarEventBody {
  return {
    id: event.id,
    summary: event.summary,
    start: { dateTime: event.start, timeZone: event.timeZone },
    end: { dateTime: event.end, timeZone: event.timeZone },
    ...(event.description ? { description: event.description } : {}),
    ...(event.location ? { location: event.location } : {}),
    visibility: PRIVATE_VISIBILITY,
    transparency: OPAQUE_TRANSPARENCY,
    reminders: { useDefault: false, overrides: [{ method: POPUP_REMINDER_METHOD, minutes: event.reminderMinutes }] },
    ...(event.recurrence ? { recurrence: event.recurrence } : {}),
    extendedProperties: {
      private: {
        [MANAGED_BY_PROPERTY]: MANAGED_BY_VALUE,
        [REQUEST_ID_PROPERTY]: event.requestId,
        [SCHEMA_VERSION_PROPERTY]: SCHEMA_VERSION,
      },
    },
  }
}

export class GoogleCalendarError extends Error {
  constructor(
    message: string,
    readonly kind: "authorization" | "transient" | "permanent",
    /** Safe HTTP status when Google returned a response; response contents are never retained. */
    readonly status?: number,
  ) {
    super(message)
  }
}

/** Creates a Google Calendar API client with automatic token refresh. */
export function createGoogleCalendarClient(env: Env): GoogleCalendarClient {
  const vault = createTokenVault(env, TOKEN_PROVIDER.GOOGLE_CALENDAR)

  function credentials(): { clientId: string; clientSecret: string } {
    if (!env.GOOGLE_CALENDAR_CLIENT_ID || !env.GOOGLE_CALENDAR_CLIENT_SECRET)
      throw new GoogleCalendarError("Google Calendar is not configured", "permanent")
    return { clientId: env.GOOGLE_CALENDAR_CLIENT_ID, clientSecret: env.GOOGLE_CALENDAR_CLIENT_SECRET }
  }

  async function refreshTokens(tokens: GoogleCalendarTokens): Promise<GoogleCalendarTokens> {
    if (!tokens.refresh_token) throw new GoogleCalendarError("Google Calendar requires reconnection", "authorization")
    const { clientId, clientSecret } = credentials()
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    })
    if (!response.ok) throw new GoogleCalendarError("Google Calendar requires reconnection", "authorization")
    const data = (await response.json()) as { access_token?: string; expires_in?: number; scope?: string }
    if (!data.access_token || typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in))
      throw new GoogleCalendarError("Google Calendar requires reconnection", "authorization")
    const updated: GoogleCalendarTokens = {
      ...tokens,
      access_token: data.access_token,
      expires_in: data.expires_in,
      created_at: new Date().toISOString(),
      ...(data.scope ? { scope: data.scope } : {}),
    }
    const { ok } = await vault.writeTokens(updated)
    if (!ok) throw new GoogleCalendarError("Calendar credentials could not be stored", "permanent")
    return updated
  }

  async function accessToken(): Promise<string> {
    const { tokens } = await vault.readTokens()
    if (!isGoogleCalendarTokens(tokens))
      throw new GoogleCalendarError("Google Calendar is not connected", "authorization")
    const usable = tokenExpiry(tokens) > Date.now() + REFRESH_SKEW_MS ? tokens : await refreshTokens(tokens)
    return usable.access_token
  }

  async function request(path: string, init: RequestInit): Promise<Response> {
    let lastFailure: GoogleCalendarError | null = null
    for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
      try {
        const token = await accessToken()
        const response = await fetch(`${GOOGLE_CALENDAR_API_URL}${path}`, {
          ...init,
          headers: { Authorization: `Bearer ${token}`, ...init.headers },
        })
        if (response.status === HTTP_STATUS.UNAUTHORIZED || response.status === HTTP_STATUS.FORBIDDEN)
          throw new GoogleCalendarError("Google Calendar requires reconnection", "authorization", response.status)
        if (response.ok || !isTransientHttpStatus(response.status)) return response
        lastFailure = new GoogleCalendarError("Google Calendar is temporarily unavailable", "transient")
      } catch (error) {
        if (error instanceof GoogleCalendarError) throw error
        lastFailure = new GoogleCalendarError("Google Calendar is temporarily unavailable", "transient")
      }
      if (attempt < MAX_TRANSIENT_RETRIES)
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)))
    }
    throw lastFailure ?? new GoogleCalendarError("Google Calendar request failed", "permanent")
  }

  async function getBusyIntervals(timeMin: string, timeMax: string): Promise<BusyInterval[]> {
    const response = await request("/freeBusy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeMin, timeMax, items: [{ id: PRIMARY_CALENDAR_ID }] }),
    })
    if (!response.ok) throw new GoogleCalendarError("Calendar availability could not be read", "permanent")
    const data = (await response.json()) as GoogleCalendarFreeBusyResponse
    return data.calendars?.[PRIMARY_CALENDAR_ID]?.busy ?? []
  }

  async function listEvents(timeMin: string, timeMax: string): Promise<CalendarEventList> {
    const rangeStart = Date.parse(timeMin)
    const rangeEnd = Date.parse(timeMax)
    if (
      !Number.isFinite(rangeStart) ||
      !Number.isFinite(rangeEnd) ||
      rangeEnd <= rangeStart ||
      rangeEnd - rangeStart > MAX_EVENT_LIST_RANGE_MS
    )
      throw new GoogleCalendarError("Calendar event range is invalid", "permanent")

    const events: CalendarEventProjection[] = []
    let pageToken: string | undefined
    do {
      const query = new URLSearchParams({
        timeMin: new Date(rangeStart).toISOString(),
        timeMax: new Date(rangeEnd).toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        showDeleted: "false",
        maxResults: EVENT_LIST_FETCH_LIMIT,
      })
      if (pageToken) query.set("pageToken", pageToken)
      const response = await request(`/calendars/${PRIMARY_CALENDAR_ID}/events?${query.toString()}`, { method: "GET" })
      if (!response.ok) throw new GoogleCalendarError("Calendar events could not be read", "permanent")
      const data = (await response.json()) as GoogleCalendarEventsResponse
      for (const item of data.items ?? []) {
        const allDay = Boolean(item.start?.date && item.end?.date)
        const start = item.start?.dateTime ?? item.start?.date
        const end = item.end?.dateTime ?? item.end?.date
        if (!item.id || !start || !end) continue
        events.push({
          reference: item.id,
          title: item.summary ?? "(untitled)",
          start,
          end,
          allDay,
          transparency: item.transparency === "transparent" ? "transparent" : "opaque",
        })
        if (events.length > MAX_VISIBLE_EVENTS) break
      }
      pageToken = data.nextPageToken
    } while (pageToken && events.length <= MAX_VISIBLE_EVENTS)
    return {
      events: events.slice(0, MAX_VISIBLE_EVENTS),
      truncated: events.length > MAX_VISIBLE_EVENTS || Boolean(pageToken),
    }
  }

  async function findManagedEvent(id: string, requestId: string): Promise<boolean> {
    const response = await request(`/calendars/primary/events/${encodeURIComponent(id)}`, { method: "GET" })
    if (response.status === HTTP_STATUS.NOT_FOUND) return false
    if (!response.ok) throw new GoogleCalendarError("Calendar event could not be verified", "permanent")
    const data = (await response.json()) as GoogleCalendarEventResponse
    return data.id === id && data.extendedProperties?.private?.[REQUEST_ID_PROPERTY] === requestId
  }

  async function createManagedEvent(event: ManagedCalendarEvent): Promise<void> {
    try {
      const response = await request("/calendars/primary/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(calendarEventBody(event)),
      })
      if (response.ok) return
      if (response.status === CALENDAR_EVENT_CONFLICT_STATUS && (await findManagedEvent(event.id, event.requestId)))
        return
      throw new GoogleCalendarError("Calendar event could not be created", "permanent")
    } catch (error) {
      if (error instanceof GoogleCalendarError && error.kind === "transient") {
        if (await findManagedEvent(event.id, event.requestId)) return
      }
      throw error
    }
  }

  async function updateManagedEvent(event: ManagedCalendarEvent): Promise<void> {
    const response = await request(`/calendars/primary/events/${encodeURIComponent(event.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(calendarEventBody(event)),
    })
    if (!response.ok) throw new GoogleCalendarError("Calendar event could not be updated", "permanent")
  }

  async function listManagedInstances(parentId: string): Promise<ManagedCalendarInstance[]> {
    const instances: ManagedCalendarInstance[] = []
    let pageToken: string | undefined
    do {
      const query = new URLSearchParams({ maxResults: MAX_CALENDAR_INSTANCES_PER_PAGE, showDeleted: "false" })
      if (pageToken) query.set("pageToken", pageToken)
      const response = await request(
        `/calendars/primary/events/${encodeURIComponent(parentId)}/instances?${query.toString()}`,
        { method: "GET" },
      )
      if (!response.ok) throw new GoogleCalendarError("Calendar series instances could not be read", "permanent")
      const data = (await response.json()) as GoogleCalendarInstancesResponse
      for (const item of data.items ?? []) {
        const originalStart = item.originalStartTime?.dateTime
        const start = item.start?.dateTime
        const end = item.end?.dateTime
        if (item.id && originalStart && start && end) instances.push({ id: item.id, originalStart, start, end })
      }
      pageToken = data.nextPageToken
    } while (pageToken)
    return instances
  }

  async function updateManagedInstance(
    parent: ManagedCalendarEvent,
    instanceId: string,
    start: string,
    end: string,
  ): Promise<void> {
    const instanceEvent: ManagedCalendarEvent = { ...parent, id: instanceId, start, end, recurrence: undefined }
    const response = await request(`/calendars/primary/events/${encodeURIComponent(instanceId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(calendarEventBody(instanceEvent)),
    })
    if (!response.ok) throw new GoogleCalendarError("Calendar series exception could not be updated", "permanent")
  }

  async function reconcileManagedSeries(
    event: ManagedCalendarEvent,
    exceptions: ManagedCalendarException[],
  ): Promise<void> {
    const requested = new Map(exceptions.map((exception) => [Date.parse(exception.originalStart), exception]))
    const desired = new Map(requested)
    const instances = await listManagedInstances(event.id)
    const duration = Date.parse(event.end) - Date.parse(event.start)
    for (const instance of instances) {
      const key = Date.parse(instance.originalStart)
      const exception = desired.get(key)
      if (exception) {
        await updateManagedInstance(event, instance.id, exception.start, exception.end)
        desired.delete(key)
        continue
      }
      if (Date.parse(instance.start) !== key) {
        await updateManagedInstance(
          event,
          instance.id,
          new Date(key).toISOString(),
          new Date(key + duration).toISOString(),
        )
      }
    }
    if (desired.size) throw new GoogleCalendarError("Calendar series exceptions could not be matched", "permanent")
    const verified = await listManagedInstances(event.id)
    const verifiedKeys = new Set<number>()
    for (const instance of verified) {
      const key = Date.parse(instance.originalStart)
      const exception = requested.get(key)
      verifiedKeys.add(key)
      if (
        exception
          ? Date.parse(instance.start) !== Date.parse(exception.start) ||
            Date.parse(instance.end) !== Date.parse(exception.end)
          : Date.parse(instance.start) !== key
      )
        throw new GoogleCalendarError("Calendar series reconciliation could not be verified", "permanent")
    }
    if ([...requested.keys()].some((key) => !verifiedKeys.has(key)))
      throw new GoogleCalendarError("Calendar series reconciliation could not be verified", "permanent")
  }

  async function deleteManagedEvent(id: string): Promise<void> {
    const response = await request(`/calendars/primary/events/${encodeURIComponent(id)}`, { method: "DELETE" })
    if (!response.ok && response.status !== HTTP_STATUS.NOT_FOUND)
      throw new GoogleCalendarError("Calendar event could not be removed", "permanent")
  }

  return {
    getBusyIntervals,
    listEvents,
    findManagedEvent,
    createManagedEvent,
    updateManagedEvent,
    reconcileManagedSeries,
    deleteManagedEvent,
  }
}
