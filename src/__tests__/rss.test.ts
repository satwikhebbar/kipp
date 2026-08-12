import { beforeEach, describe, expect, it, vi } from "vitest"

const mockGen = vi.hoisted(() => vi.fn())
vi.mock("../providers/index", async () => ({
  createGenerator: vi.fn(() => mockGen),
  messages: (await vi.importActual("../providers/llm")).messages,
  parseLLMJson: (await vi.importActual("../providers/llm")).parseLLMJson,
}))

import { handleRssCron, itemIdentity, parseRssFeed } from "../triggers/rss"
import { createFakeIdeaIngestStub } from "./helpers/idea-ingest-stub"

const mockFetch = vi.hoisted(() => vi.fn())
vi.stubGlobal("fetch", mockFetch)

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

const NO_GUID_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <item>
    <title>GUIDless One</title>
    <link>https://test.substack.com/p/one</link>
    <pubDate>Mon, 10 Jul 2026 09:00:00 GMT</pubDate>
    <description>First item without a GUID</description>
  </item>
  <item>
    <title>GUIDless Two</title>
    <link>https://test.substack.com/p/two</link>
    <pubDate>Tue, 11 Jul 2026 09:00:00 GMT</pubDate>
    <description>Second item without a GUID</description>
  </item>
</channel>
</rss>`

const LLM_JSON = JSON.stringify({
  teaser: "A great hook about testing",
  subIdeas: ["Idea 1", "Idea 2", "Idea 3"],
})

function notionQueryResponse(results: unknown[] = []) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ object: "list", results, has_more: false, next_cursor: null }),
    text: () => Promise.resolve(""),
    headers: new Map(),
  }
}

function knownSubstackResult(link: string) {
  return {
    object: "page",
    id: "page_1",
    created_time: "2026-07-01T12:00:00Z",
    properties: {
      "Kipp ID": { type: "unique_id", unique_id: { prefix: null, number: 1 } },
      Status: { type: "status", status: { name: "raw" } },
      Source: { type: "select", select: { name: "substack" } },
      "Substack URL": { type: "url", url: link },
    },
  }
}

function mockEnv() {
  const { stub, ingestFetches } = createFakeIdeaIngestStub({
    pageId: "page_1",
    ideaId: "1",
    workflowInstanceId: "wf-1",
  })
  return {
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
    LINKEDIN_AUTHOR_URN: "",
    NOTION_API_KEY: "secret",
    NOTION_IDEAS_DATA_SOURCE_ID: "ds-1",
    NOTION_FREE_TIER: "false",
    IDEA_INGEST: stub,
    ingestFetches,
    PIPELINE_WORKFLOW: { create: vi.fn().mockResolvedValue({ id: "wf-1" }) },
  }
}

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
  function setupFetch(options: { rssXml: string; knownLinks: string[] }) {
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "https://test.substack.com/feed") return { ok: true, text: () => Promise.resolve(options.rssXml) }
      if (url.includes("api.notion.com")) {
        const filter = JSON.parse((init?.body as string) ?? "{}").filter
        const equals = filter?.url?.equals
        const results = equals
          ? options.knownLinks.filter((link) => link === equals).map((link) => knownSubstackResult(link))
          : options.knownLinks.map((link) => knownSubstackResult(link))
        return notionQueryResponse(results)
      }
      throw new Error(`Unexpected fetch ${url}`)
    })
  }

  beforeEach(() => {
    mockFetch.mockReset()
    mockGen.mockReset()
  })

  it("ingests main idea with startWorkflow and side ideas without a workflow", async () => {
    setupFetch({ rssXml: SAMPLE_RSS, knownLinks: [] })
    mockGen.mockResolvedValue({ text: LLM_JSON, usage: { inputTokens: 10, outputTokens: 5 } })

    const env = mockEnv()
    const result = await handleRssCron(env as never)
    expect(result.started).toBe(true)

    const mainStub = env.ingestFetches.get("ingest:rss:guid:first-guid:0")!
    expect(mainStub).toBeDefined()
    expect(mainStub).toHaveBeenCalledTimes(1)
    const [, init] = mainStub.mock.calls[0]
    const body = JSON.parse(init.body)
    expect(body.key).toBe("rss:guid:first-guid:0")
    expect(body.startWorkflow).toBe(true)
    expect(body.idea.body).toBe("A great hook about testing")
    expect(body.idea.substackBody).toBe("A plain description")

    const sideStub = env.ingestFetches.get("ingest:rss:guid:first-guid:1")!
    expect(sideStub).toBeDefined()
    expect(sideStub).toHaveBeenCalledTimes(1)
    const sideBody = JSON.parse(sideStub.mock.calls[0][1].body)
    expect(sideBody.startWorkflow).toBe(false)
    expect(sideBody.idea.substackBody).toBe("A plain description")
  })

  it("ingests side ideas with sequential rss:{guid}:{i} keys", async () => {
    setupFetch({ rssXml: SAMPLE_RSS, knownLinks: [] })
    mockGen.mockResolvedValue({ text: LLM_JSON, usage: { inputTokens: 10, outputTokens: 5 } })

    const env = mockEnv()
    await handleRssCron(env as never)

    for (let i = 0; i <= 3; i++) {
      expect(env.ingestFetches.get(`ingest:rss:guid:first-guid:${i}`)).toBeDefined()
    }
  })

  it("does not re-add items whose substackUrl already exists in Notion", async () => {
    setupFetch({ rssXml: SINGLE_RSS, knownLinks: ["https://test.substack.com/p/first"] })
    const env = mockEnv()
    const result = await handleRssCron(env as never)
    expect(result.started).toBe(false)
    expect(mockGen).not.toHaveBeenCalled()
    expect(env.ingestFetches.size).toBe(0)
  })

  it("uses GUID-derived keys when a GUID is present and link-derived keys when it is not", () => {
    expect(itemIdentity({ guid: "first-guid", link: "https://test.substack.com/p/first" })).toBe("guid:first-guid")
    expect(itemIdentity({ guid: "", link: "https://test.substack.com/p/one" })).toBe(
      "link:https://test.substack.com/p/one",
    )
  })

  it("ingests GUID-less items independently and stays idempotent on repeat", async () => {
    setupFetch({ rssXml: NO_GUID_RSS, knownLinks: [] })
    mockGen.mockResolvedValue({ text: LLM_JSON, usage: { inputTokens: 10, outputTokens: 5 } })
    const env = mockEnv()

    await handleRssCron(env as never)
    const firstKey = "ingest:rss:link:https://test.substack.com/p/one:0"
    const firstStub = env.ingestFetches.get(firstKey)!
    expect(firstStub).toBeDefined()
    expect(JSON.parse(firstStub.mock.calls[0][1].body).key).toBe("rss:link:https://test.substack.com/p/one:0")

    setupFetch({ rssXml: NO_GUID_RSS, knownLinks: ["https://test.substack.com/p/one"] })
    await handleRssCron(env as never)
    const secondKey = "ingest:rss:link:https://test.substack.com/p/two:0"
    const secondStub = env.ingestFetches.get(secondKey)!
    expect(secondStub).toBeDefined()
    expect(secondKey).not.toBe(firstKey)
    expect(JSON.parse(secondStub.mock.calls[0][1].body).key).toBe("rss:link:https://test.substack.com/p/two:0")

    setupFetch({
      rssXml: NO_GUID_RSS,
      knownLinks: ["https://test.substack.com/p/one", "https://test.substack.com/p/two"],
    })
    const repeat = await handleRssCron(env as never)
    expect(repeat.started).toBe(false)
    expect(env.ingestFetches.get(firstKey)).toHaveBeenCalledTimes(1)
    expect(env.ingestFetches.get(secondKey)).toHaveBeenCalledTimes(1)
  })

  it("bounds the persisted Substack Body reference to the 2000-char Notion limit", async () => {
    const longContent = `<p>${"x".repeat(2500)}</p>`
    const longRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <item>
    <title>Long Post</title>
    <link>https://test.substack.com/p/long</link>
    <guid>long-guid</guid>
    <pubDate>Mon, 10 Jul 2026 09:00:00 GMT</pubDate>
    <content:encoded><![CDATA[${longContent}]]></content:encoded>
  </item>
</channel>
</rss>`
    setupFetch({ rssXml: longRss, knownLinks: [] })
    mockGen.mockResolvedValue({ text: LLM_JSON, usage: { inputTokens: 10, outputTokens: 5 } })

    const env = mockEnv()
    await handleRssCron(env as never)

    const mainStub = env.ingestFetches.get("ingest:rss:guid:long-guid:0")!
    const body = JSON.parse(mainStub.mock.calls[0][1].body)
    expect(body.idea.substackBody).toHaveLength(2000)
    expect(body.idea.substackBody).toBe("x".repeat(2000))
  })

  it("returns started:false when RSS feed is empty", async () => {
    setupFetch({ rssXml: "<rss><channel><title>Empty</title></channel></rss>", knownLinks: [] })
    const result = await handleRssCron(mockEnv() as never)
    expect(result.started).toBe(false)
  })

  it("throws on non-transient RSS fetch error", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403, text: () => Promise.resolve("fail") })
    await expect(handleRssCron(mockEnv() as never)).rejects.toThrow("RSS fetch error 403")
  })
})
