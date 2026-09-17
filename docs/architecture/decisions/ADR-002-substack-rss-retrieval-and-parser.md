# ADR-002: Use RSS `content:encoded` and `linkedom/worker` for Substack extraction

## Status

Accepted for v1.

## Context

The RSS-triggered LinkedIn idea workflow needs the complete public Substack
article, including its authored headings and prose. The triggering feed item
already contains a rich `content:encoded` HTML fragment for the configured
publication. The workflow must reduce that HTML to a small, predictable model
before sending it to the bounded idea agent.

## Decisions

1. Use the triggering RSS item's `content:encoded` as the sole v1 article-body
   source. Use the RSS `<title>` as the article title and `<description>` as
   the subtitle. Reject or report missing/implausibly empty bodies; do not
   silently substitute the description.
2. Parse and project the fragment with `linkedom/worker`. The parser preserves
   headings, paragraphs, lists, block quotes, and table text while removing
   images, captions, subscribe widgets, forms, scripts, and other interface
   markup. The agent receives only the normalized article model, not raw HTML.
3. Keep the article model transient. Persist only the resulting raw Notion
   ideas and the normal idempotency metadata.

## Alternatives considered

- The observed `/api/v1/posts/{slug}` endpoint returned clean `body_html`, but
  it is undocumented and unversioned, so it is not a v1 dependency.
- Public article-page scraping is a viable future option if RSS completeness
  fails, but it depends on page selectors and adds another network path.
- Browser Rendering and third-party extraction services add bindings,
  credentials, cost, privacy exposure, or operational complexity without a
  current need.
- Cheerio produced equivalent agent-facing text in the parser comparison, but
  `linkedom/worker` has an explicit Worker-oriented export and a materially
  smaller measured bundle for this use case.

## Consequences

The implementation is intentionally narrow and easy to replace if the feed
stops carrying complete bodies. Content-quality checks provide an explicit
failure signal instead of generating ideas from incomplete or hallucinated
input. Any future fallback should be introduced as a separate adapter and
decision rather than hidden inside the current parser.
