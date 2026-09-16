# Cheerio vs. `linkedom/worker` for Substack RSS HTML

## Decision in brief

Both libraries are suitable for turning the known `content:encoded` HTML
fragment into the compact `Post -> H2 section -> content` structure provided
to the extraction agent. Neither needs to expose HTML, attributes, image
markup, captions, or subscribe UI to the model.

**Decision: use `linkedom/worker`.** Both candidates produced identical
agent-facing text for the captured 27,042-character RSS body and the shared
synthetic edge case. Both exact imports bundled successfully as Workers, but
the LinkeDOM probe was 367.44 KiB (87.35 KiB gzip), versus Cheerio's 679.60
KiB (164.20 KiB gzip). Against the 22.34 KiB (5.39 KiB gzip) empty-probe
baseline, LinkeDOM adds about 345 KiB uncompressed / 82 KiB gzip, and Cheerio
adds about 657 KiB / 159 KiB gzip. LinkeDOM's explicit Worker export and this
roughly 312 KiB uncompressed difference resolve the comparison without needing
to invoke familiarity as a tie-breaker.

## Head-to-head

| Concern | Cheerio | `linkedom/worker` | Consequence here |
| --- | --- | --- | --- |
| API style | A small, jQuery-like selection and manipulation API: select, remove, traverse, then read text. | A DOM-like API: `DOMParser` / `parseHTML`, `querySelectorAll`, node traversal, and `textContent`. | Cheerio makes the proposed removal-first transformation especially compact. LinkeDOM is equally clear for engineers who prefer browser DOM APIs. |
| CSS selectors | jQuery-style selectors and traversal; its API is built around `$()`. | CSS-selector queries on `document` and elements. | Both can deterministically remove `figure`, `figcaption`, `.subscription-widget`, forms, scripts, SVG, and other known noise before collecting text. |
| HTML semantics | Default `load` uses `parse5`, which Cheerio describes as standards-conformant and browser-tree-equivalent. `load(..., null, false)` parses the RSS value as a fragment rather than injecting `html`, `head`, and `body`. | LinkeDOM supplies a fast, DOM-like implementation but explicitly does not aim for complete browser-standard behavior. Its worker entry is a self-contained Worker-oriented build. | Cheerio's default parser is the safer default if the RSS HTML is occasionally malformed. LinkeDOM's deliberately smaller DOM semantics are more than adequate for the currently known feed HTML. |
| Entity and text handling | Parsing then reading `$(element).text()` yields text rather than markup; parse5 handles normal HTML entity parsing. | Parsing then reading `element.textContent` yields text rather than markup; the worker build includes HTML entity decoding. | Either removes attributes and decodes entities as part of a deterministic parse-and-project step. Normalization of whitespace remains our own small function. |
| Cloudflare Worker fit | Current package metadata publishes a browser conditional export and says browser builds support `load`; its other loaders rely on Node APIs and are absent there. This must still be proved with this project's Wrangler bundle. | The project explicitly documents `linkedom/worker` for Web and Service Workers and its package exports matching types. | LinkeDOM has the stronger explicit Worker guarantee. Cheerio no longer has a blanket Node-only problem, but the exact import must be bundled and dry-run deployed. |
| Dependencies and bundle | The package declares ten direct runtime dependencies, including `parse5`, `htmlparser2`, and `undici`; browser conditional exports plus `sideEffects: false` give the bundler a chance to omit unavailable features. | The package declares five direct dependencies; the worker export points at a monolithic `worker.js` and omits `canvas`. | Dependency count is not a reliable bundle-size measurement. Measure the actual Wrangler output for the one import and reject an unexpectedly expensive result. Cloudflare cautions that larger uncompressed bundles can increase startup time. |
| TypeScript | Ships type declarations for normal, browser, and `slim` exports. | Ships type declarations for its worker export. | No separate `@types` package is needed for either choice. |
| Smaller variant | `cheerio/slim` omits `parse5` and always uses `htmlparser2`, trading browser-equivalent parsing for lower memory use. | The worker export is already the intended Worker-specific variant. | Do **not** optimize to `cheerio/slim` first. Compare it only if the full Cheerio bundle or fixtures justify accepting different parsing semantics. |

