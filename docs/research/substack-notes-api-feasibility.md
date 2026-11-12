# Substack Notes API feasibility

Investigated 6 November 2026. Scope: documentation and source review only; no authenticated API calls, account connections, or publishing tests.

## Finding

**A Kipp draft → Telegram review → approved Note publishing workflow is feasible through a supported intermediary API. Direct, self-service Substack Notes publishing API access for Kipp is not established by the public documentation reviewed.**

| Route | Evidence | Assessment |
| --- | --- | --- |
| Direct Substack developer API | Public API terms cover public creator/publication data and discovery integrations. The linked technical documentation returned 404 during this investigation. | No documented direct Notes write route found; this does not prove that partner access is unavailable. [Substack API terms](https://substack.com/api-tos) |
| Buffer API | Buffer explicitly supports creating and scheduling Substack Notes through its API and MCP. It connects by redirecting to Substack for authorization. | Supported integration route; best first candidate to validate. [Buffer Substack guide](https://support.buffer.com/articles/using-substack-with-buffer-lDbUYyIq4R) |
| Typefully API | Current API schema includes `platforms.substack` and `substack_published_url`. Its Notes guide describes Substack authorization and immediate or scheduled publishing. | Another documented intermediary route. [Typefully API](https://typefully.com/docs/api), [Notes guide](https://support.typefully.com/en/articles/16124373-publish-and-cross-post-to-substack-notes) |
| Unofficial internal API | A reverse-engineered reference documents session-cookie authentication and `POST /api/v1/comment/feed` for Notes, while explicitly warning that endpoints are unsupported and can change. | Technically plausible, but runtime reliability is unverified and unsuitable as the default simple integration. [Source repository](https://github.com/AnthonyDavidAdams/substack-api-reference) |

Buffer states its integration uses Substack's official API in partnership with Substack. This is evidence that supported partner writes exist, not evidence that Kipp can register for the same direct access. [Buffer scheduling explanation](https://buffer.com/resources/schedule-substack-notes/)

## Intended Kipp behavior

The user clarified that the workflow should publish the approved Note, rather than hand off a native Substack draft for manual editing and publication. Review and revision can happen within Kipp; a publishing API call is the intended terminal action. An intermediary draft is optional implementation detail, not the requested outcome. This remains a feasibility investigation, with no implementation or publishing test authorized by this clarification.

## Authentication and draft behavior

**Buffer:** connect Substack once through Buffer's authorization flow, then have Kipp call Buffer's GraphQL endpoint `https://api.buffer.com` with a personal API key in `Authorization: Bearer …`. Buffer's generic `createPost` mutation supports `saveToDraft: true`; the resulting draft is not published until explicitly scheduled. These are Buffer drafts, not demonstrated native Substack composer drafts. [API quick start](https://developers.buffer.com/guides/getting-started.html), [draft creation](https://developers.buffer.com/examples/create-draft-post.html)

**Buffer OAuth alternative:** current developer documentation also supports
registered App Clients using OAuth 2.0 Authorization Code with mandatory PKCE.
Clients are registered in Settings → API → App Clients. Kipp could offer a
Connect Buffer flow instead of requiring a personal API key. Substack still
needs to be connected to Buffer separately. Access tokens last about one hour;
`offline_access` enables refresh tokens. Refresh tokens rotate on every use,
and reusing an old token revokes the grant, so refresh coordination is a design
requirement. This is documented support, not an authenticated account test.
[Building Apps](https://developers.buffer.com/guides/building-apps.html),
[Authentication](https://developers.buffer.com/guides/authentication)

**Typefully:** use a Bearer API key generated in Typefully settings, after connecting Substack in a Social Set. `POST /v2/social-sets/{social_set_id}/drafts` can save a draft, schedule it, or publish it immediately. `publish_at="now"` is asynchronous; subsequent draft retrieval reports completion. This is a Typefully draft lifecycle, not evidence of native Substack draft creation. [API reference](https://typefully.com/docs/api)

Kipp could instead retain drafts internally and call the chosen publishing API only after explicit Telegram approval. That is an architectural inference from the supported publishing operations, not a tested implementation.

## Limits relevant to this workflow

Buffer supports top-level Notes, not replies or restacks. Its integration publishes plain text rather than rich text, does not link mentions, and cannot edit or delete already-published Notes through Buffer. Newsletter articles are outside this integration. Buffer says Substack is available on its current plans, including Free; API entitlement, quotas, and account-specific access should still be checked before choosing a provider. [Buffer Substack guide](https://support.buffer.com/articles/using-substack-with-buffer-lDbUYyIq4R)

Typefully supports Notes rather than newsletter articles; its Notes guide currently excludes video and says multi-post drafts are combined into one Note. [Typefully Notes guide](https://support.typefully.com/en/articles/16124373-publish-and-cross-post-to-substack-notes)

## Decision and remaining uncertainty

### Link cards

Buffer supports link attachments for Substack Notes. Its API explicitly models
them as `metadata.substack.linkAttachment`, with a required `url` and optional
title, description, and thumbnail. Link attachments are not media assets and
cannot accompany a nonempty `assets` array. Do not assume a URL in `text` alone
will create a card through the API. [Hosting media and link attachments](https://developers.buffer.com/guides/hosting-media),
[Substack metadata schema](https://developers.buffer.com/reference.html#SubstackPostMetadataInput)

Buffer says Substack generates the card title, description, and image. Substack's
native Notes composer gives Substack post links special inline presentation;
the documentation reviewed does not guarantee identical rendering through
Buffer's API. Link cards are distinct from native restacks, which Buffer does
not support. [Buffer Substack guide](https://support.buffer.com/articles/using-substack-with-buffer-lDbUYyIq4R),
[Substack Notes FAQ](https://on.substack.com/p/notes-faq?open=false)

Design implication: preserve the intended URL and send it as an explicit link
attachment. Kipp need not scrape the article body or generate card artwork just
to attach a card. Article retrieval as writing context remains separate scope.
Exact Substack article card styling, bare-URL auto-detection, and inaccessible
or redirected link behavior remain untested. A later explicitly approved
publication test must verify rendering; no account-level test was performed.

### Feasibility gate

This is sufficient for a **documentation-level feasibility yes, with an intermediary**, and **direct API access unresolved**. A PRD or grilling interview is unnecessary to answer that gate.

If implementation is pursued, first choose whether the extra service dependency is acceptable. Then verify the chosen account's API entitlement and Substack connection using read-only calls, and validate a draft operation before any explicitly approved publishing test. Check publish-result reconciliation and duplicate prevention before designing retries. No account-level or end-to-end behavior has been verified in this investigation.
