#!/usr/bin/env node

import { readFile } from "node:fs/promises"

const API_ROOT = "https://www.googleapis.com/youtube/v3"
const REGION = "IN"
const LANGUAGE = "en"
const MAX_RESULTS_PER_SEARCH = 5
const CHANNEL_HANDLES = ["@KunalKapur", "@hebbars.kitchen"]

/** Fixed, non-household fixtures for the YouTube recipe-discovery spike. */
const FIXTURES = [
  {
    id: "trusted-lunch",
    query: "aloo gobi potato cauliflower lunchbox",
    dishTerms: ["aloo", "gobi"],
    requiredTerms: ["potato", "cauliflower"],
    forbiddenTerms: ["egg", "anda", "red chilli", "red chili", "lal mirch", "kashmiri chilli", "kashmiri chili"],
  },
  {
    id: "fallback-lunch-no-trusted-configuration",
    query: "vegetable pulao rice mixed vegetables lunchbox",
    dishTerms: ["pulao"],
    requiredTerms: ["rice"],
    forbiddenTerms: ["egg", "anda", "red chilli", "red chili", "lal mirch", "kashmiri chilli", "kashmiri chili"],
    useTrustedSources: false,
  },
  {
    id: "fallback-after-trusted-miss",
    query: "ragi mudde finger millet lunchbox",
    dishTerms: ["ragi", "mudde"],
    requiredTerms: ["finger", "millet"],
    forbiddenTerms: ["egg", "anda", "red chilli", "red chili", "lal mirch", "kashmiri chilli", "kashmiri chili"],
    trustedHandles: ["@KunalKapur"],
  },
  {
    id: "hard-rule-rejection",
    query: "besan chilla eggless lunchbox",
    dishTerms: ["besan", "chilla"],
    requiredTerms: ["besan"],
    forbiddenTerms: ["egg", "anda", "red chilli", "red chili", "lal mirch", "kashmiri chilli", "kashmiri chili"],
  },
  {
    id: "strict-evidence-no-result",
    query: "palak dal spinach lentil pineapple lunchbox",
    dishTerms: ["palak", "dal"],
    requiredTerms: ["spinach", "lentil", "pineapple"],
    forbiddenTerms: ["egg", "anda", "red chilli", "red chili", "lal mirch", "kashmiri chilli", "kashmiri chili"],
  },
]

