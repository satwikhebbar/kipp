import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createNotionClient,
  NOTION_RATE_LIMIT_DELAY_MS,
  NotionError,
  pageToIdea,
  pageToSummary,
} from "../integrations/notion"

const ENV = { NOTION_API_KEY: "secret", NOTION_IDEAS_DATA_SOURCE_ID: "ds-1" }

function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
}

function status(body: unknown, code: number, retryAfter?: string) {
  return new Response(JSON.stringify(body), {
    status: code,
    headers: {
      "Content-Type": "application/json",
      ...(retryAfter ? { "Retry-After": retryAfter } : {}),
    },
  })
}

const mockFetch = vi.hoisted(() => vi.fn())
vi.stubGlobal("fetch", mockFetch)

const CREATE_REQUEST = {
  parent: { type: "data_source_id", data_source_id: "ds-1" },
  properties: {
    Title: { title: [{ type: "text", text: { content: "Idea title" } }] },
    Status: { status: { name: "raw" } },
    Source: { select: { name: "substack" } },
    "Substack URL": { url: "https://example.com/post" },
    "Chat ID": { rich_text: [{ type: "text", text: { content: "12345" } }] },
    "Idempotency Key": { rich_text: [{ type: "text", text: { content: "rss:g:0" } }] },
  },
  markdown: "# Idea title\n\nbody…",
}

const CREATE_RESPONSE = {
  object: "page",
  id: "page_abc",
  created_time: "2026-08-01T00:00:00.000Z",
  parent: { type: "data_source_id", data_source_id: "ds-1" },
  properties: {
    "Kipp ID": { id: "k1", type: "unique_id", unique_id: { prefix: null, number: 42 } },
    Status: { id: "s1", type: "status", status: { name: "raw" } },
    Source: { id: "o1", type: "select", select: { name: "substack" } },
    Title: { id: "t1", type: "title", title: [{ type: "text", text: { content: "Idea title" } }] },
    "Substack URL": { id: "u1", type: "url", url: "https://example.com/post" },
    "Chat ID": { id: "c1", type: "rich_text", rich_text: [{ type: "text", text: { content: "12345" } }] },
    "Idempotency Key": { id: "k2", type: "rich_text", rich_text: [{ type: "text", text: { content: "rss:g:0" } }] },
  },
}

const QUERY_RESPONSE = {
  object: "list",
  results: [
    {
      object: "page",
      id: "page_abc",
      created_time: "2026-08-01T00:00:00.000Z",
      properties: {
        "Kipp ID": { type: "unique_id", unique_id: { prefix: null, number: 42 } },
        Status: { type: "status", status: { name: "raw" } },
        Source: { type: "select", select: { name: "substack" } },
        Title: { type: "title", title: [{ type: "text", text: { content: "Idea title" } }] },
        "Substack URL": { type: "url", url: "https://example.com/post" },
        "Chat ID": { type: "rich_text", rich_text: [{ type: "text", text: { content: "12345" } }] },
      },
    },
  ],
  has_more: false,
  next_cursor: null,
  type: "page_or_data_source",
  page_or_data_source: {},
}

const MARKDOWN_RESPONSE = {
  object: "page_markdown",
  id: "page_abc",
  markdown: "# Idea title\n\nbody…",
  truncated: false,
  unknown_block_ids: [],
}

afterEach(() => {
  mockFetch.mockReset()
})

