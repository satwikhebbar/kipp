# Telegram Mini App meal-plan review

## Runtime setup

`MINI_APP_ORIGIN` is an optional text runtime variable. When it is a public
HTTPS origin, every persisted plan message receives a same-origin
`/mini-app` **Review this week's plan** button alongside Telegram's existing
feedback action. An absent, malformed, local, private, or link-local origin
does not expose a Mini App button.

Set the development value in `wrangler.local.toml` and the production value in
the Cloudflare Dashboard. Do not add production values to `wrangler.prod.toml`.
The origin must be reachable by Telegram's mobile WebView; a loopback worker
or private tunnel address is not valid. Keep Dashboard query-string redaction
enabled as required by [production runtime configuration](production-runtime-configuration.md).

## Privacy and durability

The WebView authenticates using raw Telegram `initData`; the Worker verifies
its HMAC, timestamp, replay fingerprint, configured parent, and a server-owned
private-chat review context. `/mealsettings` opens a short-lived settings-only
session from the admitted user's private chat and also works before a plan
exists. Browser requests use an opaque, memory-only bearer session. URLs and
logs never receive plan/chat identity, launch data, or bearer credentials.
Profile and schedule values stay in memory and are fetched from the server; the
settings editor does not write them to browser or Telegram device storage.
Device storage contains only the local draft payload, its
idempotency key, and the minimal plan/version key needed to isolate that draft
batch; it never contains a chat ID, raw launch data, or bearer credential.

Unsent feedback is local to the device and exact persisted plan version. It is
stored with one idempotency key in Telegram DeviceStorage, with browser storage
only as a local-development fallback. It is cleared after an accepted handoff,
an explicit removal of the final draft, or a stale-version conflict. It is not
canonical or shared across devices. The server's sole durable feedback record
is `feedback_batch`; there is intentionally no Mini App cron or automatic
retry for interrupted workflow processing.

## Mobile verification checklist

Before release, use a production-like public HTTPS origin and the configured
parent account on both Android and iOS Telegram clients:

- Send `/mealsettings` in the private bot chat before creating a plan. Edit a
  dietary exclusion, save, and use **Reload from server** to confirm the saved
  value returns. Confirm the settings form does not include a client-supplied
  chat ID.
- Change the schedule to two weekdays including Sunday, add and reorder a
  custom slot, select an established meal for it, and choose a recurring
  half-day behavior. Save and reload; confirm the values remain. When new foods
  are disabled, leave an eligible established meal selected for every slot.
- Open settings from an existing plan review, edit the future schedule, and
  return to the plan. Confirm its displayed grid remains on the plan's pinned
  schedule and feedback still submits against that plan.
- Simulate a stale configuration version. Confirm the editor offers **Reload
  latest and reapply my edits**, and that a successful reapply returns the
  canonical saved configuration.
- Run `/mealplan`; verify the persisted plan message has both feedback actions.
- Open the Mini App and confirm the dark board, safe-area spacing, theme,
  six-day selection, compact holiday `🏖 Holiday` disabled state, and selectable
  `◐ Half day` label.
- Create both a cell draft and a **Change plan** draft, close/reopen the app,
  and confirm drafts and their one idempotency key restore only for that plan
  version.
- Submit once; confirm the Mini App says feedback was sent then closes, and
  Telegram—not the WebView—reports progress and later offers the fresh plan
  link.
- Test a first-use or missed-week link: it must show the no-plan `/mealplan`
  handback with no board or feedback controls.
- Rotate the device, open and close the keyboard, switch Telegram light/dark
  theme, and reopen after session expiry. Each state must remain usable without
  exposing another chat or plan.
