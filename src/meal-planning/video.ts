import type { Env } from "../core/types"
import type { MealCell, MealGrid, MealPlanCandidate, RecipeVideo } from "./types"

/** Lunch slots enriched with optional recipe-video discovery in iteration 1; other slots carry no video. */
export const LUNCH_VIDEO_SLOT_IDS = ["school-lunch", "home-lunch"] as const

const YOUTUBE_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search"
const YOUTUBE_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos"
const VIDEO_CACHE_KEY_PREFIX = "video:"
const VIDEO_CACHE_TTL_SECONDS = 86_400 // 24 h: per-key expirationTtl, no expiry bookkeeping or cleanup sweep
const YOUTUBE_SEARCH_MAX_RESULTS = 5
const MIN_SUITABLE_VIDEO_SECONDS = 120 // skip shorts; the #60 spike filters them via videos.list durations
const SECONDS_PER_HOUR = 3600
const SECONDS_PER_MINUTE = 60
/** Hard ceiling on YouTube calls per plan (one search per lunch cell plus one batched videos.list). */
const MAX_YOUTUBE_CALLS_PER_PLAN = 13

/** Narrow cache surface so tests can supply an in-memory fake; `KVNamespace` satisfies it structurally. */
export interface RecipeVideoCache {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl: number }): Promise<void>
}

interface YouTubeSearchItem {
  videoId: string
  channelId: string
  channelTitle: string
  title: string
}

export interface EnrichLunchVideosOptions {
  /** Preferred channel ids, highest preference first; unused while empty (iteration 1 has no configured channels). */
  trustedChannelIds?: string[]
  fetch?: typeof globalThis.fetch
}

/** The enriched candidate (lunch cells carry `recipeVideo`) plus the opaque per-cell video record for `video_json`. */
export interface EnrichedPlan {
  candidate: MealPlanCandidate
  video: Record<string, RecipeVideo>
}

/**
 * Optional, never-blocking recipe-video enrichment for school-lunch and
 * home-lunch cells (§8): with `YOUTUBE_API_KEY` and `RECIPE_VIDEO_CACHE`
 * configured, search the YouTube Data API per cell (search.list + one batched
 * videos.list for duration), cache each result for 24 h keyed
 * `video:<dish>:<slotId>`, and honor a hard per-plan call ceiling. Without a
 * key or cache, every lunch cell records `not_attempted`. A missing video
 * never removes or blocks a plan; any step failure — a cache read or write
 * error included — degrades the affected cells to `no_suitable_video` and the
 * plan persists unchanged.
 */
export async function enrichLunchVideos(
  env: Env,
  candidate: MealPlanCandidate,
  slotIds: readonly string[] = LUNCH_VIDEO_SLOT_IDS,
  options: EnrichLunchVideosOptions = {},
): Promise<EnrichedPlan> {
  const cache = env.RECIPE_VIDEO_CACHE as RecipeVideoCache | undefined
  const apiKey = env.YOUTUBE_API_KEY
  const doFetch = options.fetch ?? globalThis.fetch

  const cells = lunchCells(candidate.grid, slotIds)
  if (!apiKey || !cache) return { candidate: markNotAttempted(candidate, slotIds), video: {} }

  const results = new Map<string, RecipeVideo>()
  // One lookup per distinct dish+slot; every cell sharing it reuses the same result.
  const dishByKey = new Map<string, string>()
  const byDishSlot = new Map<string, { dish: string; slot: string; keys: string[] }>()
  for (const { key, slot, cell } of cells) {
    const cKey = cacheKey(cell.dish, slot)
    let cached: string | null = null
    try {
      cached = await cache.get(cKey)
    } catch {
      // A failing KV read is an enrichment-step failure: degrade this cell and move on.
      results.set(key, { status: "no_suitable_video" })
      continue
    }
    if (cached) {
      results.set(key, parseCached(cached))
      continue
    }
    dishByKey.set(key, cell.dish)
    let group = byDishSlot.get(cKey)
    if (!group) {
      group = { dish: cell.dish, slot, keys: [] }
      byDishSlot.set(cKey, group)
    }
    group.keys.push(key)
  }

  // One search.list per uncached dish+slot, under the per-plan call ceiling.
  let calls = 0
  const topByKey = new Map<string, YouTubeSearchItem>()
  for (const group of byDishSlot.values()) {
    if (calls >= MAX_YOUTUBE_CALLS_PER_PLAN) {
      for (const key of group.keys) results.set(key, { status: "no_suitable_video" })
      continue
    }
    calls += 1
    try {
      const top = await searchTopVideo(doFetch, apiKey, group.dish, options.trustedChannelIds ?? [])
      if (top) for (const key of group.keys) topByKey.set(key, top)
      else for (const key of group.keys) results.set(key, { status: "no_suitable_video" })
    } catch {
      for (const key of group.keys) results.set(key, { status: "no_suitable_video" })
    }
  }

  // One batched videos.list for every collected candidate's duration.
  let durations: Record<string, number> = {}
  if (topByKey.size > 0 && calls < MAX_YOUTUBE_CALLS_PER_PLAN) {
    calls += 1
    try {
      durations = await fetchVideoDurations(
        doFetch,
        apiKey,
        [...topByKey.values()].map((item) => item.videoId),
      )
    } catch {
      durations = {}
    }
  }

  for (const [key, top] of topByKey) {
    const video: RecipeVideo =
      (durations[top.videoId] ?? 0) >= MIN_SUITABLE_VIDEO_SECONDS
        ? {
            status: "found",
            url: `https://www.youtube.com/watch?v=${top.videoId}`,
            title: top.title,
            channel: top.channelTitle,
          }
        : { status: "no_suitable_video" }
    results.set(key, video)
    const dish = dishByKey.get(key)
    const slot = key.slice(key.indexOf(":") + 1)
    if (dish && slot)
      try {
        await cache.put(cacheKey(dish, slot), JSON.stringify(video), {
          expirationTtl: VIDEO_CACHE_TTL_SECONDS,
        })
      } catch {
        // A cache write is best-effort; a transient KV failure never blocks plan persistence.
      }
  }

  return { candidate: withVideos(candidate, results), video: Object.fromEntries(results) }
}