describe("createNotionClient", () => {
  it("creates a page with the pinned §3.3 request and parses the Kipp ID", async () => {
    mockFetch.mockResolvedValue(ok(CREATE_RESPONSE))
    const client = createNotionClient(ENV)
    const page = await client.createPage(
      {
        title: "Idea title",
        status: "raw",
        source: "substack",
        substackUrl: "https://example.com/post",
        chatId: "12345",
        idempotencyKey: "rss:g:0",
      },
      "# Idea title\n\nbody…",
    )
    expect(page.id).toBe("page_abc")
    expect(page.properties["Kipp ID"]?.unique_id?.number).toBe(42)

    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe("https://api.notion.com/v1/pages")
    expect(JSON.parse((init as RequestInit).body as string)).toEqual(CREATE_REQUEST)
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer secret",
      "Notion-Version": "2026-03-11",
    })
  })

  it("writes the Substack Body rich_text property per the §3.1 schema", async () => {
    mockFetch.mockResolvedValue(ok(CREATE_RESPONSE))
    const client = createNotionClient(ENV)
    await client.createPage(
      {
        title: "Idea title",
        status: "raw",
        source: "substack",
        substackUrl: "https://example.com/post",
        substackBody: "Reference text",
      },
      "# Idea title\n\nbody…",
    )
    const [_, init] = mockFetch.mock.calls[0]
    expect(JSON.parse((init as RequestInit).body as string).properties).toMatchObject({
      "Substack Body": { rich_text: [{ type: "text", text: { content: "Reference text" } }] },
    })
  })

  it("omits the Substack Body property when substackBody is absent", async () => {
    mockFetch.mockResolvedValue(ok(CREATE_RESPONSE))
    const client = createNotionClient(ENV)
    await client.createPage({ title: "Idea title", status: "raw", source: "telegram" }, "# Idea title\n\nbody…")
    const [_, init] = mockFetch.mock.calls[0]
    expect(JSON.parse((init as RequestInit).body as string).properties).not.toHaveProperty("Substack Body")
  })

  it("queries a data source and returns metadata pages", async () => {
    mockFetch.mockImplementation(() => ok(QUERY_RESPONSE))
    const client = createNotionClient(ENV)
    const pages = await client.queryPages({ property: "Status", status: { equals: "raw" } }, [
      { property: "Kipp ID", direction: "ascending" },
    ])
    expect(pages).toHaveLength(1)
    const summary = pageToSummary(pages[0])
    expect(summary).toMatchObject({
      pageId: "page_abc",
      id: "42",
      status: "raw",
      source: "substack",
      title: "Idea title",
      substackUrl: "https://example.com/post",
      correlation: { telegramChatId: "12345" },
    })

    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe("https://api.notion.com/v1/data_sources/ds-1/query")
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body).toMatchObject({
      filter: { property: "Status", status: { equals: "raw" } },
      sorts: [{ property: "Kipp ID", direction: "ascending" }],
      page_size: 100,
    })
  })

  it("paginates queries until has_more is false", async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ ...QUERY_RESPONSE, has_more: true, next_cursor: "c1" }))
      .mockResolvedValueOnce(ok({ ...QUERY_RESPONSE, has_more: false, next_cursor: null }))
    const client = createNotionClient({ ...ENV, NOTION_FREE_TIER: "false" })
    const pages = await client.queryPages(null, [])
    expect(pages).toHaveLength(2)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const [, init] = mockFetch.mock.calls[1]
    expect(JSON.parse((init as RequestInit).body as string).start_cursor).toBe("c1")
  })

  it("stops fetching once a result limit is reached", async () => {
    mockFetch.mockResolvedValueOnce(ok({ ...QUERY_RESPONSE, has_more: true, next_cursor: "c1" }))
    const client = createNotionClient({ ...ENV, NOTION_FREE_TIER: "false" })
    const pages = await client.queryPages(null, [], 1)
    expect(pages).toHaveLength(1)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("throws when the query page cap is reached while has_more remains true", async () => {
    mockFetch.mockImplementation(() => ok({ ...QUERY_RESPONSE, has_more: true, next_cursor: "c" }))
    const client = createNotionClient({ ...ENV, NOTION_FREE_TIER: "false" })
    await expect(client.queryPages(null, [])).rejects.toThrow(/exceeded 100 pages/)
    expect(mockFetch).toHaveBeenCalledTimes(100)
  })

  it("aborts with NotionError on an incomplete query", async () => {
    mockFetch.mockResolvedValue(
      ok({
        object: "list",
        results: [],
        has_more: false,
        next_cursor: null,
        request_status: { type: "incomplete", incomplete_reason: "query_result_limit_reached" },
      }),
    )
    const client = createNotionClient(ENV)
    await expect(client.queryPages(null, [])).rejects.toThrow(/query result limit reached/)
  })

  it("reads page markdown and returns it when complete", async () => {
    mockFetch.mockResolvedValue(ok(MARKDOWN_RESPONSE))
    const client = createNotionClient(ENV)
    const md = await client.getPageMarkdown("page_abc")
    expect(md).toBe("# Idea title\n\nbody…")
    expect(mockFetch.mock.calls[0][0]).toBe("https://api.notion.com/v1/pages/page_abc/markdown")
  })

  it("throws on truncated markdown", async () => {
    mockFetch.mockResolvedValue(ok({ ...MARKDOWN_RESPONSE, truncated: true }))
    const client = createNotionClient(ENV)
    await expect(client.getPageMarkdown("page_abc")).rejects.toThrow(NotionError)
  })

  it("throws on non-empty unknown_block_ids", async () => {
    mockFetch.mockResolvedValue(ok({ ...MARKDOWN_RESPONSE, unknown_block_ids: ["blk_1"] }))
    const client = createNotionClient(ENV)
    await expect(client.getPageMarkdown("page_abc")).rejects.toThrow(NotionError)
  })

  it("throws on 404 object_not_found for markdown", async () => {
    mockFetch.mockResolvedValue(status({ message: "object_not_found" }, 404))
    const client = createNotionClient(ENV)
    await expect(client.getPageMarkdown("page_missing")).rejects.toThrow(NotionError)
  })

  it("patches page markdown with a replace_content command", async () => {
    mockFetch.mockResolvedValue(ok(MARKDOWN_RESPONSE))
    const client = createNotionClient(ENV)
    await client.patchPageMarkdown("page_abc", "# Revised\n\nnew")
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe("https://api.notion.com/v1/pages/page_abc/markdown")
    expect((init as RequestInit).method).toBe("PATCH")
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      type: "replace_content",
      replace_content: { new_str: "# Revised\n\nnew", allow_deleting_content: false },
    })
  })

  it("patches page properties with a Status update", async () => {
    mockFetch.mockResolvedValue(ok(CREATE_RESPONSE))
    const client = createNotionClient(ENV)
    await client.patchPageProperties("page_abc", { status: "finalized" })
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe("https://api.notion.com/v1/pages/page_abc")
    expect((init as RequestInit).method).toBe("PATCH")
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      properties: { Status: { status: { name: "finalized" } } },
    })
  })

  it("retries on 429 honoring Retry-After", async () => {
    vi.useFakeTimers()
    try {
      mockFetch
        .mockResolvedValueOnce(status({ message: "rate limited" }, 429, "1"))
        .mockResolvedValueOnce(ok(QUERY_RESPONSE))
      const client = createNotionClient({ ...ENV, NOTION_FREE_TIER: "false" })
      const pending = client.queryPages(null, [])
      await vi.advanceTimersByTimeAsync(1_100)
      await pending
      expect(mockFetch).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("retries on 5xx then succeeds", async () => {
    vi.useFakeTimers()
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0)
    try {
      mockFetch.mockResolvedValueOnce(status({ message: "boom" }, 503)).mockResolvedValueOnce(ok(QUERY_RESPONSE))
      const client = createNotionClient({ ...ENV, NOTION_FREE_TIER: "false" })
      const pending = client.queryPages(null, [])
      await vi.advanceTimersByTimeAsync(600)
      await pending
      expect(mockFetch).toHaveBeenCalledTimes(2)
    } finally {
      randomSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it("stops after MAX_RETRIES on repeated 429s and rejects with NotionError", async () => {
    vi.useFakeTimers()
    try {
      mockFetch.mockResolvedValue(status({ message: "rate limited" }, 429, "1"))
      const client = createNotionClient({ ...ENV, NOTION_FREE_TIER: "false" })
      const pending = client.queryPages(null, [])
      const assertion = expect(pending).rejects.toThrow(NotionError)
      await vi.advanceTimersByTimeAsync(10_000)
      await assertion
      expect(mockFetch).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it("stops after MAX_RETRIES on repeated 5xx and rejects with NotionError", async () => {
    vi.useFakeTimers()
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0)
    try {
      mockFetch.mockResolvedValue(status({ message: "boom" }, 503))
      const client = createNotionClient({ ...ENV, NOTION_FREE_TIER: "false" })
      const pending = client.queryPages(null, [])
      const assertion = expect(pending).rejects.toThrow(NotionError)
      await vi.advanceTimersByTimeAsync(30_000)
      await assertion
      expect(mockFetch).toHaveBeenCalledTimes(4)
    } finally {
      randomSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it.each([400, 401, 403, 404, 409])("throws immediately on %s", async (code) => {
    mockFetch.mockResolvedValue(status({ message: "nope" }, code))
    const client = createNotionClient({ ...ENV, NOTION_FREE_TIER: "false" })
    await expect(client.queryPages(null, [])).rejects.toThrow(NotionError)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("throttles requests when the free-tier rate limiter is enabled", async () => {
    vi.useFakeTimers()
    try {
      mockFetch.mockImplementation(() => ok(QUERY_RESPONSE))
      const client = createNotionClient(ENV)
      const first = client.queryPages(null, [])
      await vi.advanceTimersByTimeAsync(0)
      await first
      const second = client.queryPages(null, [])
      await vi.advanceTimersByTimeAsync(NOTION_RATE_LIMIT_DELAY_MS)
      await second
      expect(mockFetch).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not throttle when NOTION_FREE_TIER is false", async () => {
    mockFetch.mockImplementation(() => ok(QUERY_RESPONSE))
    const client = createNotionClient({ ...ENV, NOTION_FREE_TIER: "false" })
    await Promise.all([client.queryPages(null, []), client.queryPages(null, [])])
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it("maps a page plus markdown body to the hydrated Idea", async () => {
    const idea = pageToIdea(CREATE_RESPONSE as never, "# Idea title\n\nbody…")
    expect(idea).toMatchObject({
      pageId: "page_abc",
      id: "42",
      title: "Idea title",
      status: "raw",
      source: "substack",
      substackUrl: "https://example.com/post",
      correlation: { telegramChatId: "12345" },
      idempotencyKey: "rss:g:0",
      body: "# Idea title\n\nbody…",
    })
  })
})
