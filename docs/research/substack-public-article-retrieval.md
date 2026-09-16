# Public Substack Article Retrieval for RSS Idea Extraction

**Research date:** 2026-09-16  
**Scope:** public posts from the configured `satwikhebbar.substack.com` publication;
no authenticated or paid content.

## Decision

For v1, use only the triggering RSS item's `content:encoded` field. It already
contains full rich article HTML for the checked public post and avoids a second
network dependency. Do not introduce a fallback adapter, browser runtime, or a
third-party scraping service until live evidence shows that this source is
insufficient for a post that should be processed.

This is the least complex option that returns the author-written headings,
paragraphs, lists, quotations, and tables needed to select an idea.
It also preserves the requirement that the agent gets content through one
narrow tool rather than being given general web access.

## What the public publication currently provides

A direct check of the configured [RSS feed](https://satwikhebbar.substack.com/feed)
on 2026-09-16 returned HTTP 200 XML (412,565 bytes). Its latest item,
[The Reps We Are Losing](https://satwikhebbar.substack.com/p/the-reps-we-are-losing),
includes a `content:encoded` HTML payload with the complete post body: `<p>`
paragraphs, `<h2>` headings, lists, pull quotes, and image captions. The
extractor will omit the image/caption elements; the remaining body is still
substantially richer than the item's `description`, which this configured feed
uses as the post subtitle rather than as article body.

A direct check of that [public article page](https://satwikhebbar.substack.com/p/the-reps-we-are-losing)
also returned HTTP 200 HTML (182,632 bytes) without a session. The server
rendered body is inside `.dt-post-body .body.markup`; headings and ordinary
prose are already in semantic HTML. The page additionally exposes an
`application/ld+json` `NewsArticle` with title, canonical URL, dates, and
`isAccessibleForFree: true`, but not the full article body. These are direct
observations of Substack's public output, not a promise of a versioned API.

A direct check of
[`/api/v1/posts/the-reps-we-are-losing`](https://satwikhebbar.substack.com/api/v1/posts/the-reps-we-are-losing)
returned HTTP 200 JSON (34,448 bytes) with `body_html`, `title`,
`canonical_url`, `audience`, `truncated_body_text`, and `wordcount`. A second
publication returned the same full-content response shape for both
`/api/v1/posts?limit=1&offset=0` and `/api/v1/posts/{slug}`. Substack does not
document this as a public developer API, so it is an observed interface rather
than a durable contract.

## Options considered

| Option | What it gives us | Advantages | Limitations | Decision |
| --- | --- | --- | --- | --- |
| Observed JSON post endpoint (`/api/v1/posts/{slug}`) | `body_html` plus title, canonical URL, audience and post metadata | Cleanest observed rich-content representation; avoids page chrome | Undocumented and unversioned, so it may change or disappear | Not used in v1; retain only as a comparison/reference route |
| RSS `content:encoded` | HTML embedded in the item that triggered the run | Already fetched; in this publication it currently includes full post structure | Feed shape and completeness are publisher/platform behaviour, not an application contract | **Use as the sole v1 body source, after completeness checks** |
| Public article HTML | Server-rendered semantic article content at the canonical post URL | Uses the URL supplied to the tool; complete for the observed public post; no credentials, binding, or extra vendor | CSS classes and markup can evolve; parser needs selectors plus content-quality checks | Future option only if RSS proves insufficient |
| Embedded JSON-LD | Metadata on the public page | Useful corroboration of title, canonical URL, public availability | Does not contain article body in the checked page | Metadata validation only |
| Hydration data or another undocumented endpoint | Potentially structured data discovered by reverse engineering | Could add metadata | No documented public full-content API was found; contracts, auth rules, and availability can change without notice | Do not add another dependency |
| Cloudflare Browser Rendering | Browser-executed DOM, screenshots, JavaScript-only pages | Escapes a JavaScript-rendering problem if one appears later | Requires a new binding and has usage/cost limits; unnecessary because the observed page is server-rendered. Cloudflare documents [Browser Rendering pricing and included limits](https://developers.cloudflare.com/changelog/post/2025-07-28-br-pricing/) | Explicit fallback of last resort, not in v1 |
| Third-party extraction/scraping API | Normalized article extraction | May be useful if the supported-source scope expands beyond Substack | New credentials, external transfer of author content, cost/reliability/privacy dependency, and an unnecessary broad integration for one known site | Do not use in v1 |

## Recommended v1 tool contract and retrieval algorithm

The agent-facing operation should be conceptually `readSubstackArticle()`.
It receives no arbitrary URL parameter: the implementation binds it to the
current RSS item. This keeps SSRF and prompt-induced browsing out of scope.

1. Read the item title and its `description`, which the configured Substack
   feed uses as the post subtitle. Keep that subtitle separate from article
   body.
2. Convert `content:encoded` into ordered structured blocks, preserving at
   minimum headings, paragraphs, list items, block quotes, and table text.
   Exclude images, their wrappers and captions, subscribe widgets, and other
   promotional calls-to-action. Decode entities and emit only a simple Post →
   H2 section → content hierarchy, joining retained paragraphs with blank
   lines. No raw tags, attributes, or link destinations enter the LLM context.
   Give each retained block a stable ordinal internally before joining it under
   its first-order heading.
3. Run content-quality checks before returning: non-empty title and body,
   enough prose, and a plausible heading/paragraph sequence. Do not truncate
   the input or use `description` as article body.
4. If the body fails those checks, return a typed retrieval failure. The RSS
   workflow creates no ideas and alerts Telegram, as specified in the
   requirements.

The implementation will use `linkedom/worker` to parse the RSS HTML fragment
and project it into the compact JSON/text block model before it enters the
agent context. A direct pre-implementation comparison found it produced the
same required content model as Cheerio, with a substantially smaller Worker
bundle. Cloudflare's streaming selector-based
[HTMLRewriter](https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/)
remains an alternative only if later evidence requires a different trade-off.

## Why RSS is sufficient for v1

RSS is both the trigger source and, in the observed feed, a complete rich HTML
representation of the article. It is publicly delivered by the same first
party, costs no additional request, and has no article-page chrome to remove.
The inspected RSS and API bodies have identical document structure; their only
observed difference is entity serialization (for example, RSS `&#8217;` versus
the API's Unicode apostrophe).

RSS remains a syndication representation: individual publishers can configure
excerpts and Substack can change feed policy. That is a reason to validate each
item and maintain the long-post contract test—not a reason to build fallbacks
before we have evidence they are needed.

## Guardrails and tests to carry into implementation

- No fixed character truncation. Apply explicit response-size and time limits
  only to protect Worker resources; an over-limit result is a retrieval failure,
  not a silently shortened article.
- Reject items whose rich body is absent or has no meaningful article blocks.
- Keep full authored text only long enough for this workflow. Do not log the
  article body in ordinary operational logs.
- Unit-test HTML-to-block extraction using fixtures with headings, paragraphs,
  lists, pull quotes, captions, a table, subscribe widgets, and content after
  6,000 characters.
- Contract-test the configured public feed and a small long-post corpus by
  comparing the parsed title, heading sequence, paragraph count, and normalized
  body length against the public article page.

## Open implementation choices (not product requirements)

1. **Allowed-host policy:** start with the configured feed's publication host
   and explicitly list any canonical host variants encountered in live tests;
   do not allow arbitrary `*.substack.com` redirects by default.
2. **Resource ceilings:** choose Worker-safe byte, elapsed-time, and redirect
   limits after the required long-post spot check. The user requirement is no
   silent truncation, not unlimited input.
