# Connect Buffer

Buffer setup is optional. Existing LinkedIn and Calendar workflows do not need
Buffer configuration. Phase 2 supplies connection setup and secure refresh;
`/note` drafting and publication arrive in later phases.

1. Connect the desired Substack account inside Buffer. Kipp authorization does
   not create or repair Buffer’s connection to Substack.
2. Register a server-side Buffer OAuth app with the exact callback
   `https://<your-kipp-origin>/auth/buffer/callback`.
3. Set `BUFFER_CLIENT_ID` and `BUFFER_CLIENT_SECRET` as secrets. Set
   `BUFFER_REDIRECT_ORIGIN` to that HTTPS origin, without a path, query or
   fragment. Kipp uses this fixed origin even if a request has another Host.
4. Open `/setup/buffer` through the normal authenticated Kipp setup access and
   approve `account:read`, `posts:read`, `posts:write`, and `offline_access`.
5. If `BUFFER_SUBSTACK_CHANNEL_ID` is absent, the successful callback lists
   available Substack channel names and IDs. Configure the single channel ID
   manually; Kipp never chooses or switches the destination for you. Reconnect
   to check the configured channel and its publishing permissions.

Use `.dev.vars` for local secrets and `[vars]` in `wrangler.local.toml` for
local text configuration. Production values and secrets belong in Cloudflare
Dashboard, as described in [runtime configuration](production-runtime-configuration.md).
The five new registry variables are globally optional: client credentials and
redirect origin are required for Buffer setup; the channel ID is required for
Notes publication. `PROMPT_NOTES_PATH` is optional and will select a writing
prompt when the Notes workflow is implemented. Production provisioning remains
a release prerequisite; a dry-run does not verify provisioned values.

The callback reports whether the configured channel is available to the
connected Buffer account, is Substack, is connected/unlocked, and permits
scheduling posts. A paused queue is reported separately: resume it inside
Buffer before relying on queue placement. Setup does not alter Buffer settings.
No token, refresh token, verifier or client secret appears in setup output.

The encrypted vault refreshes expiring credentials automatically. Concurrent
requests share one refresh, and both rotated tokens are saved before returning
access. If a refresh response or its durable save cannot be confirmed, Kipp
requires Connect Buffer again rather than reusing a possibly consumed refresh
token. Same-account reauthorization retains the connection identity; changing
the Buffer account changes that identity, so future publication approvals
cannot silently move to another account.

Consent state expires after five minutes and can be consumed once. An expired,
failed or interrupted setup must restart at `/setup/buffer`; do not retry a
callback URL. Do not share callback URLs. Enable **Redact query string** in
Cloudflare Dashboard observability so OAuth codes/state stay out of request
logs. Real setup consent, production provisioning and deployment are separate
release actions; automated tests use synthetic credentials and fake endpoints.
