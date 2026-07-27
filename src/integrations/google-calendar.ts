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
}

interface GoogleCalendarEventResponse {
  id?: string
  extendedProperties?: { private?: Record<string, string> }
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
}

export interface GoogleCalendarClient {
  getBusyIntervals(timeMin: string, timeMax: string): Promise<BusyInterval[]>
  findManagedEvent(id: string, requestId: string): Promise<boolean>
  createManagedEvent(event: ManagedCalendarEvent): Promise<void>
}

function tokenExpiry(tokens: GoogleCalendarTokens): number {
  return new Date(tokens.created_at).getTime() + tokens.expires_in * TOKEN_EXPIRY_UNIT_MS
}

function isGoogleCalendarTokens(tokens: GoogleCalendarTokens | null | unknown): tokens is GoogleCalendarTokens {
  return Boolean(
    tokens &&
      typeof tokens === "object" &&
      typeof (tokens as GoogleCalendarTokens).access_token === "string" &&
      typeof (tokens as GoogleCalendarTokens).created_at === "string" &&
      typeof (tokens as GoogleCalendarTokens).expires_in === "number",
  )
}

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
  ) {
    super(message)
  }
}

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

  async function findManagedEvent(id: string, requestId: string): Promise<boolean> {
    const response = await request(`/calendars/primary/events/${encodeURIComponent(id)}`, { method: "GET" })
    if (response.status === 404) return false
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

  return { getBusyIntervals, findManagedEvent, createManagedEvent }
}