/** Reads one named local development variable without echoing any secret. */
async function localDevelopmentValue(name) {
  if (process.env[name]) return process.env[name]
  const contents = await readFile(".dev.vars", "utf8")
  const line = contents.split(/\r?\n/).find((candidate) => candidate.startsWith(`${name}=`))
  return line?.slice(name.length + 1).trim().replace(/^(["'])(.*)\1$/, "$2")
}

/** Converts API-visible metadata to a conservative comparable form. */
function normalize(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

/** Matches a normalized phrase as consecutive metadata words. */
function includesTerm(text, term) {
  return ` ${text} `.includes(` ${normalize(term)} `)
}

/** Performs a bounded YouTube Data API request and returns JSON on success. */
async function youtube(path, params, key) {
  const url = new URL(`${API_ROOT}${path}`)
  for (const [name, value] of Object.entries({ ...params, key })) url.searchParams.set(name, String(value))
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(`YouTube API ${response.status}: ${body?.error?.errors?.[0]?.reason ?? "unknown"}`)
  }
  return response.json()
}

/** Resolves a user-provided channel handle to its stable YouTube channel ID. */
async function resolveChannel(handle, key) {
  const data = await youtube("/channels", { part: "snippet", forHandle: handle }, key)
  const channel = data.items?.[0]
  if (!channel?.id || !channel.snippet?.title) throw new Error(`No channel resolved for ${handle}`)
  return { id: channel.id, handle, title: channel.snippet.title }
}

/** Retrieves candidates from one source tier, restricted to public videos. */
async function searchCandidates(query, channelId, key) {
  const data = await youtube(
    "/search",
    {
      part: "snippet",
      q: query,
      type: "video",
      regionCode: REGION,
      relevanceLanguage: LANGUAGE,
      safeSearch: "strict",
      maxResults: MAX_RESULTS_PER_SEARCH,
      ...(channelId ? { channelId } : {}),
    },
    key,
  )
  return (data.items ?? []).flatMap((item) => (typeof item.id?.videoId === "string" ? [item.id.videoId] : []))
}

/** Hydrates API-visible metadata used by the deterministic evidence gate. */
async function hydrateCandidates(ids, key) {
  if (!ids.length) return []
  const data = await youtube("/videos", { part: "snippet,contentDetails,status", id: [...new Set(ids)].join(",") }, key)
  return data.items ?? []
}

/** Applies only evidence that YouTube's public metadata actually supplies. */
function assess(video, fixture, tier) {
  const title = normalize(video.snippet?.title ?? "")
  const metadata = normalize([video.snippet?.title, video.snippet?.description, ...(video.snippet?.tags ?? [])].filter(Boolean).join(" "))
  const rejectedFor = []
  if (video.status?.privacyStatus !== "public") rejectedFor.push("not-public")
  if (video.contentDetails?.regionRestriction?.blocked?.includes(REGION)) rejectedFor.push("region-blocked")
  if (video.contentDetails?.regionRestriction?.allowed && !video.contentDetails.regionRestriction.allowed.includes(REGION))
    rejectedFor.push("region-not-allowed")
  const forbidden = fixture.forbiddenTerms.filter((term) => includesTerm(metadata, term))
  if (forbidden.length) rejectedFor.push(`forbidden:${forbidden.join("|")}`)
  // A dish term only in a description can denote a comparison or alternative recipe.
  // Require it in the title; ingredients may still be evidenced in metadata.
  const missingDish = fixture.dishTerms.filter((term) => !includesTerm(title, term))
  if (missingDish.length) rejectedFor.push(`missing-dish:${missingDish.join("|")}`)
  const missingRequired = fixture.requiredTerms.filter((term) => !includesTerm(metadata, term))
  if (missingRequired.length) rejectedFor.push(`missing-required:${missingRequired.join("|")}`)
  const score = (tier === "trusted" ? 1_000 : 0) + (fixture.dishTerms.length - missingDish.length) * 100 + (fixture.requiredTerms.length - missingRequired.length) * 10
  return { id: video.id, title: video.snippet?.title ?? "", tier, score, rejectedFor }
}

/** Produces an evidence-minimizing report; no descriptions, thumbnails, or API key are retained. */
async function main() {
  const key = await localDevelopmentValue("YOUTUBE_API_KEY")
  if (!key) throw new Error("YOUTUBE_API_KEY is missing from the environment or .dev.vars")
  const channels = await Promise.all(CHANNEL_HANDLES.map((handle) => resolveChannel(handle, key)))
  const requestedFixture = process.argv[2]
  const fixtures = requestedFixture ? FIXTURES.filter((fixture) => fixture.id === requestedFixture) : FIXTURES
  if (!fixtures.length) throw new Error(`Unknown fixture: ${requestedFixture}`)
  const cases = []
  for (const fixture of fixtures) {
    const trustedChannels = fixture.trustedHandles ? channels.filter((channel) => fixture.trustedHandles.includes(channel.handle)) : channels
    const trustedIds =
      fixture.useTrustedSources === false
        ? []
        : (await Promise.all(trustedChannels.map((channel) => searchCandidates(fixture.query, channel.id, key)))).flat()
    let assessed = (await hydrateCandidates(trustedIds, key)).map((video) => assess(video, fixture, "trusted"))
    if (!assessed.some((candidate) => !candidate.rejectedFor.length)) {
      const fallbackIds = await searchCandidates(fixture.query, undefined, key)
      assessed = [...assessed, ...(await hydrateCandidates(fallbackIds, key)).map((video) => assess(video, fixture, "fallback"))]
    }
    const eligible = assessed.filter((candidate) => !candidate.rejectedFor.length).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    cases.push({
      fixture: fixture.id,
      query: fixture.query,
      candidateCount: assessed.length,
      rejected: assessed.filter((candidate) => candidate.rejectedFor.length).map(({ id, tier, rejectedFor }) => ({ id, tier, rejectedFor })),
      outcome: eligible[0]
        ? { kind: "found", videoId: eligible[0].id, title: eligible[0].title, tier: eligible[0].tier, score: eligible[0].score }
        : { kind: "no_suitable_video" },
    })
  }
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), region: REGION, channels, cases }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
