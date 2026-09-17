import { beforeEach, describe, expect, it, vi } from "vitest"

const mockProvider = vi.hoisted(() => ({ generate: vi.fn() }))
vi.mock("../providers/index", () => ({ createToolProvider: vi.fn(() => mockProvider) }))

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
    <description><![CDATA[A plain subtitle]]></description>
    <content:encoded><![CDATA[<p>Introduction.</p><h2>First idea</h2><p>Detailed article content here.</p>]]></content:encoded>
  </item>
  <item>
    <title><![CDATA[Second Post with Content]]></title>
    <link>https://test.substack.com/p/second</link>
    <guid>second-guid</guid>
    <pubDate>Tue, 11 Jul 2026 09:00:00 GMT</pubDate>
    <description>Second subtitle</description>
    <content:encoded><![CDATA[<p>Second article content.</p>]]></content:encoded>
  </item>
</channel>
</rss>`

const NO_GUID_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <item><title>GUIDless One</title><link>https://test.substack.com/p/one</link><pubDate>Mon, 10 Jul 2026 09:00:00 GMT</pubDate><description>First subtitle</description><content:encoded><![CDATA[<p>First body.</p>]]></content:encoded></item>
  <item><title>GUIDless Two</title><link>https://test.substack.com/p/two</link><pubDate>Tue, 11 Jul 2026 09:00:00 GMT</pubDate><description>Second subtitle</description><content:encoded><![CDATA[<p>Second body.</p>]]></content:encoded></item>
</channel>
</rss>`

const SUBMITTED_IDEAS = [
  {
    title: "First working title",
    context: "Context.",
    excerpt: "First excerpt.",
    coreArgument: "First argument.",
    viralityScore: 8,
    scoreJustification: "A concise, source-grounded tension relevant to engineering leaders.",
  },
  {
    title: "Second working title",
    excerpt: "Second excerpt.",
    coreArgument: "Second argument.",
    viralityScore: 6,
    scoreJustification: "A useful source-grounded observation with a clear professional takeaway.",
  },
]

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
  const { stub, ingestFetches } = createFakeIdeaIngestStub({ pageId: "page_1", ideaId: "1" })
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

function submitIdeas(ideas = SUBMITTED_IDEAS) {
  return {
    toolCalls: [{ id: "ideas", name: "submit_substack_ideas", input: { ideas } }],
    usage: { inputTokens: 10, outputTokens: 5 },
  }
}

describe("parseRssFeed", () => {
  it("keeps description as subtitle and only takes article HTML from content:encoded", () => {
    const [first] = parseRssFeed(SAMPLE_RSS)
    expect(first).toMatchObject({
      title: "First Post",
      subtitle: "A plain subtitle",
      link: "https://test.substack.com/p/first",
      guid: "first-guid",
      contentHtml: "<p>Introduction.</p><h2>First idea</h2><p>Detailed article content here.</p>",
    })
  })

  it("does not substitute description for a missing content:encoded body", () => {
    const [item] = parseRssFeed(
      `<rss><channel><item><title>Post</title><link>https://example.com/p/post</link><description>Subtitle only</description></item></channel></rss>`,
    )
    expect(item).toMatchObject({ subtitle: "Subtitle only", contentHtml: "" })
  })

  it("returns no items for a feed without item elements", () => {
    expect(parseRssFeed("<rss><channel><title>Empty</title></channel></rss>")).toHaveLength(0)
  })
})

