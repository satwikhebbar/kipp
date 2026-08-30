import { describe, expect, it, vi } from "vitest"
import type { Env } from "../core/types"
import type { MealCell, MealGrid, MealPlanCandidate } from "../meal-planning/types"
import { enrichLunchVideos, type RecipeVideoCache } from "../meal-planning/video"

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const
type SlotId = "breakfast" | "snack1" | "school-lunch" | "home-lunch"
const SLOT_COOK: Record<SlotId, number> = { breakfast: 15, snack1: 0, "school-lunch": 20, "home-lunch": 20 }

function cell(dish: string, slot: SlotId): MealCell {
  return { dish, vegetarian: true, items: [dish], cookMinutes: SLOT_COOK[slot], priorNightPrep: false }
}

function candidateGrid(): MealGrid {
  const grid: MealGrid = {}
  for (const day of DAYS) {
    const slots: Partial<Record<SlotId, MealCell>> = {
      breakfast: cell("paratha", "breakfast"),
      "school-lunch": cell("idli", "school-lunch"),
      "home-lunch": cell("rice and dal", "home-lunch"),
    }
    grid[day] = slots
  }
  return grid
}

function candidate(): MealPlanCandidate {
  return { grid: candidateGrid(), easyBuys: [], policyOutcomes: {} }
}

interface SearchItem {
  q: string
  videoId: string
  channelId: string
  channelTitle: string
  title: string
  duration: string
}

function youTubeFetch(items: SearchItem[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: RequestInfo | URL) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url
    if (href.includes("/youtube/v3/search")) {
      const searchUrl = new URL(href)
      const q = searchUrl.searchParams.get("q") ?? ""
      const channelId = searchUrl.searchParams.get("channelId")
      const matches = items.filter((item) => item.q === q && (!channelId || item.channelId === channelId))
      return new Response(
        JSON.stringify({
          items: matches.map((item) => ({
            id: { videoId: item.videoId },
            snippet: { channelId: item.channelId, channelTitle: item.channelTitle, title: item.title },
          })),
        }),
        { status: 200 },
      )
    }
    if (href.includes("/youtube/v3/videos")) {
      const ids = new URL(href).searchParams.get("id")?.split(",") ?? []
      return new Response(
        JSON.stringify({
          items: ids.map((id) => {
            const item = items.find((entry) => entry.videoId === id)
            return { id, contentDetails: { duration: item?.duration ?? "PT0S" } }
          }),
        }),
        { status: 200 },
      )
    }
    throw new Error(`unexpected fetch: ${href}`)
  })
}

function fakeCache(initial: Array<[string, string]> = []): RecipeVideoCache & { store: Map<string, string> } {
  const store = new Map(initial)
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
  }
}

function throwingReadCache(): RecipeVideoCache {
  return {
    get: vi.fn(async () => {
      throw new Error("kv read failed")
    }),
    put: vi.fn(async () => {}),
  }
}

function throwingWriteCache(): RecipeVideoCache & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async () => {
      throw new Error("kv write failed")
    }),
  }
}

function videoEnv(cache?: RecipeVideoCache): Env {
  return { YOUTUBE_API_KEY: "yt-key", RECIPE_VIDEO_CACHE: cache } as unknown as Env
}

