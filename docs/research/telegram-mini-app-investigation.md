# Telegram Mini Apps for Kipp: investigation and decision note

**Status:** research draft  
**Decision addressed:** whether a Mini App is an appropriate visual review surface for Kipp's first meal-planning workflow, while Kipp continues to support multiple workflows.

## Executive recommendation

**Proceed with a small Telegram Mini App pilot, but treat it as a Kipp-owned web client, not as a Telegram-only feature or a second application.** Use the existing Kipp bot, give it one workflow-neutral Main Mini App (“Kipp Home”), and route its only initial card to the active weekly meal plan. Keep the conversational workflow in Telegram; use the Mini App for the dense, editable weekly board.

This is technically well aligned with the problem: Telegram documents Mini Apps as HTML5 interfaces for personalized, fully fledged services, with a bot menu button, contextual inline-button launch, a profile-level Main Mini App, and direct links. A Main Mini App is configured in BotFather and shows an **Open App** button on the bot profile; it is not a separate bot or a mobile-app-store submission. [Telegram Mini Apps](https://core.telegram.org/bots/webapps#launching-the-main-mini-app) [Telegram API: Main Mini Apps](https://core.telegram.org/api/bots/webapps#main-mini-apps)

The important qualification is that a Mini App is still a production web application embedded in a Telegram WebView. Kipp owns its hosting, authentication verification, authorization, data security, reliability, responsiveness, and privacy disclosures. The largest risks are not Telegram-specific UI work; they are incorrectly trusting browser-supplied identity data, treating launch parameters as authorization, losing edits on flaky mobile connections, and shipping a six-column board that is cramped on a phone.

## What Telegram actually supplies

Telegram hosts the **container and launch affordances**, not the application. Kipp supplies a public web application at an HTTPS URL, JavaScript that integrates the Telegram Web Apps SDK, and its backend/data store. Telegram’s documentation describes Mini Apps as HTML5 interfaces and requires the bot-side Web App buttons to contain an HTTPS URL. [Mini Apps overview](https://core.telegram.org/bots/webapps) [Bot API: `WebAppInfo`](https://core.telegram.org/bots/api#webappinfo)

Telegram provides:

- A WebView inside supported Telegram clients, plus a JavaScript bridge (`window.Telegram.WebApp`).
- Launch context, theme data, viewport/safe-area events, native buttons, closing confirmation, haptics, popups, links, and navigation hooks. [Web Apps SDK reference](https://core.telegram.org/bots/webapps#initializing-mini-apps)
- Signed launch data (`initData`) that Kipp's server can verify to establish the Telegram user identity. [Validating Mini App data](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
- Several bot entry points and a way to send a result back into chat in the launch modes that provide a `query_id`. [Launch modes](https://core.telegram.org/bots/webapps#implementing-mini-apps)

Telegram does **not** provide Kipp's meal-plan database, profile/configuration storage, agent calls, image understanding, recipe search, authorization policy, audit log, analytics, backups, or availability. Do not use Telegram CloudStorage as the source of truth for household plans: it is a client bridge storage facility, whereas the plan must be shared consistently between the bot workflow and the Mini App. [CloudStorage API](https://core.telegram.org/bots/webapps#cloudstorage)

## Review, publication, hosting, and the existing bot

### Is there a publication/review gate?

For a private pilot, Telegram's documented setup is configuration rather than an app-store review flow: configure a Main Mini App through BotFather, then users receive an **Open App** profile button. Telegram offers optional profile media previews and says successful apps that also accept Telegram Stars *may* be featured in the Mini App Store; neither is required to launch a private Mini App. [Main Mini App setup and optional store feature](https://core.telegram.org/bots/webapps#launching-the-main-mini-app)

This is **not** freedom from operational or policy obligations. Telegram's Bot Developer Terms say third-party apps are hosted on the developer's own servers, require an accessible privacy policy, require deletion when retention is no longer necessary (or on request where applicable), require reasonable security including encryption at rest, and may be terminated for data mishandling or policy violations. [Telegram Bot Platform Developer Terms](https://telegram.org/tos/bot-developers)

Therefore: no expected pre-launch review for this family pilot, but publish a short Kipp privacy notice before expanding beyond the household, and monitor Telegram's terms and client/API changes.

### Must it be hosted?

Yes. The Mini App needs a real, publicly reachable **HTTPS** deployment for production. Its front end may be static, but it needs an API/backend for validated identity, plans, edits, and workflow integration. Telegram's separate test environment permits HTTP links for testing only; it is a separate Telegram environment requiring a separate test account and bot. [Telegram test environment](https://core.telegram.org/bots/webapps#using-bots-in-the-test-environment)

For a Cloudflare-style Kipp backend, the practical shape is:

```text
Existing Kipp bot ── Telegram updates ── Kipp workflow/backend
       │                                      │
       │ launch button / Main App              ├── plan/profile store
       ▼                                      ├── agent + recipe services
Telegram WebView ── HTTPS ── Mini App frontend └── authenticated API
```

Use one Kipp-controlled HTTPS origin (for example, `app.<kipp-domain>`) for the static shell and API, with a server-side secret store for the bot token. A worker/edge deployment is suitable if it can compute the validation HMAC safely, enforce authorization, and persist plans reliably. Never put the bot token in the JavaScript bundle, a URL, logs, or client-side storage.

### Existing bot or a new bot?

**Use the existing Kipp bot.** Mini App configuration and identity are attached to a bot, but a single bot can expose a Main Mini App plus contextual Web App buttons and named Direct Mini Apps. Telegram explicitly documents direct Mini Apps distinguished by a `short_name` under one bot. [Direct Mini Apps](https://core.telegram.org/api/bots/webapps#direct-mini-apps)

A new bot would split the conversation history, user identity mapping, permissions, configuration, notifications, and discoverability. It is only warranted if Kipp intentionally separates products or tenants—not because one workflow happens to need a visual surface.

## Entry-point choice for a multi-workflow Kipp

| Entry point | Fit for Kipp | Constraints / pitfalls | Recommendation |
| --- | --- | --- | --- |
| Contextual inline **Review this week's plan** button | Best immediately after the Sunday draft | Web App inline buttons work only in private bot chats; do not assume a result message is needed for persistence. [Bot API](https://core.telegram.org/bots/api#inlinekeyboardbutton) | Use for the plan-specific deep route. |
| Bot **menu button** | Good repeat entry from the Kipp chat | It replaces the normal command-list button; choose a neutral label such as “Open Kipp,” not “Meal Plan.” It can be configured in BotFather or per chat via `setChatMenuButton`. [Menu-button docs](https://core.telegram.org/bots/webapps#launching-mini-apps-from-the-menu-button) | Optional after the pilot proves return visits matter. |
| **Main Mini App** / bot profile **Open App** | Best persistent, workflow-neutral home | Requires a Main App configuration; profile entry is less discoverable than a contextual button during the first flow. Main App deep links accept an optional `startapp` parameter. [Main App docs](https://core.telegram.org/bots/webapps#launching-the-main-mini-app) | Preferred durable home: `Kipp Home` → active plan card. |
| Direct named Mini App link | Useful future workflow-specific sharing/routing | Link opening can require a user confirmation in some contexts; direct-link Mini Apps cannot read the chat or send a message on the user's behalf. [Direct-link constraints](https://core.telegram.org/bots/webapps#direct-link-mini-apps) | Do not make this the core return path. |
| Attachment menu | Not needed | Telegram says production attachment-menu integration is currently limited to major advertisers. [Attachment-menu limitation](https://core.telegram.org/bots/webapps#launching-mini-apps-from-the-attachment-menu) | Exclude from v1. |

**Architecture implication:** configure a Main App that loads a Kipp shell. Kipp Home resolves the authenticated user and enabled workflows, initially rendering one “This week's meal plan” card. The contextual inline button passes only a route hint such as `workflow=meal-plan&week=2026-W35`; the server still decides whether the current user may see that plan. This preserves a single persistent Kipp entry point as other workflows gain screens.

## Authentication, authorization, and security: the non-negotiable pitfall

The Mini App's `initDataUnsafe` is explicitly untrusted. Telegram says to send raw `Telegram.WebApp.initData` to the bot backend and validate it there. Validation requires computing the specified HMAC-SHA-256 data-check-string signature using a secret derived from the bot token; Telegram also recommends checking `auth_date` to reject stale launch data. [Official validation algorithm](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)

Minimum server flow:

1. The Mini App loads and calls `Telegram.WebApp.ready()` as soon as essential UI is available; it posts the raw `initData` to Kipp over HTTPS. [SDK initialization](https://core.telegram.org/bots/webapps#initializing-mini-apps)
2. Kipp verifies its signature and a short freshness window for `auth_date`; reject failures before parsing/using `user` data.
3. Kipp maps the validated Telegram `user.id` to its household/member record.
4. Kipp applies its own authorization: member belongs to the requested household and can read/edit that plan. It must not trust `week`, `workflow`, `planId`, `start_param`, or the client-provided Telegram ID as proof of access.
5. Kipp creates a short-lived first-party API session/token bound to the verified Telegram user and uses it for all plan API calls. Apply normal CSRF/CORS/origin controls appropriate to the chosen token mechanism, rate limits, input validation, and structured audit logs.

Specific failure modes to design against:

| Risk | Why it happens | Required mitigation |
| --- | --- | --- |
| Account/plan impersonation | Treating `initDataUnsafe`, a Telegram ID submitted by the browser, or a deep-link parameter as trusted | Validate raw `initData` server-side on every new session; authorize every resource server-side. |
| Replay of a valid launch payload | `initData` was valid when issued but is reused later | Enforce a short `auth_date` age and bind/rotate Kipp session tokens. |
| Bot-token leak | Token put in client bundle, logs, or third-party service | Keep token only in backend secret storage; redact logs; rotate if exposed. |
| Cross-household data leak | Guessable plan IDs or client-side-only checks | Scope queries to authenticated household/member; use opaque IDs; test forbidden-object access. |
| Arbitrary client data | Telegram warns `web_app_data` may be arbitrary; ordinary web clients are mutable too | Validate schemas server-side; do not use client text as an authorization/action instruction without policy checks. [Bot API warning](https://core.telegram.org/bots/api#webappdata) |
| Privacy breach | Meal preferences, allergies, child routine, photos are sensitive household data | Data minimization, encryption at rest, retention/deletion path, explicit policy and consent before image/AI processing. [Developer Terms](https://telegram.org/tos/bot-developers) |

The meal planner should keep **all durable data in Kipp's backend**: household profile, allergy/diet constraints, plans, revisions, inventory, recipe links, and edit provenance. Store photos only if they are needed after recognition; otherwise process and delete them after the user confirms the extracted inventory. If a third-party vision or LLM service receives an image or household data, disclose that explicitly and seek an appropriate opt-in before sending it.

### Concrete session design for the Kipp pilot

Telegram supplies a signed launch assertion, not a complete Kipp application
session. The smallest safe design is therefore:

```text
Mini App loads from app.<kipp-domain>
  │  POST raw Telegram.WebApp.initData
  ▼
POST /api/mini/session
  │  validate Telegram HMAC + auth_date
  │  map Telegram user ID to Kipp member and household
  │  apply Kipp's allow-list / household authorization
  ▼
short-lived, Secure, HttpOnly, same-site Kipp session cookie
  │
  ├── GET  /api/meal-plans/active
  └── POST /api/meal-plans/<opaque-id>/feedback
```

The static HTML and JavaScript are public; no plan data is embedded in the
bundle. After the session endpoint succeeds, JavaScript fetches the active plan
from the same origin and renders it. Every plan API scopes its read or write to
the authenticated household/member on the server. A URL route hint, `week`,
`planId`, Telegram user ID sent by the browser, or `startapp` parameter is
never authority to read a plan.

Use an HttpOnly, `Secure`, short-lived same-site cookie so application
JavaScript cannot read a reusable bearer credential. Pair it with standard
same-origin and CSRF defenses for mutation requests, and return a non-secret
anti-CSRF value if the selected pattern requires one. Do not save a session
token in `localStorage`, `sessionStorage`, URL parameters, Telegram
CloudStorage, or logs. Revalidate Telegram `initData` whenever a new Kipp
session is minted; use a short server-side freshness window for `auth_date`.

Cloudflare Access cannot be the only Mini App protection: Telegram's WebView
does not carry the household's Access browser session. If the existing Kipp
hostname is Access-protected by default, expose the static app and only its
Mini-App API routes through a narrowly scoped Access bypass, then enforce the
Telegram validation and Kipp authorization above inside the Worker. A separate
Kipp-controlled app origin with the same server checks is also valid. Never
make a broad hostname-wide bypass simply to make the Mini App load.

## State, feedback, and plan versions

The Mini App is not merely a static HTML renderer. It owns temporary editing
state and renders durable Kipp state; Kipp's backend remains authoritative.

### Recommended v1 behavior

- On load, fetch the latest approved or draft plan and its opaque version ID.
- Keep newly entered cell comments/replacement requests in client memory while
  the user is editing. This permits a short batch review across several cells.
- Clearly show **unsaved changes**. Optionally mirror the draft to
  `sessionStorage` only as a recoverable convenience, never as durable plan
  storage; a close, cache clear, device change, or stale tab can lose it.
- On **Submit feedback**, post one validated feedback batch with the base plan
  version ID. The backend durably records the submitted feedback and starts or
  executes the bounded plan-update operation.
- Persist the resulting revised plan as the latest canonical plan version,
  then return its new version ID to the Mini App. Reloading always shows that
  latest version.
- Do not display comment or version history in the v1 board. Keep a compact,
  access-controlled audit record internally—plan ID, base version, cell
  reference, comment/action, outcome, timestamp, and actor—so later history,
  debugging, and safe conflict handling remain possible.

The client must not silently overwrite a plan if another change wins first.
The submission includes the base version ID; the backend accepts it only if it
is current, or returns a conflict and asks the Mini App to reload the latest
plan. Duplicate submit/retry operations need an idempotency key. Agent-driven
revision may take time, so the UI needs explicit `submitting`, `updating plan`,
`updated`, and `needs attention` states rather than assuming an HTTP request
instantly produces a new board.

This keeps the initial interface intentionally simple: **latest plan in,
new feedback out**. It does not commit Kipp to exposing a confusing discussion
or version-history experience later.

## Cloudflare hosting and Free-tier fit

The Mini App can be hosted entirely in the existing Cloudflare account. The
recommended pilot is a responsive static client plus authenticated API routes
on one Kipp-controlled HTTPS origin. Either a Worker with Static Assets or
Cloudflare Pages for the client is suitable; using the Worker keeps deployment,
origin policy, and backend integration together, while Pages is equally valid
if its Functions/API are kept on the same carefully controlled origin.

For one household, the Free tier is comfortably adequate for the Mini App
shell and ordinary plan reads/writes. Cloudflare currently gives Workers Free
100,000 requests per day, 10 ms CPU time per request, and 20,000 static files
per Worker version; static Pages asset requests are free and unlimited, while
dynamic Pages Functions share the Workers request quota. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
[Pages pricing](https://developers.cloudflare.com/pages/functions/pricing/)

The main design constraint is the Free Worker’s 10 ms CPU budget: keep route
handlers thin (authentication verification, schema validation, a plan read or
write) and leave expensive planning, vision, transcription, and recipe search
in the existing bounded workflow/provider paths. Waiting on a database or
external fetch does not itself count as CPU time, but parsing large payloads or
doing heavy computation can exceed the limit. [Workers CPU limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)

For durable meal plans and feedback records, use a transactional store, not
Workers KV as the canonical record. D1 is a reasonable future Cloudflare-native
choice for plan/version/feedback tables: on Free it has 5 GB total storage,
500 MB per database, 5 million rows read per day, and 100,000 rows written per
day. Existing Kipp Durable Objects can remain responsible for short-lived
workflow/session coordination, but are not automatically a general household
plan database. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

Store only structured plan and feedback data in D1. Do not put fridge photos
in D1; use short-lived request processing and deletion, or a deliberately
configured object store with retention controls if image retention is later
needed.

## Telegram Mini App feature inventory

This is the living scope checklist. Change a row only with a product decision
and record why, so Telegram capabilities do not quietly turn into obligations.

| Telegram capability | Pilot decision | Purpose / constraint |
| --- | --- | --- |
| Existing bot | **Use** | One Kipp identity, authorization model, and conversation history. |
| Contextual inline `web_app` button | **Use first** | Opens the draft directly after Telegram proposes a plan; private bot chats only. |
| Main Mini App / profile **Open App** | **Use after pilot** | Workflow-neutral Kipp Home for returning to the active plan. |
| `startapp` route hint | **Use carefully** | Directs to a workflow/week route; server still authorizes every resource. |
| Web Apps SDK and `ready()` | **Use** | Signals a responsive initial render and enables the bridge. |
| `initData` | **Use** | Send raw signed launch data to the backend; validate server-side. |
| Theme, viewport, and safe-area APIs | **Use** | Make the board legible in Telegram light/dark themes and avoid obscured controls. |
| Native Bottom/Main button | **Use** | Primary action such as **Submit feedback** or **Approve plan**. |
| Native BackButton and closing confirmation | **Use** | Navigate out of a cell and protect unsaved feedback. |
| `openLink` | **Use** | Open an explicitly selected YouTube recipe from a user tap. |
| Haptic feedback | **Later, optional** | Small confirmation polish after a saved feedback action. |
| CloudStorage / DeviceStorage | **Do not use as source of truth** | At most a disposable UI convenience; canonical plans remain in Kipp storage. |
| `sendData` / `answerWebAppQuery` | **Not needed initially** | The Mini App calls Kipp’s authenticated API directly; Telegram chat messages remain workflow-owned. |
| Attachment-menu launch | **Exclude** | Not needed and Telegram limits production attachment-menu integration. |
| In-app payments, invoices, ads, Mini App Store | **Exclude** | No role in a private family pilot. |
| Mini-App camera/file capture | **Defer** | Use ordinary Telegram photo/voice messages first; mobile-WebView capture varies. |
| Fullscreen, orientation lock, home-screen shortcuts | **Defer** | Feature-test later only if phone testing proves a need. |

## UX, mobile layout, and lifecycle realities

### A Mini App is a constrained, variable WebView

The app has to run across Telegram clients and sizes, in light and dark themes, with changing viewport height and insets. Telegram exposes `themeParams`, color scheme, `viewportHeight`, `viewportStableHeight`, safe-area and content-safe-area insets, and corresponding events. It cautions that `viewportHeight` should not pin bottom controls during resize; use the stable height/insets and react to changes. [Viewport, theme, and safe-area API](https://core.telegram.org/bots/webapps#initializing-mini-apps)

Practical requirements for the meal board:

- Test the design in narrow portrait first. A literal 5 × 6 spreadsheet will be too dense if every cell contains dish, ingredients, prep and recipe.
- Keep the board's default cell content to a short meal label plus state cues (packed/home, prep note, recipe available). Open a bottom sheet/detail view for ingredients, substitutions, and video.
- Prefer a horizontally scrollable day strip with a sticky meal-slot column **or** a week summary plus a day-focused editor. Validate both with Mom; do not assume the fridge magnet layout transfers unchanged to a 360–430 px phone screen.
- Call `ready()` early, respect Telegram theme values, make the app usable without custom fonts/large images, and avoid a long initial agent wait behind a blank WebView.
- Use Telegram's native Bottom/Main button for the decisive action (“Approve week” or “Save changes”) and native BackButton for nested cell/detail navigation. Enable closing confirmation only after unsaved edits. Telegram supports both native button controls and closing confirmation. [Web Apps SDK controls](https://core.telegram.org/bots/webapps#initializing-mini-apps)
- Avoid disabling vertical swipes except while a conflicting internal gesture is in progress; Telegram recommends leaving swipes enabled for convenience. [Swipe guidance](https://core.telegram.org/bots/webapps#initializing-mini-apps)

### Compatibility and graceful fallback

Telegram exposes a client `version` and documents feature availability by Bot API version. Newer features such as safe-area APIs, fullscreen, orientation lock, and home-screen support have version requirements; feature-test rather than assume them. [SDK version and methods](https://core.telegram.org/bots/webapps#initializing-mini-apps)

The web page should also render a useful non-Telegram fallback for normal-browser opening: explain that it should be opened from Kipp, or provide a Kipp sign-in/return route if that is deliberately supported. Do not make a browser fallback silently treat an unauthenticated visitor as a Telegram user.

Do not depend on a Mini App remaining open as a durable session. Users can close, minimize, background, rotate, change theme, reopen, or lose network. Persist each deliberate edit promptly (or locally queue it with a visible sync state), use optimistic concurrency/version checks, and make reopening load the server's latest active plan. For plan generation, record server-side job state and let the app reconnect/poll rather than keeping the only state in a client component.

## Photos, voice, recipes, and chat handoff

Telegram chat already supports photos and voice messages as bot inputs; it is the lowest-risk v1 way to collect vegetable inventory or a fridge photo. Telegram's Mini App overview explicitly notes that bots can receive freeform text and attachment types including photos, videos, files, locations, contacts, and polls. [Telegram Mini Apps overview](https://core.telegram.org/bots/webapps#implementing-mini-apps)

Recommended v1 division:

- **Telegram conversation:** Sunday trigger, free-text/voice inventory, fridge-photo submission, clarification questions, completion acknowledgement, and proactive reminders.
- **Mini App:** plan display; per-cell replace/note/recipe actions; inventory confirmation once extracted; approve/save; today view.
- **Kipp backend:** transcription/vision, profile constraints, planning, storage, recipe discovery, and all authorization.

The Mini App may later use normal mobile-web file/camera input, but that is a separate browser-permission and upload design problem—not a Telegram-native camera guarantee documented by the Mini App API. Keep photo capture in chat for the pilot; it also provides a familiar recovery path if the WebView upload UX varies by client.

For YouTube recipes, use an explicit “open video” interaction. Telegram's `openLink` opens a link in an external browser and must be invoked from user interaction; do not assume an embedded YouTube player will work consistently inside every client WebView. [Web Apps SDK: `openLink`](https://core.telegram.org/bots/webapps#initializing-mini-apps)

## Development, deployment, testing, and observability

### Build sequence

1. Create a thin responsive web route: authenticated “active plan” read-only board.
2. Add raw `initData` validation and a Kipp session endpoint before implementing any protected plan endpoint.
3. Add one edit interaction (replace a cell) with server persistence, a clear pending/saved/error state, and conflict handling.
4. Configure a contextual inline Web App button on the existing bot.
5. Test with the intended users and real household data on actual Android/iOS devices; then configure the Main App/Kipp Home for persistent return visits.
6. Add recipe launch and image/voice handoff only after the plan review loop works.

### Testing checklist

- Valid and invalid `initData`, expired `auth_date`, malformed query strings, and a user attempting another household's plan ID.
- Telegram Android and iOS on the versions actually used by the household, plus Telegram Desktop and normal mobile browser fallback. Test light/dark mode, small screen, rotation, keyboard open, minimize/reopen, background/foreground, slow/no network, and expired session.
- Both contextual inline-button launch and persistent Main App re-entry. Verify a route hint cannot expose the wrong plan.
- Small first load, `ready()` timing, safe-area padding, primary button not hidden by Telegram/OS UI, long Indian dish names, and each of 30 cells having an accessible edit path.
- Agent job interruption, duplicate taps, concurrent bot/Mini App edits, and a plan changed by a weekday exception.

Telegram documents a separate test environment with a separate test bot/account; it is useful for protocol experiments, but final UX must be tested on production clients because the real bot, user identities, and user-installed applications are separate. Telegram also documents WebView inspection routes for several desktop/mobile clients. [Test environment](https://core.telegram.org/bots/webapps#using-bots-in-the-test-environment) [Debugging Mini Apps](https://core.telegram.org/bots/webapps#debugging-mini-apps)

### Operational controls

- Structured, redacted logs: request ID, validated Telegram user ID (or internal hash), household/plan ID, route, action, latency, outcome; never raw `initData`, bot token, photo URL/content, allergy details, or full chat text.
- Metrics: launch-to-ready time, API error rate, auth validation failures, plan-load latency, save success/retry/conflict rate, cell edit completion, recipe-open events, and abandonment before approval.
- Alert on authentication-error spikes, error-rate/latency regressions, failed agent jobs, and image processing failures.
- Keep a configuration flag to turn off Main App entry or a workflow card while retaining chat fallback.
- Back up plan/profile data and keep a restore/export path. Telegram is only the interface; Kipp bears data-loss responsibility.

## Pilot plan and exit criteria

### Scope

Use the existing Kipp bot and one household. The pilot does **not** attempt general workflow navigation, full inventory photo recognition, shopping, home-day templates, or automatic reminders.

1. On Sunday, Mom starts the meal-planning conversation and sends text/voice inventory plus exceptions.
2. Kipp drafts the plan in chat and sends **Review this week's plan**.
3. The inline button opens the Mini App directly to the draft week.
4. The Mini App shows a phone-optimized board for five configured meal slots × six school days. She can inspect a cell, add a note, replace it, open one recipe, and approve.
5. A second launch loads the same active plan and supports a minimally disruptive single-cell change.
6. After this works, add the Main App with a workflow-neutral Kipp Home and one meal-plan card.

### Success criteria

- The intended user can recognize the week and today’s meals without help.
- She can replace a school-lunch cell and sees the new value survive Mini App close/reopen and appear in Telegram’s subsequent response.
- No unauthenticated or cross-household plan API request succeeds.
- A working draft is usable on her actual phone in both expected Telegram themes, with no important action obscured by browser/Telegram chrome.
- The user reports that reviewing/changing the plan is easier than manually re-writing the fridge board; if not, keep Telegram as conversation only and reconsider the board surface.

## Decision boundaries

Adopt the Mini App if the pilot validates that the grid-plus-cell-editor gives materially faster review than a chat-only plan. Do **not** adopt it merely because Telegram can host it: the web client adds real security, deployment, and support responsibilities.

For this workflow, the balanced decision is:

> **Telegram is the input, notification, and conversational layer. A hosted Kipp Mini App is the authenticated visual plan layer. The bot's Main App remains a general Kipp home, while the meal planner owns only its routes and card.**

This keeps the user experience coherent today and avoids painting Kipp into a workflow-specific navigation model tomorrow.
