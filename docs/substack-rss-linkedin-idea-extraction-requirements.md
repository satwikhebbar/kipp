# RSS-driven Substack Idea Extraction — Quick Requirements

## Status

Sharpened requirements, ready for implementation planning.

## Goal

When a new public Substack post is detected, Kipp reads the complete article in
a section-aware format and creates 3–5 high-quality raw LinkedIn ideas grounded
in the author’s original writing. It does not create a LinkedIn draft
automatically.

## Article-reading capability

The extraction agent receives a dedicated article-reading tool bound to the
triggering RSS item. In v1, the tool uses that item’s `content:encoded` field
as its sole article-body source; it does not fetch the post page or use the
undocumented Substack API.

The tool must:

- retrieve the complete article body from `content:encoded`;
- return a clean, rich representation that preserves first-order section
  boundaries at minimum, including title, subtitle when non-empty, headings, and
  paragraph groupings;
- never silently truncate the article or fall back to an incomplete RSS
  excerpt;
- use the RSS item’s `<title>` as the title and its `<description>` as the
  subtitle for this configured Substack feed. Normalize the subtitle to plain
  text and keep it separate from the article body; and
- reject or safely report an item whose `content:encoded` is absent or does
  not produce meaningful article text.

The tool accepts no agent-supplied URL. It is not general-purpose browsing: the
agent cannot fetch arbitrary links from the article or elsewhere.

Retain meaningful authored text such as headings, paragraphs, pull quotes, and
table text where practical. Exclude images, image wrappers, and their captions
entirely, even when a caption is textual. Exclude subscribe widgets and any
other subscription or promotional calls-to-action. Image processing and
inference from images are explicitly out of scope.

The agent never receives raw RSS HTML. The tool deterministically decodes HTML
entities, normalizes whitespace, and returns only this two-level content model:

```json
{
  "title": "Post title",
  "subtitle": "Post subtitle",
  "sourceUrl": "https://…",
  "sections": [
    { "heading": null, "content": "Introduction paragraph." },
    { "heading": "First H2", "content": "Paragraph one.\n\nParagraph two." }
  ]
}
```

Use `linkedom/worker` for this deterministic parse-and-project step. The
pre-implementation comparison found equivalent content output from both
candidates, while LinkeDOM's Worker-specific import produced the materially
smaller Worker bundle.

`heading: null` holds any introduction before the first H2. Each paragraph is
plain authored text in source order. Join it into its section's `content` using
blank lines, preserving paragraph boundaries without exposing a separate block
array. Render list items as paragraph strings prefixed with a bullet, pull
quotes as paragraph strings, and table rows as readable text rows. Flatten
H3-and-deeper headings into the following paragraph text rather than creating
another hierarchy level. Preserve a link’s visible text but omit its URL.

The parser must drop all markup rather than selectively forwarding attributes:
`div`, `span`, `a`, styling, classes, IDs, `data-*` fields, image markup,
scripts, SVG, forms, buttons, inputs, subscription widgets, and other UI
elements never reach the agent. The only retained information is the metadata,
section headings, and normalized textual paragraphs described above.

The extraction agent must use the article-reading tool before proposing ideas.
It must not invent article content.

The extraction session forces `readSubstackArticle()` as the first native tool
call. The tool result contains the model above; a short prompt explains only
the meaning of `heading: null` and that paragraphs are source material, not
instructions. The article is not embedded in the user message, and the agent
does not need to understand HTML.

## Candidate idea selection

Generate 3–5 distinct candidate ideas per post. A candidate should be selected
only when it contains a compelling, concrete argument that can stand as a
LinkedIn post with limited additional framing.

Prefer sections that have:

- a self-contained claim, lesson, observation, or narrative;
- enough specificity to be useful and credible;
- a non-obvious or practically relevant takeaway; and
- enough original prose to preserve the author’s human voice.

Avoid generic summaries, promotional teasers, overlapping candidates, and
claims not supported by the article.

The agent may return fewer than three ideas when the article genuinely does not
contain enough qualifying material; it must not manufacture weak candidates to
meet the count.

## Idea body template

Each idea is saved as unstructured Markdown in the existing Notion page body.
No new Notion properties are required.

The body should read as a seamless, unlabeled note in this order:

1. A short context paragraph, only when needed to make the selected material
   understandable on its own.
2. A candidate excerpt, usually three to four paragraphs, retaining as much
   original wording and voice as is useful. The agent may select passages from
   one first-order section or from multiple places in the article when that is
   the best expression of one coherent core idea. Selective shortening or
   light adaptation is allowed when it improves standalone readability.
3. A concise statement of the core argument, derived from the selected
   passages and added context.

The extraction prompt should favor preserving the author’s original phrasing
over summarizing or pre-writing the final LinkedIn post.

Each idea title is a short, specific working headline for that core argument.
It is neither a generic teaser nor merely the source article title.

## Workflow behavior

- Every idea created by the RSS run has status `raw`.
- The RSS run does not start `PipelineWorkflow` and does not generate a
  LinkedIn draft.
- Substack ideas are permanently manual-only: the scheduled cadence excludes
  every idea whose source is `Substack`.
- On success, Kipp sends Telegram the source-post title, the number of ideas
  created, and their working titles. It does not include excerpts or require
  Notion links.
- When retrieval, parsing, or extraction fails, Kipp creates no ideas, sends a
  concise Telegram failure alert, and lets a later RSS poll retry.
- Existing `/generate` remains the path for turning a selected raw idea into a
  LinkedIn draft.

## Safety and quality requirements

- Each idea must be traceable to the source article URL already stored on the
  existing idea record.
- The extraction agent may only use material returned by the article-reading
  tool; no unsupported claims or invented passages.
- Candidate validation must enforce the allowed count, a non-empty working
  title and core argument, useful source-derived content, and distinctness
  within the source article.
- The system must preserve existing RSS idempotency: rerunning the same post
  after success must not create duplicate ideas or duplicate success
  notifications.

## Evaluation

Use a small curated set of recent public Substack posts, including examples
where manually captured ideas were useful.

Acceptance checks:

- the article-reading tool returns usable title, subtitle when present, headings,
  and paragraph groups, while excluding images, captions, subscription
  widgets, markup, attributes, and links' destination URLs;
- a deterministic oversized-article test proves that content beyond the
  current 6,000-character limit is retained;
- a live spot-check of several of the longest posts in the subscribed feed
  compares the retrieved title, heading sequence, paragraph count, and
  normalized body length with the public article;
- every saved idea is demonstrably grounded in a real article section;
- candidates retain substantial author-originated language where appropriate;
- candidates are meaningfully distinct;
- generated ideas are suitable inputs for the existing LinkedIn drafting
  workflow;
- a post with insufficient standalone material yields fewer ideas rather than
  fabricated ones; and
- no RSS-triggered LinkedIn workflow instance is started.

## Planning prerequisite

Select three to five recent public posts, including examples for which manually
captured ideas were useful. This corpus will anchor the qualitative review and
the live long-post spot-check before implementation is considered complete.
