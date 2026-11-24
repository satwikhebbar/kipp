import { calendarDayBounds } from "../calendar/scheduling"
import { isCalendarAttendeeEmail, MAX_EVENT_LIST_RANGE_MS } from "../calendar/validation"
import { createTokenVault } from "../core/token-vault-client"
import { type Env, type GoogleCalendarTokens, TOKEN_PROVIDER } from "../core/types"
import { HTTP_STATUS, isTransientHttpStatus } from "../runtime/http"
import { logRuntime } from "../runtime/logging"
import { GOOGLE_ACCOUNT_EMAIL_SCOPE, GOOGLE_CONTACTS_SCOPE, hasGoogleScope, refreshGoogleAccess } from "./google-access"

const GOOGLE_CALENDAR_API_URL = "https://www.googleapis.com/calendar/v3"
const GOOGLE_CONTACT_SEARCH_URL = "https://people.googleapis.com/v1/people:searchContacts"
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"
const CONTACT_SEARCH_WARMUP_MS = 5_000
const REFRESH_SKEW_MS = 60_000
const MAX_TRANSIENT_RETRIES = 2
const RETRY_DELAY_MS = 250
/** Prevents an unavailable upstream Calendar API from leaving a Workflow run indefinitely active. */
const GOOGLE_CALENDAR_REQUEST_TIMEOUT_MS = 10_000
const TOKEN_EXPIRY_UNIT_MS = 1_000
const PRIMARY_CALENDAR_ID = "primary"
const CALENDAR_EVENT_CONFLICT_STATUS = HTTP_STATUS.CONFLICT
const MANAGED_BY_PROPERTY = "kipp.managedBy"
const REQUEST_ID_PROPERTY = "kipp.requestId"
const SCHEMA_VERSION_PROPERTY = "kipp.schemaVersion"
const MEETING_PROPERTY = "kipp.meeting"
const MANAGED_BY_VALUE = "calendar-agent"
const SCHEMA_VERSION = "1"
const PRIVATE_VISIBILITY = "private"
const OPAQUE_TRANSPARENCY = "opaque"
const POPUP_REMINDER_METHOD = "popup"
const MAX_CALENDAR_INSTANCES_PER_PAGE = "2500"
const MAX_VISIBLE_EVENTS = 50
const EVENT_LIST_FETCH_LIMIT = String(MAX_VISIBLE_EVENTS + 1)
const MILLIS_PER_DAY = 86_400_000
const MIN_FREEBUSY_SPLIT_RANGE_MS = MILLIS_PER_DAY
const GOOGLE_TIME_RANGE_TOO_LONG = "timeRangeTooLong"

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

export interface CalendarAttendee {
  name?: string
  email: string
}

export type ContactSearchResult =
  | { kind: "found"; attendees: CalendarAttendee[] }
  | { kind: "needs_consent" | "unavailable" }

