# Live Buffer OAuth spike

This isolated Node receiver verifies the OAuth contract before implementing the
Notes workflow. It does not modify Kipp's Worker, runtime variables, Telegram
webhook, production vault or publishing behavior.

Prerequisites: a confidential Buffer App Client, `.dev.vars` entries for
`BUFFER_CLIENT_ID` and `BUFFER_CLIENT_SECRET`, and an exact registered HTTPS
callback ending in `/auth/buffer/callback`. The origin defaults to
`MINI_APP_ORIGIN` in `wrangler.local.toml`; `BUFFER_SPIKE_ORIGIN` can override it.

Run local protocol checks first:

```sh
rtk proxy node --test tools/spikes/notes-buffer/check.mjs
```

Make sure ports 8787/4040 are unused, then start the receiver and existing reserved
tunnel in separate terminals:

```sh
rtk proxy node tools/spikes/notes-buffer/serve.mjs
rtk proxy ngrok http http://127.0.0.1:8787 --domain=unrushed-walnut-perm.ngrok-free.dev --inspect=false --log=stdout --log-level=warn
```

Open the unique setup URL printed by the receiver in the browser and approve the
Buffer consent screen. State/cookie expire after five minutes; opening the setup
link again starts a fresh attempt. Keep the callback URL out of chat/logs because
it contains a one-time authorization code. The receiver logs only allowlisted
diagnostics, never request URLs or provider bodies. Tunnel inspection is disabled.

The receiver stores an AES-GCM encrypted grant and owner-only encryption key under
the ignored `.wrangler/notes-buffer-spike/` directory. This local spike storage is
not Kipp's production encrypted vault and does not implement rotating refresh
coordination. A sanitized, local `discovery.json` records scopes, expiry and
Substack channel identity/permissions without token values. Tokens never appear
in the browser response. Keep the local directory private and out of git.

The receiver performs only the code exchange and read-only account/channel
discovery. It exposes no public publishing, refresh, credential-read or deletion
endpoint. Actual create/normal-refresh tests are a separate controlled local step
after successful consent. Stop receiver and tunnel with Ctrl-C when finished.

## Controlled live checks

`live.mjs` uses the encrypted local grant. It has no HTTP endpoint and runs one
operation at a time under an exclusive local lock. A create intent is retained
before dispatch; repeating the same mode/text refuses a second create. A pending
refresh claim prevents reuse of an uncertain single-use token. This is a local
spike tool, not the production DO guard or rotating-refresh implementation.

Commands are `inspect` (read-only schema), `refresh` (one normal grant rotation),
`queue <text> [url]`, `schedule <text> [url]` (24 hours ahead),
`now <text> [url]`, `read <record-path>` and `cleanup <record-path>`.
Create commands require explicit live-test authorization. Cleanup accepts only
an exact locally recorded test post with Buffer's deletePost action; it never
selects existing user content by text or time. Published Notes need native
Substack deletion; arrange that before using `now`.

The 10 November run verified normal rotation, one text-only exact schedule,
one queue placement, two scheduled card variants, and two immediate card Notes.
All four future entries were deleted through Buffer. The user visually checked
both public cards and confirmed native deletion of both Notes. Sanitized captured
responses live in
[`buffer-live-spike-2026-11-10.json`](../../../docs/research/fixtures/buffer-live-spike-2026-11-10.json).
No eventual scheduled delivery, revoked grant, old-token reuse or live transport
fault was tested. Receiver and tunnel were stopped after verification.
