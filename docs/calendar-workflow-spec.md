# Kipp Telegram Personal Calendar Blocks — v1 Requirements

## Goal and scope

Kipp creates personal, timed blocks and reminders in the connected Google
account's **primary calendar** from Telegram. A clear request should be booked
in one pass with useful defaults; Telegram immediately confirms what was done
and permits correction.

v1 is personal-only. It creates no guests, invitations, meeting URLs, or
conference links. It does not offer general calendar search, listing, editing,
cancellation, or rescheduling after the immediate creation interaction.

## Interface and identity

- Calendar capture requires `/calendar <natural-language request>`; ordinary
  Telegram messages are not classified as calendar requests in v1.
- `/calendar` without usable content returns static usage help and examples. It
  does not call the LLM or create pending state.
- The existing Telegram allow-list remains the sole Telegram identity boundary.
- Every accepted request uses the single Google account connected through the
  Access-protected setup flow. Telegram cannot select or change accounts.
- `TIMEZONE` is a shared, IANA timezone configuration used by all workflows
  when local-time interpretation is needed. Its initial value is
  `Asia/Kolkata`, replacing the current `UTC` example/default.

## Google OAuth and credential recovery

Google Cloud OAuth client registration (client ID, client secret, consent
screen, and protected redirect URI) is a deployment prerequisite. Kipp then
provides an Access-protected `/setup/google-calendar` flow based on the
existing OAuth-state and encrypted token-vault patterns.

- Request only `https://www.googleapis.com/auth/calendar.events.owned`.
- Store access and refresh tokens encrypted and independently namespaced from
  LinkedIn credentials.
- Refresh ordinary access-token expiry silently before a Calendar request, or
  once after an authentication failure.
- If credentials are missing, revoked, or cannot be refreshed, do not modify
  Calendar. Send Telegram **Reconnect** and **Retry** actions.
- **Reconnect** starts a fresh short-lived OAuth state. The Calendar workflow
  itself retains its parsed request for 15 minutes. After reconnection, the
  user taps **Retry**; it makes one attempt and then completes or fails. This
  is not an automatic retry loop and does not require a separate persisted
  request store.

## Agent and deterministic-engine boundary

The LLM understands the natural-language request and produces a strictly
validated structured proposal: action/title, date and time constraints,
duration, recurrence, reminder class, useful description/location, and
uncertainty flags.

Deterministic code owns all consequences: relative-date validation, timezone
handling, time-grid search, buffers, availability, conflict rules, recurrence
expansion, reminder selection, OAuth, retries, idempotency, expiration, and
Calendar reads/writes. The LLM has no direct Calendar, Telegram, or storage
tools and cannot alter policy based on text embedded in a request.

The LLM receives no titles, descriptions, locations, attendees, or other
details from existing Calendar events. Availability is the only Calendar
context exposed while resolving a request.

If the LLM is unavailable or returns an invalid proposal, Kipp creates nothing
and asks the user to try again.

## Event construction

- Every v1 event is timed; all-day events are out of scope.
- Use a concise title, optionally including a supplied person: `Call Amit`,
  `Dinner with family`, or `Pick up son from school`.
- Do not place phone numbers, addresses, or private notes in a title.
- Put an explicitly supplied venue in Calendar's `location` field. Put a
  supplied phone number, agenda, or preparation note in `description` only
  when it helps follow-through. Do not look up contact or location data.
- Create events as **opaque/busy** and **private**. Do not assign an event
  colour in v1.
- Set one per-event popup reminder override: 10 minutes for ordinary blocks;
  one hour for family/social plans, school pickup, appointments, repeating
  maintenance, or other events requiring preparation or physical presence. An
  explicitly requested reminder wins.
- Use private event metadata, never visible title/description text:

  ```text
  kipp.managedBy = "calendar-agent"
  kipp.requestId = "<opaque ID>"
  kipp.schemaVersion = "1"
  ```

  Never place Telegram IDs, request text, or personal details in this
  metadata.

