# YouTube recipe-link matching — remaining production unknowns

**Purpose:** follow-up to the Issue #60 discovery spike. This note separates
documented platform requirements from questions that still need an experiment
or a Kipp product decision. It uses only Google/YouTube primary documentation.

## Bottom line

Add a cache, but not a long-lived copy of YouTube metadata. Store the Kipp
decision separately from the API-derived fields, and make every displayed
recipe link revalidate (or delete its API data) within **30 calendar days**.
The remaining high-risk unknown is not discovery: it is the product boundary
between a useful *metadata-based recipe-link match* and an unsupported claim
that a recipe is safe, suitable, or ingredient-accurate.

## Priority 0 — decide before implementation

| Unknown / decision | Why it matters | Required resolution |
| --- | --- | --- |
| **What Kipp promises** | Search/video metadata provides title, description, tags and playback state; it is not an ingredient or allergen declaration. A visible term can establish a contradiction, but absence cannot establish safety. In addition, YouTube prohibits API clients from claiming that a video/channel is “safe” or “suitable to watch.” | Adopt copy and an API contract of “recipe-link match based on visible metadata.” Never label a video allergy-safe, medically safe, suitable to watch, or guaranteed to exclude egg/red chilli. For a hard medical/allergy rule, abstain unless Kipp has an independently verified recipe source. This is a **product decision**, not an API experiment. |
| **External watch page or embedded player** | An embed adds third-party player/data-collection behaviour; a link is simpler. If Kipp embeds, YouTube requires a fresh Made-for-Kids lookup for each embedded video, appropriate tracking controls for it, attribution, and no interference with player attribution/functionality. [Developer Policies](https://developers.google.com/youtube/terms/developer-policies#handling-youtube-data-and-content) | Choose link-out for v1, or explicitly fund embedded-player/privacy work and validate it in every Kipp surface. This is a **product and privacy decision**. |
| **Fallback source boundary** | A broad YouTube search can return a plausible but wrong variant. The spike showed this in metadata. | Approve a curated fallback channel allowlist for launch, or approve broad fallback plus a conservative abstention threshold. Define whether a parent may override a rejected/absent match. This is a **product decision**. |

## Priority 1 — caching and invalidation design

The policy permits only temporary storage of non-authorized API data: after 30
calendar days it must be deleted or refreshed, with reasonable efforts to keep
stored data current and the most current data shown to users. It separately
prohibits downloading, importing, backing up, caching, or storing audiovisual
content. [Refresh/storage policy](https://developers.google.com/youtube/terms/developer-policies#refreshing-storing-and-displaying-api-data), [audiovisual-content policy](https://developers.google.com/youtube/terms/developer-policies#handling-youtube-data-and-content)

**Recommended two-layer model**

1. `videoSnapshot`, keyed by immutable `videoId`: the minimal API data needed
   for display/gating (title, channel ID/name, URL, duration, availability,
   region restriction, embeddable and Made-for-Kids state), `retrievedAt`, and
   `expiresAt <= retrievedAt + 30 calendar days`. Refresh with batched
   `videos.list(id=...)`; if the ID no longer returns or becomes ineligible,
   delete its snapshot and invalidate all match records that cite it.
2. `recipeLinkMatch`, Kipp-owned decision data: `videoId`/explicit no-result,
   meal fingerprint, evidence/rejection codes, and policy versions. It must
   not preserve stale title, description, thumbnail, or other API fields past
   their expiry. A remembered `videoId` is useful only if revalidated before it
   is presented again; the implementation should get policy/legal review on
   retaining it beyond the snapshot window.

The cache key must include every input that could change eligibility:

```text
meal canonical name + required-ingredient set + exclusion/alias-set version
+ meal context + region + relevance language + trusted/fallback-source revision
+ ranking/gate version
```

Invalidate immediately when any term above changes, a channel is disabled, a
parent changes exclusions, or a video refresh reports a status/region/embed
change. Do not make a permanent cache of failed broad searches: a `no_video`
outcome should have a short Kipp-chosen retry TTL (for example 7 days), while
any associated API query/candidate metadata remains subject to the 30-day
limit. The 7-day number is a **product choice**, not a YouTube requirement.

**Experiment still required:** create a disposable fixture that (a) reuses an
unchanged meal and records zero searches, (b) changes one cache-key input and
records a new search, (c) refreshes a selected ID, and (d) simulates an absent
`videos.list` item. Assert that stale display data is removed and the meal is
kept with `no_suitable_video` rather than failing plan generation.

## Priority 1 — availability and playback drift

The `videos` resource exposes region allow/block lists and video status,
including privacy, embeddability and the current Made-for-Kids status.
[Video resource](https://developers.google.com/youtube/v3/docs/videos) A result
can therefore become unavailable after discovery: deletion, a privacy change,
regional restriction, disabled embedding, or a Made-for-Kids classification
change all need a refreshed UI decision.

**Experiment required:** pick non-sensitive public fixtures and record exactly
which fields are returned to an unauthenticated `videos.list` request. Test
the UI/adapter with: returned item absent, `privacyStatus != public`, requested
region not allowed/explicitly blocked, `embeddable=false`, and a Made-for-Kids
result if embedding is selected. Also validate the final player or watch-page
behaviour in Kipp's actual webview/browser, not just the Data API response.

**Product decision:** use an external watch URL as the universal escape hatch
when embedding is disallowed, or suppress the card entirely. The API documents
an iframe URL built from a video ID, but `status.embeddable` specifically says
whether it may be embedded on another website. [Player parameters](https://developers.google.com/youtube/player_parameters), [video status fields](https://developers.google.com/youtube/v3/docs/videos#status.embeddable)

## Priority 2 — quotas, errors and observability

Current quotas are not the old shared-cost model: `search.list` is limited to
**100 calls/day** in its own Search Queries bucket, while the default project
allocation is **10,000 units/day** for other endpoints; `videos.list` costs one
unit/call. [Search reference](https://developers.google.com/youtube/v3/docs/search/list), [quota guidance](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits), [videos.list](https://developers.google.com/youtube/v3/docs/videos/list)

Implement an explicit per-plan budget (maximum trusted passes plus one fallback
pass), deduplicate in-flight identical cache keys, and stop on the first
eligible match. Monitor, without logging API keys or full descriptions:

- searches/meal, searches by source tier, cache hit/refresh/expiry counts;
- found vs `no_suitable_video`, grouped by deterministic rejection code;
- HTTP status/error reason, latency, quota-exhausted events, and refresh
  invalidations; and
- fallback rate and manual-parent override rate, if introduced.

The API explicitly returns `quotaExceeded` as 403; it also documents malformed
request, invalid region/language, and missing-channel errors. [Error
reference](https://developers.google.com/youtube/v3/docs/errors) The product
behaviour should be: transient/service failures yield “video unavailable right
now” with a retry; quota exhaustion disables new discovery until reset while
serving only fresh cached links; expected no-match is `no_suitable_video`, not
an error. Exact retry/backoff and user wording are **implementation/product
decisions**.

Do not turn the rank into a user-facing YouTube quality/safety score or claim
that a channel/video is safe or suitable to watch. If Kipp displays its own
meal-match explanation beside YouTube data, clearly identify it as Kipp's own
logic rather than YouTube's. [Policy compliance guidance](https://developers.google.com/youtube/terms/developer-policies-guide)

## Priority 2 — corpus gaps worth testing

- Hindi/Hinglish aliases, transliteration, and ingredient synonyms for both
  required and prohibited ingredients; measure false accepts and false
  abstentions rather than assume English title matching generalizes.
- The trusted-channel and curated-fallback corpus over the intended meal
  catalogue: report first-source hit rate, fallback rate and no-match rate.
- A manual review sample of selected links for school-lunch practicality. This
  remains human judgement; API metadata cannot prove packing, reheating or
  recipe fidelity.
- The final UI's attribution, YouTube Terms link and privacy-policy disclosure.
  The policies require clients to identify YouTube as the source where content
  is displayed and to provide YouTube/Google policy disclosures. [Developer
  Policies](https://developers.google.com/youtube/terms/developer-policies#api-client-terms-of-use-and-privacy-policies)

## Recommended closure criterion

Proceed only when the cache/invalidation experiment and the playback-surface
test pass, launch copy has been approved, and the fallback policy has an owner.
Those close the remaining platform and user-expectation risks; they do not
turn YouTube metadata into dietary verification.