/** Collects the lunch cells to enrich as `day:slot` keys. */
function lunchCells(grid: MealGrid, slotIds: readonly string[]): Array<{ key: string; slot: string; cell: MealCell }> {
  const cells: Array<{ key: string; slot: string; cell: MealCell }> = []
  for (const [day, slots] of Object.entries(grid)) {
    for (const slotId of slotIds) {
      const cell = slots?.[slotId]
      if (cell) cells.push({ key: `${day}:${slotId}`, slot: slotId, cell })
    }
  }
  return cells
}

/** Returns the candidate with every lunch cell marked `not_attempted`. */
function markNotAttempted(candidate: MealPlanCandidate, slotIds: readonly string[]): MealPlanCandidate {
  const grid: MealGrid = {}
  for (const [day, slots] of Object.entries(candidate.grid)) {
    grid[day] = {}
    for (const [slotId, cell] of Object.entries(slots ?? {})) {
      grid[day][slotId] = slotIds.includes(slotId) ? { ...cell, recipeVideo: { status: "not_attempted" } } : cell
    }
  }
  return { ...candidate, grid }
}

/** Returns the candidate with the collected per-cell video results applied to the matching cells. */
function withVideos(candidate: MealPlanCandidate, results: Map<string, RecipeVideo>): MealPlanCandidate {
  const grid: MealGrid = {}
  for (const [day, slots] of Object.entries(candidate.grid)) {
    grid[day] = {}
    for (const [slotId, cell] of Object.entries(slots ?? {})) {
      const video = results.get(`${day}:${slotId}`)
      grid[day][slotId] = video ? { ...cell, recipeVideo: video } : cell
    }
  }
  return { ...candidate, grid }
}

/** The KV cache key for one dish+slot lookup. */
function cacheKey(dish: string, slotId: string): string {
  return `${VIDEO_CACHE_KEY_PREFIX}${dish}:${slotId}`
}

/** Parses a cached recipe-video result, degrading to no_suitable_video on malformed JSON. */
function parseCached(value: string): RecipeVideo {
  try {
    return JSON.parse(value) as RecipeVideo
  } catch {
    return { status: "no_suitable_video" }
  }
}

/** Runs one YouTube search.list for a dish and returns the preferred result (trusted channel first). */
async function searchTopVideo(
  doFetch: typeof globalThis.fetch,
  apiKey: string,
  dish: string,
  trustedChannelIds: string[],
): Promise<YouTubeSearchItem | null> {
  const url = new URL(YOUTUBE_SEARCH_URL)
  url.searchParams.set("part", "snippet")
  url.searchParams.set("type", "video")
  url.searchParams.set("q", `${dish} recipe`)
  url.searchParams.set("maxResults", String(YOUTUBE_SEARCH_MAX_RESULTS))
  url.searchParams.set("key", apiKey)
  const response = await doFetch(url, { headers: { accept: "application/json" } })
  if (!response.ok) throw new Error(`YouTube search failed: ${response.status}`)
  const body = (await response.json()) as {
    items?: Array<{ id: { videoId: string }; snippet: { channelId: string; channelTitle: string; title: string } }>
  }
  const items = body.items ?? []
  const picked = trustedChannelIds.length
    ? (items.find((item) => trustedChannelIds.includes(item.snippet.channelId)) ?? items[0])
    : items[0]
  if (!picked) return null
  return {
    videoId: picked.id.videoId,
    channelId: picked.snippet.channelId,
    channelTitle: picked.snippet.channelTitle,
    title: picked.snippet.title,
  }
}

/** Fetches durations for a batch of video ids via one videos.list call, keyed by video id. */
async function fetchVideoDurations(
  doFetch: typeof globalThis.fetch,
  apiKey: string,
  videoIds: string[],
): Promise<Record<string, number>> {
  const url = new URL(YOUTUBE_VIDEOS_URL)
  url.searchParams.set("part", "contentDetails")
  url.searchParams.set("id", videoIds.join(","))
  url.searchParams.set("key", apiKey)
  const response = await doFetch(url, { headers: { accept: "application/json" } })
  if (!response.ok) throw new Error(`YouTube videos failed: ${response.status}`)
  const body = (await response.json()) as { items?: Array<{ id: string; contentDetails: { duration: string } }> }
  const durations: Record<string, number> = {}
  for (const item of body.items ?? []) durations[item.id] = isoDurationToSeconds(item.contentDetails.duration)
  return durations
}

/** Converts an ISO-8601 duration (PT6M5S) to seconds; unknown shapes are treated as 0. */
function isoDurationToSeconds(duration: string): number {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(duration)
  if (!match) return 0
  return Number(match[1] ?? 0) * SECONDS_PER_HOUR + Number(match[2] ?? 0) * SECONDS_PER_MINUTE + Number(match[3] ?? 0)
}