## Date, time, and duration inference

### Date rules

- A calendar write needs an explicit or reliably inferable date.
- If no date can be inferred—such as “sometime next week” or “in the coming
  days”—ask one direct follow-up; never choose a day from a range.
- “Friday” means the next upcoming Friday; “next Friday” means the Friday after
  that. Today counts only if a usable slot remains.
- A month-and-day date that has passed this year, or any explicit past
  date-and-time, requires clarification. Never reinterpret it as next year,
  tomorrow, or another future date.
- A clear one-off may auto-book only up to 12 months ahead. A farther date
  needs confirmation.

### Inferred time rules

- Waking-time availability is 08:30–22:30. Inferred starts use 15-minute
  increments.
- For a clear short request with a date but no time, first try 19:00, then the
  nearest free slot in 19:00–21:30, then the rest of the waking window.
- For today, an inferred event may not start sooner than 30 minutes after the
  message, rounded to the next 15-minute boundary.
- Broad phrases are hard windows with these initial mappings:

  | Phrase | Search window | First time tried |
  | --- | --- | --- |
  | Morning | 08:30–12:00 | 09:00 |
  | Afternoon | 13:00–17:30 | 15:00 |
  | Evening | 19:00–21:30 | 19:00 |
  | Night | 21:30–22:30 | 21:30 |

- Respect relative constraints such as “after 6”, “before 5”, and “between 3
  and 5” as hard bounds. Do not spill outside a stated period.
- Automatically choose a time only for events of 30 minutes or less. Ask for a
  time for longer events and always for socially sensitive activities such as
  family dinner.
- Preserve an explicitly supplied clock time exactly. It is a hard constraint
  unless the user signals flexibility.

### Duration rules

Resolve duration in this order:

1. An explicit duration wins.
2. Use a confident reusable generic preference when the future memory layer
   provides one.
3. Use initial generic defaults: personal call 30 minutes; professional or
   recruiter call 15 minutes; family dinner 2 hours; other clear one-off block
   30 minutes. Classify a call as professional only from explicit professional
   cues or a confident reusable preference.
4. The LLM may make a current-event task-specific estimate. Round it to 15
   minutes and constrain it to 15 minutes–2 hours unless the user supplied a
   duration.

Task-specific estimates are not memory by themselves. They are visible in the
confirmation as estimates and are remembered only under a later generic-memory
specification when their reuse value is established.

## Availability and conflicts

- Busy/opaque timed events and all-day events block automatic scheduling;
  transparent/free events do not.
- Inferred scheduling leaves a 15-minute invisible gap before and after other
  events. It creates no buffer events and does not change the requested
  duration. Explicit start times may abut another event when they do not
  overlap.
- A stated date never shifts automatically to another date.
- For inferred time, Kipp chooses the closest suitable free time on the stated
  date automatically.
- For explicit time, or when no suitable time remains on that date, Kipp asks
  instead of silently moving the new event.
- Kipp never moves, cancels, overwrites, or drops an existing event—whether
  agent-created or not.
- A conflict prompt names no conflicting event or its details. It offers one
  best alternative, **Choose another time**, and **Cancel**. Choosing another
  time asks for a natural-language replacement.

## Recurrence

- Support only daily; weekly (including named weekdays); every two weeks;
  monthly; and every two months.
- A recurrence auto-creates when its cadence and start date are clear and all
  occurrences are conflict-free.
- A missing/ambiguous start date requires clarification even if the cadence is
  obvious.
- A series ends after six months unless a clear end date or occurrence count is
  given. An “indefinite” request still ends after six months.
- A 29th, 30th, or 31st monthly/bimonthly occurrence falls on the shorter
  month’s final day.
- Validate every occurrence in the six-month horizon before writing the series.
- If 50% or more of occurrences conflict, offer a new single time for the
  whole series and revalidate every occurrence.
