# YouTube Recipe Discovery Spike — Issue #60

**Status:** research and proposed execution plan  
**Scope:** define and complete the feasibility spike; this is not an implementation design commitment.

## Decision sought

Determine whether Kipp can reliably pre-fetch one *suitable* YouTube recipe
video for each school-lunch and home-lunch meal in a plan, while preferring a
household's configured channels, handling restrictive meal context, and
retaining an explicit no-video result when evidence is insufficient.

The recommendation is **conditionally viable**. The documented YouTube Data
API can retrieve public videos without user authorization and can restrict a
search to videos and, when a trusted source is configured, to one channel.
However, its documented search fields do not establish recipe ingredients or
dietary suitability. Suitability must therefore be conservative and
explainable, based on the planned meal plus video title/description/channel
metadata, with an explicit abstention/no-video outcome rather than an inferred
or popularity-based match.

## Product source of truth

Issue [#60](https://github.com/satwikhebbar/kipp/issues/60) asks the spike to
test representative lunch queries and document viable discovery, ranking,
no-result, metadata-refresh, and compliant caching behavior. It is a
feasibility item under [#59](https://github.com/satwikhebbar/kipp/issues/59).

The linked [v1 product specification](https://github.com/satwikhebbar/kipp/blob/main/docs/school-day-meal-planning-workflow-spec.html#8-recipe-video-behaviour)
sets the non-negotiable product contract:

- Discover ahead of time only for school lunch and home lunch.
- Prefer configured YouTube chefs/channels; a reputable fallback is allowed.
- Assess suitability against the meal, dietary and vegetarian constraints,
  cuisine preferences, and school context.
- Keep the meal and persist an explicit no-video result when no suitable video
  exists; never present generic popularity as a meal recommendation.

The implementation-planning note deliberately leaves the detailed
recipe-source ranking policy to this feasibility work:
[planning decisions](https://github.com/satwikhebbar/kipp/blob/main/docs/school-day-meal-planning-planning-decisions.md#open-feasibility-work).

## Feasible retrieval and evaluation shape

1. Create a Google Cloud project/API key restricted to Kipp's server-side
   environment, enable YouTube Data API v3, and use documented API calls only.
   Public-video search needs no end-user authorization, so user YouTube OAuth
   is not part of this spike. [YouTube developer policies](https://developers.google.com/youtube/terms/developer-policies)
   distinguish public search from actions that need user authorization.
2. For each planned lunch cell, construct a transparent query from the dish
   name plus relevant cuisine/format terms; request `type=video`,
   `safeSearch=strict`, the household `regionCode`, and the appropriate
   `relevanceLanguage` where known. `search.list` supports `q`, `type`,
   `channelId`, `regionCode`, language, SafeSearch, and video-duration filters.
   [API reference](https://developers.google.com/youtube/v3/docs/search/list)
3. Run a trusted-channel pass first (one configured `channelId` per request).
   If it has no eligible candidate, run a bounded general-video fallback.
   Enrich candidate IDs with `videos.list` for current title, description,
   channel, duration, captions, live status, embeddability, and region
   restrictions. [Video resource reference](https://developers.google.com/youtube/v3/docs/videos)
4. Apply a deterministic, recorded gate before ranking:
   reject non-video/live/upcoming results, unavailable-in-region results,
   obvious diet violations, or candidates without enough textual evidence to
   connect them to the planned dish. A candidate must clear the hard gates;
   trusted-channel match then outranks fallback provenance and text match.
   Do **not** use raw view count, likes, or YouTube's default relevance as the
   recommendation score. Product suitability and the user's policies are Kipp
   judgments, not altered YouTube search-result content.
5. Return either a single `found` record (video ID, canonical YouTube URL,
   source channel, captured metadata, retrieval time, policy/ranking reasons)
   or a `no_suitable_video` record (query, attempted sources, rejection counts
   and reason). The latter is a successful business outcome, not a retrieval
   error.

## Acceptance criteria for closing the spike

The spike is complete when it produces a short, reproducible evidence report
and a recommendation that answers all of the following:

| Area | Required proof |
| --- | --- |
| Representative coverage | Execute and record a small fixed corpus: at least one trusted-channel hit, a suitable fallback hit, a clear no-video result, a vegetarian/dietary rejection, and a school-context-sensitive packed-lunch query. Use the intended India region and expected language(s). |
| Retrieval | Record the exact documented request shapes, result counts, candidate IDs, selected result/no-result, and API errors or quota use. Do not collect or store audiovisual files. |
| Ranking | Publish a deterministic gate and tie-break order, with each selected and rejected candidate explained. Demonstrate that a popular but unsuitable candidate loses to a suitable lower-popularity candidate or yields no-video. |
| Metadata | Show which `search.list` fields are insufficient and which `videos.list` fields are fetched to check duration, availability, metadata, and embed suitability. State any remaining inability to verify ingredients/allergens from API data. |
| Caching and refresh | Specify the stored metadata fields, `retrievedAt`, expiry/refresh job, and deletion path. API metadata may only be held temporarily for up to 30 calendar days before deletion or refresh; stored data also needs reasonable efforts to reflect current API data. [YouTube policies](https://developers.google.com/youtube/terms/developer-policies#refreshing-storing-and-displaying-api-data) |
| Compliance and UX | Demonstrate an official YouTube playback/link path with unmodified YouTube title/thumbnail where displayed; no downloaded/cached audiovisual content; privacy review for embedded playback. The policies prohibit caching audiovisual content and require the current Made-for-Kids status to be looked up for embedded videos. [YouTube policies](https://developers.google.com/youtube/terms/developer-policies#handling-youtube-data-and-content) |
| Scale | Calculate expected weekly and daily calls from the corpus and anticipated plan volume, compare with the project's assigned quota, and recommend throttling/backoff and a no-video fallback on exhaustion. Default projects have documented quota limits and additional quota requires an audit. [Quota guidance](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits) |

## Proposed execution sequence

1. **Fixture and policy definition:** choose the fixed meals and household
   contexts above; define the exact hard-rejection markers, sufficient-evidence
   rule, trusted-source configuration format, and output schema before looking
   at results.
2. **Controlled API experiment:** run trusted then fallback searches against
   that corpus; save redacted request/response evidence and candidate
   decisions. Keep calls bounded so the test cannot consume production quota.
3. **Metadata and freshness experiment:** call `videos.list` for chosen and
   borderline candidates; test an unavailable/removed/changed candidate if
   available, then document refresh behavior and UI outcome.
4. **Compliance review:** verify storage fields and retention timer against the
   policy, review the embedded-player/link presentation, and confirm no
   scraping or media caching.
5. **Go/no-go:** recommend (a) a conservative YouTube-first integration with
   the documented guardrails, (b) a limited trusted-channel-only launch, or
   (c) defer because the corpus cannot meet the evidence threshold. Attach the
   corpus results and unresolved product choices.

## Live validation — 2026-08-25

A disposable, non-production probe at
[`tools/youtube-recipe-probe.mjs`](../../tools/youtube-recipe-probe.mjs) used a
locally configured, Kipp-owned API key. It resolved the supplied trusted
handles (Kunal Kapur and Hebbars Kitchen) to channel IDs through
`channels.list`, then exercised `search.list` and `videos.list` in the India
region with English relevance and strict SafeSearch. It did not download
media, persist raw responses, or write the key anywhere.

The probe used four synthetic recipe fixtures plus one targeted fallback
fixture. It demonstrated all required retrieval outcomes:

- a trusted-channel match for an aloo-gobi lunch query;
- a public fallback match with no trusted-source configuration;
- an actual trusted-channel miss followed by a public fallback match for a
  ragi-mudde query;
- explicit rejection of candidates whose returned metadata mentioned `egg`,
  `anda`, or a configured red-chilli alias; and
- an explicit `no_suitable_video` result when an intentionally incompatible
  required ingredient prevented every trusted and fallback candidate from
  passing.

The initial run exposed a critical false positive: a moong-dal chilla candidate
looked like a besan-chilla match because its *description* mentioned besan. The
probe was corrected to require every dish-identity term in the video title,
while allowing ingredient evidence in the title, description, or tags. The
false positive was then rejected and a title-matching trusted result was
selected. This is evidence that a simple bag-of-words metadata test is too
weak.

The four bounded executions made 19 `search.list`, 12 `videos.list`, and 8
`channels.list` calls. The earlier 1,918-unit estimate used a superseded quota
model. Since June 2026, `search.list` uses a separate 100-calls-per-day search
bucket at one unit per call; the 20 `videos.list`/`channels.list` calls use the
ordinary 10,000-units-per-day pool. The figures are an experiment observation,
not a production volume forecast. [YouTube quota calculator](https://developers.google.com/youtube/v3/determine_quota_cost)
No video IDs, titles, descriptions, thumbnails, or raw API payloads are stored
in this repository: API-provided metadata needs a refresh/deletion lifecycle,
whereas Git history cannot provide one.

### Result and guardrail

**Discovery is viable; dietary verification is not.** Kipp can pre-fetch an
explainable *recipe-link match* with trusted-channel preference, bounded
fallback, and truthful abstention. It must not describe that link as verified
safe, allergy-safe, or inherently suitable to watch. The stored result should
instead say which meal and visible metadata it matched, when it was retrieved,
and that the parent must assess the recipe itself.

For a hard allergy or medical exclusion, absence of a conflicting word is not
enough evidence. The v1 integration must either return no video when the
ingredient list is not sufficiently evidenced or use a separately maintained,
verified recipe catalogue. A generic YouTube search cannot satisfy that higher
assurance bar.

## Recommended rolling recipe-match cache

Cache the *Kipp recipe-link decision*, not video media. Reusing a valid match
for a recurring meal avoids a new expensive search every week, but YouTube API
data must be deleted or refreshed within 30 calendar days. Use a 28-day
expiry. There is no proactive batch-refresh job: an expired entry is a cache
miss and is refreshed only when that meal needs a recipe link again.
[YouTube data-storage policy](https://developers.google.com/youtube/terms/developer-policies#refreshing-storing-and-displaying-api-data)

The cache key must include every factor that can change the decision:

```text
canonical meal + required ingredients + hard exclusions + meal format
+ region + language + trusted-channel configuration revision
+ selection-policy version
```

The cached record contains only the minimum provider-backed fields needed to
render and revalidate the link: `videoId`, canonical URL, source-channel ID,
matched metadata/rule reasons, `retrievedAt`, `expiresAt`, and either `found`
or `no_suitable_video`. Treat all provider-derived fields and their derived
selection reasons as 30-day data; do not place them in Git history, permanent
analytics, or a general long-term recipe catalogue.

| Event | Cache action | Discovery cost |
| --- | --- | --- |
| Exact fresh key on a new weekly plan | Reuse the stored match | No search call |
| Fresh cache miss | Run trusted-first discovery | 1–3 searches per lunch cell |
| Entry reaches 28 days | Do not serve it. The next matching meal is a cache miss and calls `videos.list` for that one prior video ID | One low-cost metadata call for the requested item |
| On-demand refresh succeeds | Update its minimal snapshot and extend expiry only if it is still public, region-available, and policy-compatible | No search call |
| On-demand refresh fails or the video/configuration changed | Delete the stale match and run normal discovery for that requested meal | Normal discovery budget |
| No-video outcome | Cache only briefly (24 hours) to suppress repeated retries; then retry on the next plan run | Avoids a temporary search loop |
| Meal, diet rule, region/language, trusted-channel set, or policy changes | Invalidate immediately | No stale reuse |

Kipp may retain long-lived *non-YouTube* information such as a canonical meal
name, parent-confirmed meal preferences, and the trusted-channel configuration.
It should not retain a provider-backed video choice indefinitely. In practice,
the rolling 28-day window covers common repeats across several weekly plans,
and lazy single-item refresh prevents those repeats from consuming a new
`search.list` call while avoiding background quota use for meals that do not
recur. A cleanup job must delete any entry that reaches 30 days without an
on-demand refresh.

## Remaining production unknowns

The API-feasibility question is answered, but four product and operational
decisions remain before production implementation: permitted parent-facing
wording for a matched link; external YouTube link versus embedded playback;
the manual definition and maintenance of an approved fallback-source set; and
the exact user experience when a cached video becomes unavailable or changes.
The required validation cases and first-party sources are captured in
[YouTube recipe-link production unknowns](youtube-recipe-production-unknowns.md).

### Product decisions recorded — 2026-08-25

| Topic | Decision |
| --- | --- |
| Parent-facing wording | Defer detailed wording. The implementation still must not claim a video is verified safe or suitable. |
| Allergy-grade dietary verification | Defer. v1 remains metadata-based and must not make a verification claim. |
| Curated fallback-source governance | Defer to future work. |
| Playback | Use an explicit user-initiated external YouTube link in v1; do not embed a player. |
| Cached-video changed/removed UX | Nice to have; retain a safe refresh failure/no-video fallback. |
| Hindi/Hinglish alias evaluation | Nice to have; defer formal corpus expansion. |

## Current blockers and decisions needed

- **No production YouTube integration is present in this repository.** The
  project-owned key was used only by the disposable local probe; production
  work still needs a secret binding, adapter, tests, rate limits, and retention
  job.
- **Trusted channels are only a product field, not a curated registry.** The
  team must supply initial channel IDs (names alone are ambiguous) and decide
  what qualifies a fallback as reputable.
- **Dietary correctness cannot be guaranteed from search metadata.** The API
  exposes titles, descriptions, tags and some playback/region fields, but not
  an authoritative ingredient/allergen declaration. The launch rule must be
  “evidence-based suggestion, not verified nutrition advice,” with abstention
  when metadata is ambiguous.
- **The ranking policy remains a product decision.** The parent plan explicitly
  lists an implementable recipe-source ranking policy as open. This spike
  should propose it, but a product owner must approve thresholds and whether
  any machine interpretation is allowed.
- **Quota and policy ownership need an operator.** The API project must retain
  a monitored contact address and have a quota budget; broad scale-up may
  require the documented compliance audit.

## Sources

- [Kipp issue #60](https://github.com/satwikhebbar/kipp/issues/60)
- [Kipp issue #59](https://github.com/satwikhebbar/kipp/issues/59)
- [School-Day Meal Planning Workflow — v1](https://github.com/satwikhebbar/kipp/blob/main/docs/school-day-meal-planning-workflow-spec.html)
- [YouTube Data API: search.list](https://developers.google.com/youtube/v3/docs/search/list)
- [YouTube Data API: videos resource](https://developers.google.com/youtube/v3/docs/videos)
- [YouTube API Services Developer Policies](https://developers.google.com/youtube/terms/developer-policies)
- [YouTube quota and compliance audits](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits)
