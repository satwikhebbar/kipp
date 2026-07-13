import { beforeEach, describe, expect, it, vi } from "vitest"

const mockGen = vi.hoisted(() => vi.fn())
vi.mock("../providers/index", () => ({
  createGenerator: vi.fn(() => mockGen),
}))

import { handleRssCron, parseRssFeed } from "../triggers/rss"

const mockFetch = vi.hoisted(() => vi.fn())
vi.stubGlobal("fetch", mockFetch)

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>Test Newsletter</title>
  <item>
    <title><![CDATA[First Post]]></title>
    <link>https://test.substack.com/p/first</link>
    <guid>first-guid</guid>
    <pubDate>Mon, 10 Jul 2026 09:00:00 GMT</pubDate>
    <description>A plain description</description>
  </item>
  <item>
    <title><![CDATA[Second Post with Content]]></title>
    <link>https://test.substack.com/p/second</link>
    <guid>second-guid</guid>
    <pubDate>Tue, 11 Jul 2026 09:00:00 GMT</pubDate>
    <content:encoded><![CDATA[<p>Detailed article content here</p>]]></content:encoded>
  </item>
</channel>
</rss>`

const EMPTY_IDEAS = ""
const LINK_KNOWN = `---
id: 1
title: First Post
status: raw
source: substack
created: 2026-07-01T12:00:00Z
substackUrl: https://test.substack.com/p/first
---

Already known`

const SINGLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <item>
    <title>First Post</title>
    <link>https://test.substack.com/p/first</link>
    <guid>first-guid</guid>
    <pubDate>Mon, 10 Jul 2026 09:00:00 GMT</pubDate>
    <description>Known item</description>
  </item>
</channel>
</rss>`

const LLM_JSON = JSON.stringify({
  teaser: "A great hook about testing",
  subIdeas: ["Idea 1", "Idea 2", "Idea 3"],
})

describe("parseRssFeed", () => {
  it("extracts items from RSS XML", () => {
    const items = parseRssFeed(SAMPLE_RSS)
    expect(items).toHaveLength(2)
  })

  it("parses item fields correctly", () => {
    const [first] = parseRssFeed(SAMPLE_RSS)
    expect(first.title).toBe("First Post")
    expect(first.link).toBe("https://test.substack.com/p/first")
    expect(first.guid).toBe("first-guid")
    expect(first.pubDate).toContain("2026")
  })

  it("prefers content:encoded over description", () => {
    const items = parseRssFeed(SAMPLE_RSS)
    expect(items[1].contentHtml).toBe("<p>Detailed article content here</p>")
  })

  it("falls back to description when content:encoded is missing", () => {
    const items = parseRssFeed(SAMPLE_RSS)
    expect(items[0].contentHtml).toBe("A plain description")
  })

  it("returns empty array for feed with no items", () => {
    const empty = parseRssFeed("<rss><channel><title>Empty</title></channel></rss>")
    expect(empty).toHaveLength(0)
  })
})

describe("handleRssCron", () => {
  function mockEnv() {
    return {
      GITHUB_PAT: "pat",
      DATA_REPO_OWNER: "o",
      DATA_REPO_NAME: "r",
      SUBSTACK_RSS_URL: "https://test.substack.com/feed",
      LLM_API_KEY: "key",
      LLM_PROVIDER: "gemini",
      POSTING_CADENCE_DAYS: "7",
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_WEBHOOK_SECRET: "",
      TELEGRAM_ALLOWED_USER_ID: "",
      LINKEDIN_CLIENT_ID: "",
      LINKEDIN_CLIENT_SECRET: "",
      LINKEDIN_ACCESS_TOKEN: "",
      LINKEDIN_REFRESH_TOKEN: "",
      LINKEDIN_AUTHOR_URN: "",
      PIPELINE_WORKFLOW: { create: vi.fn().mockResolvedValue({ id: "wf-1" }) },
    }
  }

  beforeEach(() => {
    mockFetch.mockReset()
    mockGen.mockReset()
  })

  it("starts workflow for a new RSS item", async () => {
    let callIdx = 0
    mockFetch.mockImplementation(async (_url: string, opts?: RequestInit) => {
      callIdx++
      if (callIdx === 1) return { ok: true, text: () => Promise.resolve(SAMPLE_RSS) }
      if (opts?.method === "PUT") return { ok: true, json: () => Promise.resolve({}) }
      return { ok: true, json: () => Promise.resolve({ content: b64(EMPTY_IDEAS), sha: "s1" }) }
    })
    mockGen.mockResolvedValue({ text: LLM_JSON, usage: { inputTokens: 10, outputTokens: 5 } })

    const env = mockEnv()
    const result = await handleRssCron(env as never)
    expect(result.started).toBe(true)
    expect(result.ideaId).toBeDefined()
    expect(env.PIPELINE_WORKFLOW.create).toHaveBeenCalledTimes(1)
  })

  it("does not re-add already-known items", async () => {
    let callIdx = 0
    mockFetch.mockImplementation(async (_url: string) => {
      callIdx++
      if (callIdx === 1) return { ok: true, text: () => Promise.resolve(SINGLE_RSS) }
      return { ok: true, json: () => Promise.resolve({ content: b64(LINK_KNOWN), sha: "s1" }) }
    })

    const env = mockEnv()
    const result = await handleRssCron(env as never)
    expect(result.started).toBe(false)
    expect(mockGen).not.toHaveBeenCalled()
  })

  it("returns started:false when RSS feed is empty", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("<rss><channel><title>Empty</title></channel></rss>"),
    })
    const result = await handleRssCron(mockEnv() as never)
    expect(result.started).toBe(false)
  })

  it("throws on RSS fetch error", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve("fail") })
    await expect(handleRssCron(mockEnv() as never)).rejects.toThrow("RSS fetch error 500")
  })
})
