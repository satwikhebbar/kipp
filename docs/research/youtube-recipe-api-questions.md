# YouTube recipe-discovery: API decisions

**Scope.** Answers for the recipe-video discovery spike, based on official Google and YouTube documentation. This is a design recommendation, not an implementation.

## Decision summary

Use a **Kipp-owned Google Cloud project and restricted server-side API key** for ordinary recipe discovery. It is the least-privilege mechanism for public `search.list`, `channels.list`, and `videos.list` requests. The maintainer owns the project, quota, credentials, billing/security controls, and policy compliance; an end user should never provide an API key.

Do **not** make Google/YouTube OAuth a requirement for v1. OAuth is only warranted for an explicit, user-visible personalization feature. It permits a user to authorize access to their YouTube account data (for example, their subscriptions and channel-related system playlists), but adds consent UX, secure refresh-token storage, deletion/revocation handling, and privacy-policy obligations. Google’s policies require only currently used scopes with a direct, transparent user benefit; they also prohibit using authorized data outside the stated consent/policy scope and require user control and deletion. [OAuth web-server guide](https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps), [YouTube Developer Policies](https://developers.google.com/youtube/terms/developer-policies).

The API’s own sample requests show that an authenticated user’s subscription list can be retrieved with `subscriptions.list(mine=true)` and a user’s liked-videos playlist can be read. That makes a later opt-in “prefer channels I follow” feature technically possible. **Watch history and Watch Later are not available through the Data API**, so “search their history” is not a viable benefit. It is not a reason to collect likes for the spike: they are sensitive behavioural data and are not needed to find a public recipe. Kipp must not present a bespoke "suitability" or safety score based on API data; YouTube policy specifically forbids claims that a video or channel is safe or suitable to watch. [Sample requests](https://developers.google.com/youtube/v3/sample_requests), [API revision history](https://developers.google.com/youtube/v3/revision_history), [Developer policy guidance](https://developers.google.com/youtube/terms/developer-policies-guide).

## Trusted-channel configuration

Store the immutable **YouTube channel ID** as the operational identifier, e.g. `UC...`, together with display-only metadata:

```json
{
  "channelId": "UC...",
  "label": "Example Kitchen",
  "handle": "@examplekitchen",
  "enabled": true,
  "priority": 100,
  "dietaryTags": ["vegetarian"],
  "regionAllowlist": ["IN"]
}
```

`search.list(channelId=..., type=video)` limits results to material created by that channel. `channels.list(id=...)` retrieves the channel directly. A handle is useful as provenance and an onboarding input, but resolve it once with `channels.list(forHandle=...)`, save the returned `id`, and periodically validate it. Handles and legacy usernames are lookup inputs; IDs are the stable query/config key. [Channels: list](https://developers.google.com/youtube/v3/docs/channels/list), [Search: list](https://developers.google.com/youtube/v3/docs/search/list).

## Ingredients in the query

Yes—include a small set of discriminating, required ingredients in the `q` search term, alongside dish name and meal intent. For example: `"chickpea spinach curry lunchbox"`. The `q` parameter searches for matching terms and supports `-` exclusion and `|` alternatives; constrain to `type=video`, a target `regionCode`, and `safeSearch=strict`. [Search: list](https://developers.google.com/youtube/v3/docs/search/list).

This is only candidate retrieval, not proof of a recipe’s ingredients. Search results provide IDs and snippets; metadata can be incomplete, titles/descriptions may be inaccurate, and `search.list` relevance is YouTube’s ranking. Require a textual ingredient-evidence check against the returned title/description (and, if the product has a lawful/source-backed recipe record, compare there); otherwise reject/abstain. Do not infer an ingredients list from views, tags, or popularity.

## Deterministic fallback when trusted channels have no match

Use a fixed pipeline, never “most popular video wins”:

1. Query enabled trusted channels in descending `priority`, keeping a bounded candidate set per channel.
2. If none passes the evidence gates, query the public catalogue using the same normalized query and fixed filters (`type=video`, `regionCode`, `safeSearch=strict`, `relevanceLanguage`, bounded result count).
3. Hydrate those video IDs via `videos.list` and reject anything non-public, non-embeddable (if Kipp embeds), region-blocked, duration-ineligible, or lacking dish plus required-ingredient evidence. The API exposes `status.embeddable`, privacy status, duration, and region restrictions. [Videos resource](https://developers.google.com/youtube/v3/docs/videos).
4. Sort remaining candidates by a lexicographic, explainable key: (a) exact dish-name evidence, (b) number/weight of required ingredients evidenced, (c) meal-format evidence such as “lunchbox” when needed, (d) explicitly approved channel tier, (e) recency. Use view count only as a final tie-breaker, if at all.
5. Return the first result, including the reasons it matched; if none qualifies, return `no_suitable_video` and leave the meal plan unchanged.

Persist the search version, query, gates, candidate IDs, rejection reasons, and selected ID so the outcome is reproducible. Do not label a winner “safe” or “suitable to watch”; say it is the best match to the declared recipe and playback constraints.

## Spike completion test

Run a small fixed corpus that includes a trusted-channel hit, a fallback hit, an ingredient mismatch, a region/embedding rejection, and a no-match result. Record the exact normalized query, configuration snapshot, candidates, gates, winner/no-match, and API quota used. The result is sufficient to decide whether this integration can provide a non-misleading optional video link.
