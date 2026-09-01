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
private-chat review context. Browser requests use an opaque, memory-only bearer
session. URLs, device storage, and logs never receive plan/chat identity,
launch data, or bearer credentials.

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