describe("optional recipe-video enrichment", () => {
  it("records not_attempted on lunch cells when no API key is configured", async () => {
    const { candidate: enriched, video } = await enrichLunchVideos({} as Env, candidate())
    expect(video).toEqual({})
    for (const day of DAYS) {
      expect(enriched.grid[day]["school-lunch"].recipeVideo).toEqual({ status: "not_attempted" })
      expect(enriched.grid[day]["home-lunch"].recipeVideo).toEqual({ status: "not_attempted" })
      expect(enriched.grid[day].breakfast.recipeVideo).toBeUndefined()
    }
  })

  it("finds a suitable video per lunch dish and caches the result for 24 h", async () => {
    const cache = fakeCache()
    const fetch = youTubeFetch([
      {
        q: "idli recipe",
        videoId: "idli-1",
        channelId: "c-idli",
        channelTitle: "Idli Chef",
        title: "Perfect Idli",
        duration: "PT6M5S",
      },
      {
        q: "rice and dal recipe",
        videoId: "dal-1",
        channelId: "c-dal",
        channelTitle: "Dal House",
        title: "Dal Made Easy",
        duration: "PT5M",
      },
    ])
    const { candidate: enriched, video } = await enrichLunchVideos(videoEnv(cache), candidate(), undefined, { fetch })
    expect(video["Mon:school-lunch"]).toMatchObject({
      status: "found",
      url: "https://www.youtube.com/watch?v=idli-1",
      title: "Perfect Idli",
      channel: "Idli Chef",
    })
    expect(enriched.grid.Wed["home-lunch"].recipeVideo).toMatchObject({ status: "found" })
    expect(cache.put).toHaveBeenCalledWith("video:idli:school-lunch", expect.any(String), { expirationTtl: 86_400 })
    expect(cache.put).toHaveBeenCalledWith("video:rice and dal:home-lunch", expect.any(String), {
      expirationTtl: 86_400,
    })
  })

  it("serves repeated enrichments from cache without any network call", async () => {
    const cache = fakeCache([
      ["video:idli:school-lunch", JSON.stringify({ status: "found", url: "https://y/1" })],
      ["video:rice and dal:home-lunch", JSON.stringify({ status: "found", url: "https://y/2" })],
    ])
    const fetch = vi.fn(async () => {
      throw new Error("network must not be touched on a cache hit")
    })
    const { candidate: enriched, video } = await enrichLunchVideos(videoEnv(cache), candidate(), undefined, { fetch })
    expect(video["Mon:school-lunch"]).toEqual({ status: "found", url: "https://y/1" })
    expect(video["Mon:home-lunch"]).toEqual({ status: "found", url: "https://y/2" })
    expect(enriched.grid.Tue["school-lunch"].recipeVideo).toEqual({ status: "found", url: "https://y/1" })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("records no_suitable_video for a short video and on a failed lookup", async () => {
    const cache = fakeCache()
    const fetch = youTubeFetch([
      {
        q: "idli recipe",
        videoId: "short-1",
        channelId: "c",
        channelTitle: "Clips",
        title: "Idli Short",
        duration: "PT1M30S",
      },
    ])
    const { candidate: enriched, video } = await enrichLunchVideos(videoEnv(cache), candidate(), undefined, { fetch })
    expect(video["Mon:school-lunch"]).toEqual({ status: "no_suitable_video" })
    expect(enriched.grid.Mon["school-lunch"].recipeVideo).toEqual({ status: "no_suitable_video" })

    const fetchMissing = vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 }))
    const { candidate: enrichedMissing, video: videoMissing } = await enrichLunchVideos(
      videoEnv(cache),
      candidate(),
      undefined,
      { fetch: fetchMissing },
    )
    expect(videoMissing["Mon:home-lunch"]).toEqual({ status: "no_suitable_video" })
    expect(enrichedMissing.grid.Mon["home-lunch"].recipeVideo).toEqual({ status: "no_suitable_video" })
  })

  it("searches trusted channels in preference order before the global fallback", async () => {
    const cache = fakeCache()
    const fetch = youTubeFetch([
      {
        q: "idli recipe",
        videoId: "global-1",
        channelId: "c-global",
        channelTitle: "Random Kitchen",
        title: "Idli",
        duration: "PT5M",
      },
      {
        q: "idli recipe",
        videoId: "trusted-1",
        channelId: "c-trusted",
        channelTitle: "Kipp Chef",
        title: "Better Idli",
        duration: "PT6M",
      },
      {
        q: "idli recipe",
        videoId: "trusted-2",
        channelId: "c-trusted-2",
        channelTitle: "Second Chef",
        title: "Also Good",
        duration: "PT7M",
      },
    ])
    const { video } = await enrichLunchVideos(videoEnv(cache), candidate(), undefined, {
      fetch,
      trustedChannelIds: ["c-trusted", "c-trusted-2"],
    })
    expect(video["Mon:school-lunch"]).toMatchObject({
      status: "found",
      url: "https://www.youtube.com/watch?v=trusted-1",
    })
    const searchCalls = fetch.mock.calls
      .map(([url]) => String(url))
      .filter((href) => href.includes("/youtube/v3/search"))
    const url = new URL(searchCalls[0])
    expect(url.searchParams.get("channelId")).toBe("c-trusted")
    expect(searchCalls.length).toBe(6)
  })

  it("walks to the next trusted channel when the first channel's top match is unsuitable", async () => {
    const cache = fakeCache()
    const fetch = youTubeFetch([
      {
        q: "idli recipe",
        videoId: "short-1",
        channelId: "c-trusted",
        channelTitle: "Kipp Chef",
        title: "Too Short Idli",
        duration: "PT1M",
      },
      {
        q: "idli recipe",
        videoId: "trusted-2",
        channelId: "c-trusted-2",
        channelTitle: "Second Chef",
        title: "Good Idli",
        duration: "PT6M",
      },
      {
        q: "idli recipe",
        videoId: "global-1",
        channelId: "c-global",
        channelTitle: "Random Kitchen",
        title: "Idli",
        duration: "PT5M",
      },
    ])
    const { video } = await enrichLunchVideos(videoEnv(cache), candidate(), undefined, {
      fetch,
      trustedChannelIds: ["c-trusted", "c-trusted-2"],
    })
    expect(video["Mon:school-lunch"]).toMatchObject({
      status: "found",
      url: "https://www.youtube.com/watch?v=trusted-2",
    })
  })

  it("degrades lunch cells and skips the network when a cache read fails", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("network must not be touched after a failed cache read")
    })
    const { candidate: enriched, video } = await enrichLunchVideos(
      videoEnv(throwingReadCache()),
      candidate(),
      undefined,
      {
        fetch,
      },
    )
    expect(video["Mon:school-lunch"]).toEqual({ status: "no_suitable_video" })
    expect(video["Mon:home-lunch"]).toEqual({ status: "no_suitable_video" })
    expect(enriched.grid.Mon["school-lunch"].recipeVideo).toEqual({ status: "no_suitable_video" })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("still applies a found video when a cache write fails", async () => {
    const fetch = youTubeFetch([
      {
        q: "idli recipe",
        videoId: "idli-1",
        channelId: "c-idli",
        channelTitle: "Idli Chef",
        title: "Perfect Idli",
        duration: "PT6M5S",
      },
    ])
    const { candidate: enriched, video } = await enrichLunchVideos(
      videoEnv(throwingWriteCache()),
      candidate(),
      undefined,
      {
        fetch,
      },
    )
    expect(video["Mon:school-lunch"]).toMatchObject({ status: "found", url: "https://www.youtube.com/watch?v=idli-1" })
    expect(enriched.grid.Mon["school-lunch"].recipeVideo).toMatchObject({ status: "found" })
  })

  it("respects the hard per-plan call ceiling", async () => {
    const cache = fakeCache()
    const fetch = youTubeFetch([])
    const grid: MealGrid = {}
    for (const day of DAYS) {
      grid[day] = {}
      const slots: SlotId[] = ["breakfast", "snack1", "school-lunch", "home-lunch"]
      for (const slot of slots) {
        grid[day][slot] = cell(`${day}-${slot}-dish`, slot)
      }
    }
    const many = { ...candidate(), grid }
    const result = await enrichLunchVideos(
      videoEnv(cache),
      many,
      ["breakfast", "snack1", "school-lunch", "home-lunch"],
      {
        fetch,
      },
    )
    const searchCalls = fetch.mock.calls.filter(([url]) => String(url).includes("/youtube/v3/search"))
    const videoCalls = fetch.mock.calls.filter(([url]) => String(url).includes("/youtube/v3/videos"))
    expect(searchCalls.length).toBe(13)
    expect(videoCalls.length).toBe(0)
    expect(result.video["Mon:school-lunch"]).toEqual({ status: "no_suitable_video" })
  })
})
