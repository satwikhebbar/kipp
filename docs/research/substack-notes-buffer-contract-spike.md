# Buffer → Substack contract spike

Investigated 10 November 2026 for Beads agent-harness-dxzc. The initial documentation review was followed by authorized live OAuth and primary-account tests. All test content was removed; no production workflow was implemented.

## Finding

Live tests confirm OAuth, normal token rotation, automatic immediate publication, exact-time scheduling, Buffer-selected queue placement and both external/Substack article cards on the configured account. The main design correction is to **avoid equating any typed mutation error with proof that nothing was created**.

The [reusable fixture corpus](fixtures/buffer-contract-spike.json) contains invented, non-secret examples for implementation tests. Its expected outcomes describe Kipp policy; they are not captured Buffer responses or a tested production adapter.

## Authentication and destination

Use a confidential app client with Authorization Code + PKCE S256. Register the exact HTTPS callback, including port/path/trailing-slash spelling. Client registration and requested permissions are separate steps. A personal API key can test reads/writes for one account but cannot establish OAuth behavior. [Building apps](https://developers.buffer.com/guides/building-apps.html).

Request `account:read posts:read posts:write offline_access`. The token response contains `access_token`, `refresh_token`, `token_type`, `expires_in` and space-separated `scope`; the documented access-token example lasts 3,600 seconds. Refresh tokens are single-use, replacement pairs must be stored, and replaying an old refresh token revokes the grant. Revoked access requires reauthorization. These are documented contracts, not observations of this account. [Authentication](https://developers.buffer.com/guides/authentication.html).

`notes:write` is not needed for Substack publishing: Substack Notes use `createPost`; Buffer also has its own [Note entity](https://developers.buffer.com/types/Note.html). Do not add permissions merely because the product calls the content a Note.

Read `account.id` and organization IDs; do not use email as stable identity. [Account schema](https://developers.buffer.com/types/Account.html). Discover channels within organizations, then validate the manually configured channel ID. Check `service == substack`, organization identity, `isDisconnected`, `isLocked` and `allowedActions`; `scheduleUpdates` is the relevant documented action name. Also surface `isQueuePaused`: paused queues do not publish scheduled posts. This is a useful setup/preflight diagnostic, not permission to unpause a user's queue. [Channel schema](https://developers.buffer.com/types/Channel.html), [channel actions](https://developers.buffer.com/types/ChannelAction.html).

## Create request and response

Send one GraphQL mutation to `https://api.buffer.com`, using variables. Always include `assets: []`, `channelId`, `needsApproval: false`, `saveToDraft: false`, `schedulingType: automatic` and `mode`. The input schema marks `assets` and `needsApproval` required even though guide examples omit them; follow the schema. Immediate uses `shareNow`; a schedule uses `customScheduled` plus approved UTC `dueAt`. [CreatePostInput](https://developers.buffer.com/types/CreatePostInput.html), [ShareMode](https://developers.buffer.com/types/ShareMode.html), [scheduling guide](https://developers.buffer.com/guides/posts-and-scheduling.html).

For a card, add only `metadata.substack.linkAttachment.url`; no card means omit metadata. A link attachment cannot coexist with nonempty media assets. Title/description/thumbnail overrides are optional and unnecessary for version one. [Substack metadata input](https://developers.buffer.com/types/SubstackPostMetadataInput.html), [link input](https://developers.buffer.com/types/LinkAttachmentInput.html).

Select these actual output fields:

```graphql
mutation KippCreateNote($input: CreatePostInput!) {
  createPost(input: $input) {
    __typename
    ... on PostActionSuccess {
      post {
        id channelId channelService text status dueAt
        shareMode schedulingType isCustomScheduled sharedNow externalLink
        metadata {
          ... on SubstackPostMetadata { linkAttachment { url expandedUrl } }
        }
      }
    }
    ... on MutationError { message }
  }
}
```

The output uses `shareMode`, not input's `mode`; nullable `schedulingType` must be validated rather than assumed. `externalLink` is nullable. Metadata is a union requiring the Substack fragment. [Post schema](https://developers.buffer.com/types/Post.html), [metadata union](https://developers.buffer.com/types/PostMetadata.html), [Substack metadata](https://developers.buffer.com/types/SubstackPostMetadata.html), [link output](https://developers.buffer.com/types/LinkAttachment.html).

`PostActionSuccess` returns the saved post; it does not guarantee downstream publication. Validate its identity, content and requested scheduling outcome. Compare scheduled `dueAt` as instants, not raw ISO strings. Return success to Telegram once accepted; no subsequent tracker is needed. [Success schema](https://developers.buffer.com/types/PostActionSuccess.html).

The actual status enum is `draft`, `needs_approval`, `scheduled`, `sending`, `sent`, `error`. Do not validate against legacy input documentation's word `buffer`. A known post ID with an unexpected draft/approval/time/channel/content outcome is **created-unexpected**, never eligible for another create. How `shareNow` initially appears in this account remains a live check. [Status enum](https://developers.buffer.com/types/PostStatus.html).

## Failure classification

| Evidence | Kipp outcome | New create allowed? |
| --- | --- | --- |
| Local validation/auth/channel/time failure before dispatch claim/network send | Definitive no-create | Only explicit eligible Retry after repair |
| Validated `PostActionSuccess`, matching approved outcome | Accepted | No |
| Trusted returned post ID, unexpected state or content | Created-unexpected | No |
| Specific documented pre-create validation rejection | Definitive no-create, only with narrow evidence rule | Only explicit eligible Retry |
| `InvalidInputError`, `UnauthorizedError`, `NotFoundError` or `LimitReachedError` without sufficient pre-create evidence | Unknown by default pending verified rule | No |
| `UnexpectedError`, `RestProxyError`, unrecognized error, partial GraphQL execution error, malformed success, timeout or dropped response | Unknown; preserve any trusted identity | No |

The [payload union](https://developers.buffer.com/types/PostActionPayload.html) contains success and six error types. Their short descriptions identify causes; they do **not** document transactional rollback. [Invalid input](https://developers.buffer.com/types/InvalidInputError.html), [unauthorized](https://developers.buffer.com/types/UnauthorizedError.html), [limit reached](https://developers.buffer.com/types/LimitReachedError.html). Select `__typename` and generic `MutationError.message`; the [REST proxy type](https://developers.buffer.com/types/RestProxyError.html) is deprecated and should not be selected directly. Messages are diagnostics, not an English-text regex authorization protocol.

Buffer explicitly says create has no idempotency key, lost-response retry can duplicate, and invalid-field validation can prove no write. It also specifically documents bad channel ID → `NotFoundError` / `Channel not found`. These support narrow rules, not a blanket whitelist of every union error. Retain the approved conservative unknown terminal outcome; text/time search is not unique operation identity. [Retry guidance](https://developers.buffer.com/guides/efficient-api-usage.html).

GraphQL distinguishes request errors that prevent execution from execution errors that can happen after mutation effects. Absence of `data` alone is not an independently verified Buffer validation-stage marker. Establish the provider's exact validation response before enabling a corresponding rule. [GraphQL request-error specification](https://spec.graphql.org/September2025/#sec-Request-Error-Result).

## Card behavior and remaining account evidence

Buffer explicitly documents API/MCP Substack Notes support, automatic publishing, plain text, 10,000 characters and mutually exclusive attachment types. Substack generates the preview card. A URL is optional; no custom scraper is needed in Kipp. Exact rendering of arbitrary external/Substack URLs remains an account-level check. Buffer-to-Substack disconnection is repaired in Buffer, separately from Kipp's OAuth grant. [Substack support guide](https://support.buffer.com/articles/using-substack-with-buffer-lDbUYyIq4R).

To finish account-level verification, the user needs a Buffer account with the intended Substack channel connected, access to register a confidential app client, and an agreed HTTPS development callback. Keep client secret/tokens in local secret provisioning, never in chat or research fixtures. Then authorize the test connection through the browser. Read-only discovery can obtain the channel ID; the user need not find it manually.

Before any real create, agree the destination and exact text, attachment and scheduled time for each test. Suggested coverage is one immediate text-only Note, one future scheduled Note, and cards for an external URL and a Substack article. These can be meaningful author-approved Notes rather than test filler. Schedule cleanup is a separate authorized action; do not silently delete/revoke anything. Inspecting a rendered card here is test evidence only and adds no production delivery-monitoring requirement.

The follow-on run starts with read-only queries below, using Buffer's API Explorer or a short-lived locally provisioned bearer token. Do not paste bearer tokens into the explorer's query text. The mutation above is ready for the approved input once the authenticated account matches the chosen destination. Capture only allowlisted fields into sanitized fixtures; never persist authorization headers, codes, verifier or token responses. [Quick start and API Explorer](https://developers.buffer.com/guides/getting-started.html).

```graphql
query KippSpikeIdentity {
  account { id organizations { id } }
}

# Run separately for each returned organization ID.
query KippSpikeChannels($organizationId: OrganizationId!) {
  channels(input: { organizationId: $organizationId }) {
    id organizationId service name allowedActions
    isDisconnected isLocked isQueuePaused
  }
}
```

For OAuth, inspect the returned scope set and expiry without recording secrets; perform one normal refresh and verify a replacement refresh token is persisted. Do not deliberately replay the old token against a real grant merely to confirm revocation. That destructive negative check is unnecessary for this spike. For the scheduled create, compare returned `dueAt` to the agreed UTC instant. For each URL card, use the corresponding approved URL as metadata and inspect the saved metadata; a later visual card check can establish rendering without extending Kipp's completion contract.

Live acceptance, normal refresh rotation, channel permissions and both card types are now verified in the executed results below. Revoked-grant behavior was not deliberately induced. Generic typed error rollback remains undocumented; confirming it requires stronger first-party evidence, not merely a successful local simulation.

## Approved queue extension

The author subsequently approved queue placement. Add mode addToQueue with schedulingType automatic and no dueAt, retaining required assets: [] and needsApproval: false/saveToDraft: false. Buffer chooses its next available posting-schedule slot. Select and retain the returned dueAt when available; it is not an exact timestamp chosen by Kipp. Verify queue shareMode and non-draft automatic acceptance, and include queue placement/assigned-time evidence in the pending live checks. [Scheduling guide](https://developers.buffer.com/guides/posts-and-scheduling.html), [ShareMode enum](https://developers.buffer.com/types/ShareMode.html).

## Live account tests passed and all test content was removed

Executed 10 November 2026 with the user's authorization for sensible primary-account test Notes, cleanup and the existing ngrok callback tunnel. The receiver used PKCE, five-minute single-use state/cookie validation and encrypted ignored local grant storage. The user approved Buffer consent. No request URLs, token values or callback codes were written to research fixtures.

| Check | Observed result |
| --- | --- |
| OAuth and discovery | All four requested scopes, refresh token present, one connected/unlocked/unpaused Substack channel with scheduleUpdates permission |
| One normal refresh | HTTP 200; access and refresh tokens both changed; replacement grant persisted encrypted before further calls |
| Text-only exact schedule | PostActionSuccess, scheduled, automatic, customScheduled; response dueAt exactly matched input |
| Queue placement | PostActionSuccess, scheduled, automatic, addToQueue; input omitted dueAt and Buffer assigned it |
| Scheduled external and Substack article links | Both returned the exact linkAttachment.url; expandedUrl was an empty string |
| Immediate external and Substack article Notes | Both create responses returned sent, shareNow, sharedNow true and a public externalLink |
| Actual cards | User visually confirmed both embedded cards rendered correctly |
| Cleanup | Four future entries returned DeletePostSuccess; user confirmed native deletion of both published Notes |

Captured, sanitized evidence: [live fixtures](fixtures/buffer-live-spike-2026-11-10.json). Initial [synthetic fixtures](fixtures/buffer-contract-spike.json) remain separate and labelled. The local [receiver and CLI](../../tools/spikes/notes-buffer/README.md) are retained for reproduction. Five local OAuth/security checks passed. Temporary receiver and tunnel were stopped after the run.

Important observed distinctions: Buffer permits deleting the scheduled test entries, while sent posts omit deletePost from allowedActions and require native Substack cleanup. Link metadata need not contain expandedUrl even when the actual card renders correctly. Immediate success returned a public URL in these two cases; the workflow must still allow accepted responses without one. Do not turn these observations into guarantees for every account or URL.

No delivery after a future due time was observed because those entries were deliberately removed. No live response-loss fault, token reuse or revocation was induced; local workerd recovery tests and conservative unknown handling cover the designed response to those cases. None of this adds a production delivery tracker or changes Buffer acceptance as the workflow completion boundary. Production OAuth/vault/Notes integration, deployment provisioning and editorial prompt study remain implementation/release work.