## What the extraction looks like

The two approaches are intentionally almost identical in behavior. This is
illustrative only; the final implementation must avoid duplicate text from
nested list/quote elements and be covered by the realistic RSS fixtures.

```ts
// Cheerio: parse a known HTML fragment, remove noise, then walk content nodes.
const $ = cheerio.load(contentEncodedHtml, null, false);
$("figure, figcaption, .subscription-widget, form, script, style, svg").remove();

$("h2, p, li, blockquote, td, th").each((_, element) => {
  const text = normalizeWhitespace($(element).text());
  // An h2 starts a section; retained text appends to that section's content.
});
```

```ts
// LinkeDOM: same policy expressed with ordinary DOM APIs.
const document = new DOMParser().parseFromString(
  `<body>${contentEncodedHtml}</body>`,
  "text/html",
);
for (const element of document.querySelectorAll(
  "figure, figcaption, .subscription-widget, form, script, style, svg",
)) element.remove();

for (const element of document.querySelectorAll("h2, p, li, blockquote, td, th")) {
  const text = normalizeWhitespace(element.textContent ?? "");
  // An h2 starts a section; retained text appends to that section's content.
}
```

The important work is not parsing HTML: it is the explicit content policy
(which elements count as a paragraph, which subtrees never count, and how to
avoid nested-text duplication). Both libraries make that policy deterministic
and easy to fixture-test.

## Pre-implementation parser comparison

This is a short, neutral selection spike—not a pre-commit validation of
Cheerio. It compares full Cheerio and `linkedom/worker` before either becomes
the implementation dependency. Each library must parse the same fixtures and
produce the same expected article model.

The Cheerio side uses the exact import proposed for production:

```ts
import * as cheerio from "cheerio";
const $ = cheerio.load(contentEncodedHtml, null, false);
```

The spike must not call a live Substack endpoint from its deterministic tests.
The LinkeDOM side uses its Worker-specific export. Create one committed fixture
from the captured RSS `content:encoded` body, plus one small synthetic fixture
for edge cases. Keep the tests with the RSS/article reader unit suite; do not
create a one-off test harness.

### Shared correctness checks

Using *The Reps We Are Losing* as the production-shaped fixture, prove that
each parser returns the agent-facing model rather than HTML:

```json
{
  "title": "The Reps We Are Losing",
  "subtitle": "How agentic coding can erode the learning loops that build senior engineers",
  "sourceUrl": "…",
  "sections": [{ "heading": null, "content": "…" }, { "heading": "…", "content": "…" }]
}
```

- The RSS `<title>` becomes `title`; its `<description>` becomes `subtitle`.
- The pre-H2 introduction becomes exactly one `heading: null` section.
- The nine H2 headings are retained in their original order, with their text
  assigned only to the correct section.
- Paragraphs remain in source order and are separated by exactly one blank
  line in section `content`.
- Normal text retains human-readable entity decoding—for example, a curly
  apostrophe appears as `’`, not `&#8217;`.
- Link text remains, while link destinations never appear in output.
- List items, pull quotes, and table cells become readable text without
  duplicated nested text.
- The final post material remains present, proving that content after the
  former 6,000-character limit is not lost.
- The returned result contains no `<` markup, `class=`, `data-`, image URLs,
  `substackcdn`, or destination URLs.
- It excludes known non-content text from the fixture, including the figure
  captions “Understanding grows with each rep” and “The skipped staircase of
  reps”, and the subscription call to action “Subscribe for free”.

### Shared synthetic edge cases