export interface SavedMeeting {
  etag?: string
  calendarUrl?: string
  meetUrl?: string
  conference: "ready" | "pending" | "failed"
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

/** Minimal workflow-owned snapshot of an existing event overlapping the requested time. */
export interface ConflictEventSnapshot {
  id: string
  title: string
  start: string
  end: string
  allDay: boolean
  etag: string
  /** Server-side only: whether a single non-recurring, non-all-day event may be rescheduled. */
  movable: boolean
}

export type ExistingEventUpdateReason = "precondition-failed" | "not-found" | "authorization" | "permanent"

export type ExistingEventUpdateResult = { ok: true; etag?: string } | { ok: false; reason: ExistingEventUpdateReason }

interface ExistingEventRead {
  id: string
  start: string
  end: string
  allDay: boolean
  etag?: string
  timeZone?: string
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
  description?: string
  location?: string
  visibility?: string
  transparency?: "opaque" | "transparent"
  recurrence?: string[]
  reminders?: { useDefault?: boolean; overrides?: Array<{ method?: string; minutes?: number }> }
  extendedProperties?: { private?: Record<string, string> }
  start?: { dateTime?: string; date?: string; timeZone?: string }
  end?: { dateTime?: string; date?: string; timeZone?: string }
  originalStartTime?: { dateTime?: string }
  etag?: string
  organizer?: { email?: string; self?: boolean }
  attendees?: Array<{ email?: string; organizer?: boolean }>
  attendeesOmitted?: boolean
  guestsCanModify?: boolean
  htmlLink?: string
  conferenceData?: {
    createRequest?: { requestId?: string; status?: { statusCode?: string } }
    entryPoints?: Array<{ entryPointType?: string; uri?: string }>
  }
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
  searchContacts(name: string): Promise<ContactSearchResult>
  createMeeting(event: ManagedCalendarEvent, attendees: CalendarAttendee[]): Promise<void>
  readMeeting(event: ManagedCalendarEvent, attendees: CalendarAttendee[]): Promise<SavedMeeting>
  updateMeeting(event: ManagedCalendarEvent, attendees: CalendarAttendee[], expectedEtag: string): Promise<void>
  reconcileManagedSeries(event: ManagedCalendarEvent, exceptions: ManagedCalendarException[]): Promise<void>
  deleteManagedEvent(id: string): Promise<void>
  findConflictingEvents(
    timeMin: string,
    timeMax: string,
    requestedStart: string,
    requestedEnd: string,
    timeZone: string,
  ): Promise<ConflictEventSnapshot[]>
  moveExistingEvent(id: string, start: string, end: string, expectedEtag?: string): Promise<ExistingEventUpdateResult>
}

/** Compares only organizer-owned fields that Kipp can approve for a meeting edit. */
function matchesMeetingTimeAndTitle(saved: GoogleCalendarEventResponse, event: ManagedCalendarEvent): boolean {
  return (
    saved.summary === event.summary &&
    sameInstant(saved.start?.dateTime ?? "", event.start) &&
    sameInstant(saved.end?.dateTime ?? "", event.end)
  )
}

/** Exposes only Google-owned HTTPS links to Telegram. */
function googleEventLink(value: string | undefined, host: string): string | undefined {
  if (!value) return undefined
  const url = URL.parse(value)
  return url?.protocol === "https:" && url.hostname === host && !url.username && !url.password ? value : undefined
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

/** Returns the epoch ms for a provider event boundary; all-day dates are interpreted in the calendar time zone. */
function eventInstantMs(value: string, allDay: boolean, timeZone: string): number | null {
  if (!allDay) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  // Midnight can be skipped by a DST transition; the day's first instant is the correct fallback.
  const bounds = calendarDayBounds(value, timeZone)
  return bounds ? Date.parse(bounds.timeMin) : null
}

/** Compares two provider timestamps as instants so differing UTC offsets still match. */
function sameInstant(left: string, right: string): boolean {
  return Date.parse(left) === Date.parse(right)
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
    /** Sanitized Google error reason token; never contains the provider message or request data. */
    readonly providerReason?: string,
    /** Number of retry attempts already made; metadata only. */
    readonly retryCount = 0,
  ) {
    super(message)
  }
}

/** Confirms an uncertain PUT only when all managed fields match the intended write. */
function matchesManagedUpdate(saved: GoogleCalendarEventResponse, expected: GoogleCalendarEventBody): boolean {
  const overrides = saved.reminders?.overrides
  return (
    saved.id === expected.id &&
    saved.summary === expected.summary &&
    (saved.description ?? "") === (expected.description ?? "") &&
    (saved.location ?? "") === (expected.location ?? "") &&
    saved.visibility === expected.visibility &&
    saved.transparency === expected.transparency &&
    Date.parse(saved.start?.dateTime ?? "") === Date.parse(expected.start.dateTime) &&
    Date.parse(saved.end?.dateTime ?? "") === Date.parse(expected.end.dateTime) &&
    saved.start?.timeZone === expected.start.timeZone &&
    saved.end?.timeZone === expected.end.timeZone &&
    saved.reminders?.useDefault === false &&
    overrides?.length === 1 &&
    overrides[0].method === POPUP_REMINDER_METHOD &&
    overrides[0].minutes === expected.reminders.overrides[0].minutes &&
    JSON.stringify(saved.recurrence ?? []) === JSON.stringify(expected.recurrence ?? []) &&
    Object.entries(expected.extendedProperties.private).every(
      ([key, value]) => saved.extendedProperties?.private?.[key] === value,
    )
  )
}

/** Reads only Google's bounded machine reason/status token from an error response. */
async function googleErrorReason(response: Response): Promise<string | undefined> {
  try {
    const data = (await response.json()) as {
      error?: { status?: unknown; errors?: Array<{ reason?: unknown }> }
    }
    const candidate = data.error?.errors?.[0]?.reason ?? data.error?.status
    return typeof candidate === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

/** Creates a Google Calendar API client with automatic token refresh. */
export function createGoogleCalendarClient(env: Env): GoogleCalendarClient {
  const vault = createTokenVault(env, TOKEN_PROVIDER.GOOGLE_CALENDAR)

  async function refreshTokens(tokens: GoogleCalendarTokens): Promise<GoogleCalendarTokens> {
    if (!env.GOOGLE_CALENDAR_CLIENT_ID || !env.GOOGLE_CALENDAR_CLIENT_SECRET)
      throw new GoogleCalendarError("Google Calendar is not configured", "permanent")
    const updated = await refreshGoogleAccess(env, tokens)
    if (!updated) throw new GoogleCalendarError("Google Calendar requires reconnection", "authorization")
    const { ok, superseded } = await vault.writeTokens(updated, tokens.access_token)
    if (superseded) {
      const latest = (await vault.readTokens()).tokens
      if (isGoogleCalendarTokens(latest) && tokenExpiry(latest) > Date.now()) return latest
    }
    if (!ok) throw new GoogleCalendarError("Calendar credentials could not be stored", "permanent")
    return updated
  }

  async function usableTokens(): Promise<GoogleCalendarTokens> {
    const { tokens } = await vault.readTokens()
    if (!isGoogleCalendarTokens(tokens))
      throw new GoogleCalendarError("Google Calendar is not connected", "authorization")
    return tokenExpiry(tokens) > Date.now() + REFRESH_SKEW_MS ? tokens : refreshTokens(tokens)
  }

  function request(path: string, init: RequestInit): Promise<Response> {
    return requestUrl(`${GOOGLE_CALENDAR_API_URL}${path}`, init)
  }

  async function requestUrl(url: string, init: RequestInit, accessToken?: string): Promise<Response> {
    let lastFailure: GoogleCalendarError | null = null
    for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
      try {
        const token = accessToken ?? (await usableTokens()).access_token
        const response = await fetch(url, {
          ...init,
          headers: { Authorization: `Bearer ${token}`, ...init.headers },
          signal: AbortSignal.timeout(GOOGLE_CALENDAR_REQUEST_TIMEOUT_MS),
        })
        if (response.status === HTTP_STATUS.UNAUTHORIZED || response.status === HTTP_STATUS.FORBIDDEN)
          throw new GoogleCalendarError("Google Calendar requires reconnection", "authorization", response.status)
        if (response.ok || !isTransientHttpStatus(response.status)) return response
        lastFailure = new GoogleCalendarError(
          "Google Calendar is temporarily unavailable",
          "transient",
          response.status,
          undefined,
          attempt,
        )
      } catch (error) {
        if (error instanceof GoogleCalendarError) {
          if (error.kind !== "transient") throw error
          lastFailure = new GoogleCalendarError(error.message, error.kind, error.status, error.providerReason, attempt)
        } else
          lastFailure = new GoogleCalendarError(
            "Google Calendar is temporarily unavailable",
            "transient",
            undefined,
            undefined,
            attempt,
          )
      }
      if (attempt < MAX_TRANSIENT_RETRIES) {
        logRuntime(env, {
          event: "google-calendar-request",
          outcome: "failed",
          retryCount: attempt + 1,
          failureCategory: "calendar-transient",
          details: { httpStatus: lastFailure.status ?? -1 },
        })
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)))
      }
    }
    throw lastFailure ?? new GoogleCalendarError("Google Calendar request failed", "permanent")
  }

  /** Searches saved Google Contacts with a names-and-addresses projection. */
  async function searchContacts(name: string): Promise<ContactSearchResult> {
    try {
      const tokens = await usableTokens()
      if (!hasGoogleScope(tokens.scope, GOOGLE_CONTACTS_SCOPE)) return { kind: "needs_consent" }
      const query = (value: string) => {
        const params = new URLSearchParams({ query: value, readMask: "names,emailAddresses", pageSize: "10" })
        return fetch(`${GOOGLE_CONTACT_SEARCH_URL}?${params}`, {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
          signal: AbortSignal.timeout(GOOGLE_CALENDAR_REQUEST_TIMEOUT_MS),
        })
      }
      const warmup = await query("")
      await warmup.body?.cancel()
      if (!warmup.ok) return { kind: "unavailable" }
      // The People API refreshes its search cache asynchronously after warmup.
      await new Promise((resolve) => setTimeout(resolve, CONTACT_SEARCH_WARMUP_MS))
      const response = await query(name)
      if (!response.ok) return { kind: "unavailable" }
      const data = (await response.json()) as {
        results?: Array<{
          person?: { names?: Array<{ displayName?: string }>; emailAddresses?: Array<{ value?: string }> }
        }>
      }
      const attendees = new Map<string, CalendarAttendee>()
      for (const { person } of data.results ?? []) {
        const displayName = person?.names?.[0]?.displayName
        for (const address of person?.emailAddresses ?? []) {
          const email = address.value?.trim()
          if (email && isCalendarAttendeeEmail(email) && !attendees.has(email.toLowerCase()))
            attendees.set(email.toLowerCase(), { email, ...(displayName ? { name: displayName } : {}) })
        }
      }
      return { kind: "found", attendees: [...attendees.values()] }
    } catch {
      return { kind: "unavailable" }
    }
  }

  /** Verifies ownership and recipients on the organizer's copy of a saved Meet invitation. */
  async function readMeetingEvent(event: ManagedCalendarEvent, attendees: CalendarAttendee[], accessToken?: string) {
    const response = await requestUrl(
      `${GOOGLE_CALENDAR_API_URL}/calendars/primary/events/${encodeURIComponent(event.id)}`,
      { method: "GET" },
      accessToken,
    )
    if (!response.ok) throw new GoogleCalendarError("Meeting could not be verified", "permanent")
    const saved = (await response.json()) as GoogleCalendarEventResponse
    const expected = attendees.map((attendee) => attendee.email.toLowerCase()).sort()
    const organizerEmail = saved.organizer?.self ? saved.organizer.email?.toLowerCase() : undefined
    const actual = saved.attendees
      ?.filter(({ email, organizer }) => {
        const address = email?.toLowerCase()
        return !(organizer && address && address === organizerEmail && !expected.includes(address))
      })
      .map(({ email }) => email?.toLowerCase())
      .sort()
    if (
      saved.id !== event.id ||
      saved.extendedProperties?.private?.[REQUEST_ID_PROPERTY] !== event.requestId ||
      saved.extendedProperties?.private?.[MEETING_PROPERTY] !== "meet" ||
      saved.guestsCanModify === true ||
      saved.attendeesOmitted ||
      JSON.stringify(actual) !== JSON.stringify(expected)
    )
      throw new GoogleCalendarError("Meeting recipients or permissions changed", "permanent")
    return saved
  }

  /** Creates one invitation and reconciles ambiguous inserts with the same event ID. */
  async function createMeeting(event: ManagedCalendarEvent, attendees: CalendarAttendee[]): Promise<void> {
    const tokens = await usableTokens()
    if (!hasGoogleScope(tokens.scope, GOOGLE_ACCOUNT_EMAIL_SCOPE))
      throw new GoogleCalendarError("Google Account email access requires reconnection", "authorization")
    const profileResponse = await requestUrl(GOOGLE_USERINFO_URL, { method: "GET" }, tokens.access_token)
    if (!profileResponse.ok) throw new GoogleCalendarError("Google Account email could not be read", "permanent")
    const { email, verified_email } = (await profileResponse.json()) as { email?: unknown; verified_email?: unknown }
    if (verified_email !== true || typeof email !== "string" || !isCalendarAttendeeEmail(email))
      throw new GoogleCalendarError("Google Account email could not be verified", "permanent")
    const guests = attendees.filter((attendee) => attendee.email.toLowerCase() !== email.toLowerCase())
    const body = calendarEventBody(event)
    body.extendedProperties.private[MEETING_PROPERTY] = "meet"
    try {
      const response = await requestUrl(
        `${GOOGLE_CALENDAR_API_URL}/calendars/primary/events?sendUpdates=all&conferenceDataVersion=1`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...body,
            attendees: [{ email, responseStatus: "accepted" }, ...guests.map(({ email }) => ({ email }))],
            guestsCanModify: false,
            conferenceData: { createRequest: { requestId: event.id, conferenceSolutionKey: { type: "hangoutsMeet" } } },
          }),
        },
        tokens.access_token,
      )
      if (response.ok) return
      if (response.status !== CALENDAR_EVENT_CONFLICT_STATUS)
        throw new GoogleCalendarError("Meeting could not be created", "permanent")
    } catch (error) {
      if (!(error instanceof GoogleCalendarError) || error.kind !== "transient") throw error
    }
    const saved = await readMeetingEvent(event, attendees, tokens.access_token)
    // Google can omit default fields or normalize time zones. Verify the substantive approved projection.
    if (
      !matchesMeetingTimeAndTitle(saved, event) ||
      saved.transparency === "transparent" ||
      (saved.description ?? "") !== (event.description ?? "") ||
      (saved.location ?? "") !== (event.location ?? "")
    )
      throw new GoogleCalendarError("Meeting could not be verified", "permanent")
  }

  /** Reads Meet status from the existing event without resending its invitation. */
  async function readMeeting(event: ManagedCalendarEvent, attendees: CalendarAttendee[]): Promise<SavedMeeting> {
    const saved = await readMeetingEvent(event, attendees)
    if (!matchesMeetingTimeAndTitle(saved, event))
      throw new GoogleCalendarError("Meeting time or title changed", "permanent")
    const video = saved.conferenceData?.entryPoints?.find((point) => point.entryPointType === "video")
    const meetUrl = googleEventLink(video?.uri, "meet.google.com")
    return {
      etag: saved.etag,
      calendarUrl: googleEventLink(saved.htmlLink, "calendar.google.com"),
      meetUrl,
      conference: meetUrl
        ? "ready"
        : saved.conferenceData?.createRequest?.status?.statusCode === "failure"
          ? "failed"
          : "pending",
    }
  }

  /** Edits only the approved title/time, preserving RSVP, Meet and guest permissions. */
  async function updateMeeting(event: ManagedCalendarEvent, attendees: CalendarAttendee[], expectedEtag: string) {
    const current = await readMeetingEvent(event, attendees)
    if (matchesMeetingTimeAndTitle(current, event)) return
    if (current.etag !== expectedEtag)
      throw new GoogleCalendarError("Meeting changed while awaiting approval", "permanent")
    const { summary, start, end } = calendarEventBody(event)
    try {
      const response = await request(
        `/calendars/primary/events/${encodeURIComponent(event.id)}?sendUpdates=all&conferenceDataVersion=1`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "If-Match": expectedEtag },
          body: JSON.stringify({ summary, start, end }),
        },
      )
      if (response.ok) return
      if (response.status !== HTTP_STATUS.PRECONDITION_FAILED)
        throw new GoogleCalendarError("Meeting could not be updated", "permanent")
    } catch (error) {
      if (!(error instanceof GoogleCalendarError) || error.kind !== "transient") throw error
    }
    const saved = await readMeetingEvent(event, attendees)
    if (!matchesMeetingTimeAndTitle(saved, event))
      throw new GoogleCalendarError("Meeting update could not be verified", "permanent")
  }

  async function getBusyWindow(timeMin: string, timeMax: string): Promise<BusyInterval[]> {
    const response = await request("/freeBusy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeMin, timeMax, items: [{ id: PRIMARY_CALENDAR_ID }] }),
    })
    if (!response.ok)
      throw new GoogleCalendarError(
        "Calendar availability could not be read",
        "permanent",
        response.status,
        await googleErrorReason(response),
      )
    const data = (await response.json()) as GoogleCalendarFreeBusyResponse
    return data.calendars?.[PRIMARY_CALENDAR_ID]?.busy ?? []
  }

  /** Bisects an availability request only when Google reports its undocumented range limit. */
  async function getBusyRange(rangeStart: number, rangeEnd: number): Promise<BusyInterval[]> {
    try {
      return await getBusyWindow(new Date(rangeStart).toISOString(), new Date(rangeEnd).toISOString())
    } catch (error) {
      if (
        !(error instanceof GoogleCalendarError) ||
        error.providerReason !== GOOGLE_TIME_RANGE_TOO_LONG ||
        rangeEnd - rangeStart <= MIN_FREEBUSY_SPLIT_RANGE_MS
      )
        throw error
      const midpoint = rangeStart + Math.floor((rangeEnd - rangeStart) / 2)
      const [earlier, later] = await Promise.all([getBusyRange(rangeStart, midpoint), getBusyRange(midpoint, rangeEnd)])
      return [...earlier, ...later]
    }
  }

  /** Reads availability without relying on an undocumented Google maximum interval. */
  async function getBusyIntervals(timeMin: string, timeMax: string): Promise<BusyInterval[]> {
    const rangeStart = Date.parse(timeMin)
    const rangeEnd = Date.parse(timeMax)
    if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeEnd <= rangeStart)
      throw new GoogleCalendarError("Calendar availability range is invalid", "permanent")

    return getBusyRange(rangeStart, rangeEnd)
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
      if (!response.ok)
        throw new GoogleCalendarError(
          "Calendar events could not be read",
          "permanent",
          response.status,
          await googleErrorReason(response),
        )
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
    return putManagedEvent(event, "Calendar event could not be updated")
  }

  /** Repeats the same PUT safely and verifies its projection after an ambiguous failure. */
  async function putManagedEvent(event: ManagedCalendarEvent, failureMessage: string): Promise<void> {
    const path = `/calendars/primary/events/${encodeURIComponent(event.id)}`
    const body = calendarEventBody(event)
    try {
      const response = await request(path, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new GoogleCalendarError(failureMessage, "permanent")
    } catch (error) {
      if (error instanceof GoogleCalendarError && error.kind === "transient") {
        const verification = await request(path, { method: "GET" })
        if (verification.ok && matchesManagedUpdate((await verification.json()) as GoogleCalendarEventResponse, body))
          return
      }
      throw error
    }
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
    await putManagedEvent(instanceEvent, "Calendar series exception could not be updated")
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

  /** Returns a fresh read of one existing event carrying its current ETag and timezone, or null when gone. */
  async function readExistingEvent(id: string): Promise<ExistingEventRead | null> {
    const response = await request(`/calendars/primary/events/${encodeURIComponent(id)}`, { method: "GET" })
    if (response.status === HTTP_STATUS.NOT_FOUND) return null
    if (!response.ok) throw new GoogleCalendarError("Calendar event could not be read", "permanent")
    const data = (await response.json()) as GoogleCalendarEventResponse
    const start = data.start?.dateTime ?? data.start?.date
    const end = data.end?.dateTime ?? data.end?.date
    if (!data.id || !start || !end) return null
    return {
      id: data.id,
      start,
      end,
      allDay: Boolean(data.start?.date && data.end?.date),
      etag: data.etag,
      timeZone: data.start?.timeZone,
    }
  }

  /** Reads every primary-calendar event overlapping the requested interval with the workflow-only snapshot fields. */
  async function findConflictingEvents(
    timeMin: string,
    timeMax: string,
    requestedStart: string,
    requestedEnd: string,
    timeZone: string,
  ): Promise<ConflictEventSnapshot[]> {
    const rangeStart = Date.parse(timeMin)
    const rangeEnd = Date.parse(timeMax)
    const requestedStartMs = Date.parse(requestedStart)
    const requestedEndMs = Date.parse(requestedEnd)
    if (
      !Number.isFinite(rangeStart) ||
      !Number.isFinite(rangeEnd) ||
      rangeEnd <= rangeStart ||
      rangeEnd - rangeStart > MAX_EVENT_LIST_RANGE_MS ||
      !Number.isFinite(requestedStartMs) ||
      !Number.isFinite(requestedEndMs) ||
      requestedEndMs <= requestedStartMs
    )
      throw new GoogleCalendarError("Calendar event range is invalid", "permanent")

    const snapshots: ConflictEventSnapshot[] = []
    let pageToken: string | undefined
    do {
      const query = new URLSearchParams({
        timeMin: new Date(rangeStart).toISOString(),
        timeMax: new Date(rangeEnd).toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        showDeleted: "false",
        maxResults: MAX_CALENDAR_INSTANCES_PER_PAGE,
      })
      if (pageToken) query.set("pageToken", pageToken)
      const response = await request(`/calendars/primary/events?${query.toString()}`, { method: "GET" })
      if (!response.ok) throw new GoogleCalendarError("Calendar events could not be read", "permanent")
      const data = (await response.json()) as GoogleCalendarEventsResponse
      for (const item of data.items ?? []) {
        const allDay = Boolean(item.start?.date && item.end?.date)
        const start = item.start?.dateTime ?? item.start?.date
        const end = item.end?.dateTime ?? item.end?.date
        if (!item.id || !start || !end) continue
        const startMs = eventInstantMs(start, allDay, timeZone)
        const endMs = eventInstantMs(end, allDay, timeZone)
        if (startMs === null || endMs === null) continue
        if (!(startMs < requestedEndMs && endMs > requestedStartMs)) continue
        snapshots.push({
          id: item.id,
          title: item.summary ?? "(untitled)",
          start,
          end,
          allDay,
          etag: item.etag ?? "",
          movable:
            !item.recurrence &&
            !item.originalStartTime &&
            !allDay &&
            Boolean(item.etag) &&
            !item.attendees?.length &&
            !item.attendeesOmitted &&
            !item.extendedProperties?.private?.[MEETING_PROPERTY],
        })
        if (snapshots.length >= MAX_VISIBLE_EVENTS) break
      }
      pageToken = snapshots.length >= MAX_VISIBLE_EVENTS ? undefined : data.nextPageToken
    } while (pageToken)
    return snapshots
  }

  /** ETag-guarded patch that changes only start/end and verifies-by-read on an uncertain write. */
  async function moveExistingEvent(
    id: string,
    start: string,
    end: string,
    expectedEtag?: string,
  ): Promise<ExistingEventUpdateResult> {
    let current: ExistingEventRead | null
    try {
      current = await readExistingEvent(id)
    } catch (error) {
      if (error instanceof GoogleCalendarError && error.kind === "authorization")
        return { ok: false, reason: "authorization" }
      throw error
    }
    if (!current) return { ok: false, reason: "not-found" }
    if (current.allDay) return { ok: false, reason: "permanent" }
    if (current.etag === undefined) return { ok: false, reason: "permanent" }
    // A lost checkpoint can replay an already-applied move with a new ETag.
    if (sameInstant(current.start, start) && sameInstant(current.end, end)) return { ok: true, etag: current.etag }
    if (expectedEtag !== undefined && current.etag !== expectedEtag) return { ok: false, reason: "precondition-failed" }
    const timeZone = current.timeZone
    let response: Response
    try {
      response = await request(`/calendars/primary/events/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "If-Match": current.etag },
        body: JSON.stringify({
          start: { dateTime: start, ...(timeZone ? { timeZone } : {}) },
          end: { dateTime: end, ...(timeZone ? { timeZone } : {}) },
        }),
      })
    } catch (error) {
      if (error instanceof GoogleCalendarError && error.kind === "authorization")
        return { ok: false, reason: "authorization" }
      if (error instanceof GoogleCalendarError && error.kind === "transient") {
        try {
          const verified = await readExistingEvent(id)
          if (verified && sameInstant(verified.start, start) && sameInstant(verified.end, end))
            return { ok: true, etag: verified.etag }
        } catch {
          // verify-by-read failed; treat the ambiguous write as failed
        }
      }
      return { ok: false, reason: "permanent" }
    }
    if (response.status === HTTP_STATUS.PRECONDITION_FAILED) {
      // A retried PATCH can return 412 after the first attempt applied upstream
      // and changed the ETag; verify the target before reporting failure.
      try {
        const verified = await readExistingEvent(id)
        if (verified && sameInstant(verified.start, start) && sameInstant(verified.end, end))
          return { ok: true, etag: verified.etag }
      } catch (error) {
        if (error instanceof GoogleCalendarError && error.kind === "authorization")
          return { ok: false, reason: "authorization" }
      }
      return { ok: false, reason: "precondition-failed" }
    }
    if (response.status === HTTP_STATUS.NOT_FOUND) return { ok: false, reason: "not-found" }
    if (response.ok) {
      const data = (await response.json().catch(() => ({}))) as GoogleCalendarEventResponse
      return { ok: true, etag: data.etag }
    }
    return { ok: false, reason: "permanent" }
  }

  return {
    getBusyIntervals,
    listEvents,
    findManagedEvent,
    createManagedEvent,
    updateManagedEvent,
    searchContacts,
    createMeeting,
    readMeeting,
    updateMeeting,
    reconcileManagedSeries,
    deleteManagedEvent,
    findConflictingEvents,
    moveExistingEvent,
  }
}