- If fewer than 50% conflict, propose nearest-free per-date exceptions as one
  batch. The user chooses **Create with adjustments**, **Try another series
  time**, or **Cancel** before Kipp creates the series and exceptions.

## Confirmation and immediate correction

Every successful write sends a compact Telegram confirmation with title,
date/time, duration, recurrence when relevant, and reminder. Meaningful
inferred values are labelled—for example, `19:00 (chosen)` or `45 min
(estimated)`. Do not send a Calendar event link.

- Each confirmation exposes **Edit**, active for 15 minutes.
- Tapping Edit prompts the user to reply to that specific bot message with a
  natural-language correction. Unrelated Telegram messages are not treated as
  edits.
- An immediate edit may change any v1-supported field and is revalidated as a
  fresh scheduling proposal.
- Every reconfirmation exposes a fresh Edit action. Only the newest action is
  valid; prior buttons are invalidated. This is user-driven, never an automatic
  loop.
- Do not offer a post-creation Cancel action in v1.
- After 15 minutes, the workflow discards its pending state. Further calendar
  management is out of scope.
- Protecting against a manual Calendar edit during this short Telegram edit
  window with Calendar ETags is a post-MVP hardening item.

All interactive waits—missing-date clarification, conflict selection,
replacement time, reconnect/retry, and immediate edit—expire after 15 minutes.

## Reliability and failure rules

- Bind each Telegram message ID to one deterministic, opaque Calendar event ID
  so webhook redelivery and uncertain writes create at most one event. A new
  Telegram message with identical text is a new intentional request.
- Retry transient network, rate-limit, and server failures up to two times with
  short backoff using that same idempotency identity.
- Do not retry invalid/permanent requests. Do not perform background retries
  after the bounded attempt; send a concise failure message instead.
- If Calendar creation succeeds but Telegram confirmation fails, retain the
  event and retry only the confirmation a small bounded number of times. Never
  recreate the event.
- Authentication failures follow the reconnect-and-Retry flow above.

## Memory boundary

The calendar workflow uses a future generic Kipp memory layer; it does not own
calendar-specific long-term memory. That separate design will govern review,
correction, and forgetting.

For this workflow, only explicit corrections or confirmed reusable defaults
are candidates for memory. A one-off task detail or duration estimate is not
persisted merely because it appeared in an event.

## Explicit v1 exclusions

- Multiple calendars and cross-calendar availability.
- Guests, invitations, conferencing, and meeting URLs.
- All-day events.
- Natural-language calendar routing from uncommanded Telegram messages.
- Calendar search/listing and management after the immediate confirmation flow.
- Recurrence renewal prompts and ongoing recurrence management.
- Custom/annual/ordinal or multi-rule recurrence expressions.
- External contact/location lookup.
- General long-term memory implementation.
- ETag protection for simultaneous manual Calendar edits during immediate Edit
  (post-MVP hardening).

## Delivery plan (no implementation started)

1. Establish configuration and OAuth foundations: shared `TIMEZONE`, Google
   OAuth credentials/routes, provider-namespaced encrypted tokens, and the
   documented setup prerequisite.
2. Build the Calendar client with primary-calendar event operations, silent
   refresh, bounded retry/idempotency, private `kipp.*` metadata, and
   availability-only reads.
3. Add a separate Calendar workflow and Telegram `/calendar` routing, including
   validated LLM proposal extraction and deterministic scheduling policy.
4. Implement one-off creation, conflict conversations, confirmations, and the
   bounded immediate Edit state machine.
5. Add supported recurrence expansion, full-horizon conflict evaluation, and
   series/per-date adjustment flows.
6. Add reconnect-and-Retry, failure/notification recovery, tests for every
   decision branch, and deployment/setup documentation.
7. Design the generic Kipp memory layer as a separate initiative, then connect
   it through the workflow’s defined preference interface.