Add a small fixture that combines a nested list, inline link, pull quote,
table, H3, figure/caption, subscription form, and malformed-but-recoverable
HTML. Assert that only the approved textual content appears, H3 creates no
third hierarchy level, and malformed markup cannot cause a noisy subtree to
leak into a section.

### Comparative Worker and bundle checks

Run the same checks for each candidate independently:

1. Add the candidate temporarily, implement only the small parser adapter
   needed to satisfy the shared fixture suite, then run its unit tests,
   typecheck, and lint.
2. Run the project’s normal `pnpm run deploy:check`, which bundles the actual
   Worker. A missing browser export, Node built-in/polyfill failure, or
   unsupported runtime API disqualifies that candidate.
3. Record the Worker bundle size reported by the build and compare its increase
   with the current baseline. Also record the adapter's implementation size and
   any parser-specific workaround required by the fixtures.
4. Run the required live long-post spot-check once with the selected candidate.
   It verifies the RSS source remains complete; it is not an iteration loop for
   parser behavior.

### Selection rule

Choose only from candidates that pass every shared correctness assertion and
the Worker bundle/deploy check. If both qualify, choose the one that meets the
expected output with fewer parser-specific workarounds and a proportionate
bundle increase. Familiarity with Cheerio is a valid tie-breaker; it is not a
reason to accept a Worker or output-quality regression. Compare
`cheerio/slim` only if full Cheerio qualifies functionally but its measured
cost is the only concern, because the slim build changes the parsing trade-off.

## Comparison result — 2026-09-16

The pre-implementation spike used the current RSS capture for *The Reps We
Are Losing* (27,042 characters; nine H2 sections; 65 paragraphs; 20 list
items; three excluded figures/captions) and the documented synthetic malformed
HTML case. Each candidate returned ten sections—the introduction plus the nine
H2 headings—in the same order, with 10,498 characters of normalized text.
Both decoded entities, preserved visible link text without URLs, excluded
captions and subscribe UI, emitted no HTML or attributes, retained material
well beyond 6,000 characters, and avoided duplicate nested text.

Wrangler dry-runs used the production compatibility date and
`nodejs_compat` flag. Both candidates bundled successfully. The measured
Worker probe sizes were:

| Probe | Upload | Gzip | Increment over empty probe |
| --- | ---: | ---: | ---: |
| Empty Worker | 22.34 KiB | 5.39 KiB | — |
| `linkedom/worker` | 367.44 KiB | 87.35 KiB | +345.10 KiB / +81.96 KiB gzip |
| Cheerio | 679.60 KiB | 164.20 KiB | +657.26 KiB / +158.81 KiB gzip |

The empty probe is not the application bundle and therefore does not predict
the final deployment size. It is a like-for-like import-cost measurement. The
selected `linkedom/worker` dependency remains installed; the rejected Cheerio
dependency was removed.

## Primary sources

- [Cheerio: loading documents](https://cheerio.js.org/docs/basics/loading/)
  documents browser availability, fragment parsing, and the Node-only loaders.
- [Cheerio: configuring parsers](https://cheerio.js.org/docs/advanced/configuring-cheerio/)
  documents the default `parse5` behavior and `cheerio/slim` trade-off.
- [Cheerio package metadata](https://raw.githubusercontent.com/cheeriojs/cheerio/main/package.json)
  shows browser conditional exports, built-in types, `sideEffects`, and direct
  dependencies.
- [LinkeDOM README](https://github.com/WebReflection/linkedom) documents its
  DOM APIs, selector support, explicit Web/Service Worker export, and its
  intentionally non-complete browser-compatibility goal.
- [LinkeDOM package metadata](https://raw.githubusercontent.com/WebReflection/linkedom/main/package.json)
  maps the `./worker` export and its types and lists direct dependencies.
- [Cloudflare Worker limits](https://developers.cloudflare.com/workers/platform/limits/)
  describes bundle limits and the startup-cost implications of larger bundles.