describe("handleRssCron", () => {
  function setupFetch(options: { rssXml: string; knownLinks: string[] }) {
    const telegramBodies: unknown[] = []
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
      if (url.startsWith("https://api.telegram.org/")) {
        telegramBodies.push(JSON.parse(init?.body as string))
        return { ok: true, json: () => Promise.resolve({ result: { message_id: 1 } }) }
      }
      throw new Error(`Unexpected fetch ${url}`)
    })
    return telegramBodies
  }

  beforeEach(() => {
    mockFetch.mockReset()
    mockProvider.generate.mockReset()
  })

  it("supplies parsed source directly to the agent and saves raw ideas without starting workflows", async () => {
    setupFetch({ rssXml: SAMPLE_RSS, knownLinks: [] })
    mockProvider.generate.mockResolvedValue(submitIdeas())
    const env = mockEnv()

    const result = await handleRssCron(env as never)

    expect(result).toEqual({ started: true, ideaId: "1" })
    expect(mockProvider.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [expect.objectContaining({ name: "submit_substack_ideas" })],
        messages: expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining('"subtitle":"A plain subtitle"') }),
          expect.objectContaining({ text: expect.stringContaining("Detailed article content here.") }),
        ]),
      }),
    )

    const first = env.ingestFetches.get("ingest:rss:guid:first-guid:0")
    const second = env.ingestFetches.get("ingest:rss:guid:first-guid:1")
    if (!first || !second) throw new Error("expected raw Substack ingests")
    expect(JSON.parse(first.mock.calls[0][1].body)).toMatchObject({
      key: "rss:guid:first-guid:0",
      startWorkflow: false,
      idea: { source: "substack", title: "First working title", body: "Context.\n\nFirst excerpt.\n\nFirst argument." },
    })
    expect(JSON.parse(second.mock.calls[0][1].body)).toMatchObject({
      key: "rss:guid:first-guid:1",
      startWorkflow: false,
      idea: { source: "substack", title: "Second working title", body: "Second excerpt.\n\nSecond argument." },
    })
  })

  it("does not invoke the agent or ingest an article already represented in Notion", async () => {
    setupFetch({
      rssXml: SAMPLE_RSS,
      knownLinks: ["https://test.substack.com/p/first", "https://test.substack.com/p/second"],
    })
    const env = mockEnv()
    await expect(handleRssCron(env as never)).resolves.toEqual({ started: false })
    expect(mockProvider.generate).not.toHaveBeenCalled()
    expect(env.ingestFetches.size).toBe(0)
  })

  it("notifies the operator with the article title, count, and working titles after saving", async () => {
    const telegramBodies = setupFetch({ rssXml: SAMPLE_RSS, knownLinks: [] })
    mockProvider.generate.mockResolvedValue(submitIdeas())
    const env = mockEnv()
    env.TELEGRAM_BOT_TOKEN = "bot-token"
    env.TELEGRAM_ALLOWED_USER_ID = "123"

    await handleRssCron(env as never)

    expect(telegramBodies).toEqual([
      expect.objectContaining({
        chat_id: "123",
        text: expect.stringContaining("Added 2 raw Substack ideas from First Post"),
      }),
    ])
    expect((telegramBodies[0] as { text: string }).text).toContain("First working title")
    expect((telegramBodies[0] as { text: string }).text).toContain("Second working title")
  })

  it("saves only the highest-scoring qualifying candidates and exposes no scores in raw bodies", async () => {
    setupFetch({ rssXml: SAMPLE_RSS, knownLinks: [] })
    const scoredTitles: Array<[string, number]> = [
      ["Below floor", 4],
      ["Six", 6],
      ["Ten", 10],
      ["Seven", 7],
      ["Eight", 8],
      ["Nine", 9],
      ["Five", 5],
    ]
    const candidates = scoredTitles.map(([title, viralityScore]) => ({
      title,
      excerpt: `${title} excerpt.`,
      coreArgument: `${title} argument.`,
      viralityScore,
      scoreJustification: `${title} has a distinct and source-grounded professional tension.`,
    }))
    mockProvider.generate.mockResolvedValue(submitIdeas(candidates))
    const env = mockEnv()

    await handleRssCron(env as never)

    expect(env.ingestFetches.get("ingest:rss:guid:first-guid:0")).toBeDefined()
    expect(env.ingestFetches.get("ingest:rss:guid:first-guid:4")).toBeDefined()
    expect(env.ingestFetches.get("ingest:rss:guid:first-guid:5")).toBeUndefined()
    const first = env.ingestFetches.get("ingest:rss:guid:first-guid:0")
    if (!first) throw new Error("expected the highest-scoring raw Substack ingest")
    expect(JSON.parse(first.mock.calls[0][1].body).idea).toMatchObject({ title: "Ten" })
    expect(JSON.parse(first.mock.calls[0][1].body).idea.body).not.toContain("viralityScore")
  })

  it("uses GUID-derived keys when a GUID is present and link-derived keys when it is not", () => {
    expect(itemIdentity({ guid: "first-guid", link: "https://test.substack.com/p/first" })).toBe("guid:first-guid")
    expect(itemIdentity({ guid: "", link: "https://test.substack.com/p/one" })).toBe(
      "link:https://test.substack.com/p/one",
    )
  })

  it("uses a link-derived idempotency key for a GUID-less RSS item", async () => {
    setupFetch({ rssXml: NO_GUID_RSS, knownLinks: [] })
    mockProvider.generate.mockResolvedValue(submitIdeas([SUBMITTED_IDEAS[0]]))
    const env = mockEnv()
    await handleRssCron(env as never)
    expect(env.ingestFetches.get("ingest:rss:link:https://test.substack.com/p/one:0")).toBeDefined()
  })

  it("fails before writing when content:encoded is absent", async () => {
    setupFetch({
      rssXml: `<rss><channel><item><title>Post</title><link>https://example.com/p/post</link><description>Subtitle</description></item></channel></rss>`,
      knownLinks: [],
    })
    const env = mockEnv()
    await expect(handleRssCron(env as never)).rejects.toThrow("missing-content")
    expect(mockProvider.generate).not.toHaveBeenCalled()
    expect(env.ingestFetches.size).toBe(0)
  })

  it("returns started:false when the RSS feed is empty", async () => {
    setupFetch({ rssXml: "<rss><channel><title>Empty</title></channel></rss>", knownLinks: [] })
    await expect(handleRssCron(mockEnv() as never)).resolves.toEqual({ started: false })
  })

  it("throws on a non-transient RSS fetch error", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403, text: () => Promise.resolve("fail") })
    await expect(handleRssCron(mockEnv() as never)).rejects.toThrow("RSS fetch error 403")
  })
})
