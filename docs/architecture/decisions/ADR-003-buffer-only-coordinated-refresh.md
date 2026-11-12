# ADR-003: Coordinate rotating token refresh only for Buffer

## Status

Accepted on 12 November 2026. Buffer coordination is implemented on the Notes
feature branch and awaits release; this record does not imply deployment.

## Context

Kipp stores provider credentials in the encrypted `TokenVaultDO`. LinkedIn's
scheduled token check refreshes credentials outside the vault. The Google
Calendar API client also refreshes outside the vault, during a request. Neither
path coordinates the complete read-refresh-write operation across callers.

Buffer rotates its refresh token on every refresh and invalidates the previous
token. Reusing an old token revokes the grant. Buffer explicitly recommends one
place owning refresh to prevent collisions. See
[Buffer's token guidance](https://developers.buffer.com/guides/building-apps.html#working-with-tokens).

Concurrent Telegram feedback conversations remain unsupported. That limitation
does not enforce system-wide serialization or make an interrupted token exchange
safe to repeat.

## Decision

Keep Buffer refresh inside the existing vault as a provider-specific exception:

- Overlapping Buffer callers await one live refresh in the vault instance.
- Persist a refresh claim before contacting Buffer. Save both replacement tokens
  before returning access, and check the credential generation and claim before
  accepting the result.
- Require reauthorization after an uncertain exchange or an unresolved durable
  claim. Do not blindly reuse a potentially consumed refresh token after restart.
- Preserve LinkedIn and Calendar refresh behavior. Do not add coordinated refresh
  to either provider until concurrent workflows are explicitly supported and the
  extension is explicitly approved.

## Consequences

Buffer connection safety does not depend on supporting concurrent conversations.
The durable claim also protects against interrupted exchanges with a single
caller. Buffer coordination is not a shared refresh abstraction for every
provider, and it does not introduce concurrent Notes feedback support.

LinkedIn and Calendar retain their existing lack of cross-caller refresh
coordination. A future concurrency change must revisit provider-specific token
rules and refresh ownership rather than assuming shared vault storage already
provides that protection.
